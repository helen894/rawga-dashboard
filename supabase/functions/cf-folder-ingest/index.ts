// ============================================================================
// Supabase Edge Function: cf-folder-ingest
// ----------------------------------------------------------------------------
// 짝이 되는 Apps Script(cf-folder-ingest.gs)가 드라이브 업로드 폴더의 엑셀/CSV를
// 파싱해 { secret, action:'push', rows:[{date,desc,in,out,status,(mid),(clobe_id)}] } 형태로 POST.
// 이 함수는 그 rows 를 기존 cf_data 배열 "뒤에 append" 한다. (덮어쓰기 없음)
//   · 중복 skip: clobe_id(고유키) 있으면 그걸로, 없으면 (거래일+거래내용+금액+상태)
//   · 중분류(mid_cat): mid 있으면 그 값(클로브 계정라벨), 없으면 빈칸 → 대시보드 "✨ 자동분류 추천"
//   · 상태 미입력 시 대시보드 parseCFRows와 동일 규칙으로 자동 판정
//   · mid/clobe_id 없는 기존 은행 xlsx는 종전과 100% 동일 동작(하위호환)
//
// 환경변수(Edge Functions > Secrets):
//   CF_SYNC_SECRET            : Apps Script의 스크립트 속성 CF_SYNC_SECRET 과 동일 값
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY : 자동 주입 (RLS 우회하여 cf_data 쓰기)
//
// ⚠ 함수 Settings에서 "Verify JWT" = OFF 여야 함 (Apps Script는 Supabase JWT 없이 호출).
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CF_SYNC_SECRET = Deno.env.get("CF_SYNC_SECRET") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// 오늘(Asia/Seoul, UTC+9) — 상태 자동판정 기준
function todaySeoul(): string {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}
function genId(): string {
  return "cf_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
}
// 대시보드 parseCFRows와 동일한 상태 기본값 규칙
function defaultStatus(status: string, type: string, date: string, today: string): string {
  const s = (status || "").trim();
  if (s) return s;
  if (date <= today) return type === "입금" ? "실제 입금" : "실제 지출";
  return type === "입금" ? "입금 예정" : "지출 예정";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: "invalid json" }, 400); }

  // 인증: Apps Script와 공유하는 비밀
  if (!CF_SYNC_SECRET || body?.secret !== CF_SYNC_SECRET) {
    return json({ ok: false, error: "unauthorized (secret 불일치)" }, 401);
  }
  if (body?.action !== "push") {
    return json({ ok: false, error: "unknown action" }, 400);
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];

  try {
    // 1) 현재 cf_data 읽기
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/cf_data?select=id,data&limit=1`,
      { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
    );
    if (!getRes.ok) throw new Error(`cf_data 읽기 실패: ${getRes.status}`);
    const arr = await getRes.json();
    if (!arr?.[0]) throw new Error("cf_data 행이 없습니다.");
    const rowId = arr[0].id;
    const cfData: any[] = Array.isArray(arr[0].data)
      ? arr[0].data
      : (typeof arr[0].data === "string" ? JSON.parse(arr[0].data) : []);

    const today = todaySeoul();
    let added = 0, skipped = 0;

    for (const r of rows) {
      const date = String(r?.date || "").slice(0, 10);
      const inA = Number(r?.in || 0);
      const outA = Number(r?.out || 0);
      if (!date || (inA === 0 && outA === 0)) { skipped++; continue; }

      const type = inA > 0 ? "입금" : "지출";
      const amount = inA - outA;
      const desc = String(r?.desc ?? "").trim() || "(거래내용 없음)";
      const status = defaultStatus(String(r?.status ?? ""), type, date, today);
      // (선택) 클로브 연동 필드 — 없으면 기존과 동일 동작(하위호환)
      const clobeId = (r?.clobe_id !== undefined && r?.clobe_id !== null && String(r.clobe_id).trim())
        ? String(r.clobe_id).trim() : "";
      const mid = String(r?.mid ?? "").trim();

      // 중복 판정: clobe_id(고유) 있으면 그걸로, 없으면 기존 (거래일+거래내용+상태+금액)
      const dup = clobeId
        ? cfData.some((d) => String(d.clobe_id ?? "") === clobeId)
        : cfData.some((d) => {
            if (d.date !== date || d.desc !== desc || d.status !== status) return false;
            const dAmt = (d.amount !== undefined && d.amount !== null)
              ? d.amount : ((d.in || 0) - (d.out || 0));
            return Math.abs(dAmt - amount) < 1;
          });
      if (dup) { skipped++; continue; }

      const rec: any = {
        _id: genId(),
        date, desc, in: inA, out: outA, amount, type, status,
        mid_cat: mid, // 클로브 계정라벨(있으면). 없으면 "" → 자동분류 추천 대상
        big_cat: "",
      };
      if (clobeId) rec.clobe_id = clobeId; // 재적재 중복 차단용 고유키
      cfData.push(rec);
      added++;
    }

    cfData.sort((a, b) => String(a.date).localeCompare(String(b.date)));

    // 2) cf_data 쓰기 (append된 전체 배열로 갱신 — data 외 컬럼 불변)
    const patch = await fetch(`${SUPABASE_URL}/rest/v1/cf_data?id=eq.${rowId}`, {
      method: "PATCH",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ data: cfData, updated_at: new Date().toISOString() }),
    });
    if (!patch.ok) throw new Error(`cf_data 저장 실패: ${patch.status} ${await patch.text()}`);

    return json({ ok: true, added, skipped, total: cfData.length });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});

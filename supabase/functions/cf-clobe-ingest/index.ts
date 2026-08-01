/**
 * cf-clobe-ingest — Supabase Edge Function
 *
 * 클로브 커넥터에서 가져온 은행 거래내역을 cf_data 에 추가한다.
 * 로직은 cf-folder-ingest(드라이브 경로)와 동일하되, 인증 시크릿만 BANK_SYNC_SECRET 을 쓴다.
 *   · 중복 skip: clobe_id(=클로브 transactionId) 우선, 없으면 (거래일+거래내용+금액+상태)
 *   · mid(클로브 계정라벨) 있으면 mid_cat 으로 반영
 * 호출 주체: 로컬 스케줄 태스크가 scripts/clobe-cf-ingest.mjs 로 검증 후 POST
 */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CF_SYNC_SECRET = Deno.env.get("BANK_SYNC_SECRET") ?? Deno.env.get("CF_SYNC_SECRET") ?? "";

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
    const today = todaySeoul();
    const MAX_TRIES = 4;
    let added = 0, skipped = 0, total = 0;

    /* 낙관적 잠금 — cf_data 는 배열 전체가 한 행이라 마지막에 쓴 쪽이 이긴다.
     * 읽은 version 일 때만 쓰고, 0행 갱신(=그새 대시보드 등이 씀)이면 덮어쓰지 않고
     * 다시 읽어 재시도한다. append 만 하므로 재시도가 안전하다 — clobe_id 중복 판정이
     * 다시 걸려 이중 추가되지 않는다. version 은 DB 트리거가 UPDATE 마다 +1 한다.
     * version 컬럼이 없으면(마이그레이션 전) 조건 없이 써서 종전 동작을 유지한다. */
    for (let attempt = 1; ; attempt++) {
    // 1) 현재 cf_data 읽기 (select=* — version 컬럼이 없어도 깨지지 않게)
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/cf_data?select=*&limit=1`,
      { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
    );
    if (!getRes.ok) throw new Error(`cf_data 읽기 실패: ${getRes.status}`);
    const arr = await getRes.json();
    if (!arr?.[0]) throw new Error("cf_data 행이 없습니다.");
    const rowId = arr[0].id;
    const version = arr[0].version;
    const cfData: any[] = Array.isArray(arr[0].data)
      ? arr[0].data
      : (typeof arr[0].data === "string" ? JSON.parse(arr[0].data) : []);

    added = 0; skipped = 0;

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

    // 2) 조건부 쓰기 — 읽은 version 일 때만. return=representation 으로 실제 갱신 행 수를 본다.
    const cond = (version === undefined || version === null) ? "" : `&version=eq.${version}`;
    const patch = await fetch(`${SUPABASE_URL}/rest/v1/cf_data?id=eq.${rowId}${cond}`, {
      method: "PATCH",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ data: cfData, updated_at: new Date().toISOString() }),
    });
    if (!patch.ok) throw new Error(`cf_data 저장 실패: ${patch.status} ${await patch.text()}`);
    const updated = await patch.json();
    if (Array.isArray(updated) && updated.length > 0) { total = cfData.length; break; }  // 성공

    // 0행 갱신 = 내가 읽은 뒤 다른 주체가 썼다는 뜻 → 덮어쓰지 않고 다시 읽어 재시도
    if (attempt >= MAX_TRIES) {
      throw new Error(
        `cf_data 동시 수정 충돌 — ${MAX_TRIES}회 재시도 실패. 대시보드를 닫고 다시 시도하세요.`,
      );
    }
    await new Promise((res) => setTimeout(res, 200 * attempt));
    }

    return json({ ok: true, added, skipped, total });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});

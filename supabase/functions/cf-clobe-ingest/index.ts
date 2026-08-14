/**
 * cf-clobe-ingest — Supabase Edge Function
 *
 * 클로브 커넥터에서 가져온 은행 거래내역을 cf_data 에 추가한다.
 * 로직은 cf-folder-ingest(드라이브 경로)와 동일하되, 인증 시크릿만 BANK_SYNC_SECRET 을 쓴다.
 *   · 중복 skip: clobe_id(=클로브 transactionId) 우선, 없으면 (거래일+거래내용+금액+상태)
 *   · mid(클로브 계정라벨) 있으면 mid_cat 으로 반영
 * 호출 주체: 로컬 스케줄 태스크가 scripts/clobe-cf-ingest.mjs 로 검증 후 POST
 *
 * 적요 갱신(desc refresh) — 클로브가 거래처를 나중에 매핑하는 문제 대응
 *   당일 적재하면 거래처 매핑 전이라 은행 원본 문자열("동아_세진식품", "기업전용송금")이
 *   desc 로 굳는다. 그래서 적재 시 클로브가 준 원본을 desc_src 에 함께 남기고,
 *   재적재 때 desc === desc_src (= 사람이 안 건드림) 인 행만 새 적요로 갱신한다.
 *   desc !== desc_src 면 대시보드에서 수기 수정한 것이므로 보호한다.
 *   desc_src 가 없는 기존 행(이 기능 이전 적재분)은 판별 불가라 보수적으로 보호한다.
 *   갱신이 일어나면 cat_data 의 학습 매핑 키도 새 적요로 복사해 분류 정확도를 유지한다.
 *
 * 모드 (하나만 골라 보낸다)
 *   • 적재 { secret, action:"push", rows:[...] }                       — 종전과 동일
 *   • 조회 { secret, inspect:{ clobeIds?, from?, to?, desc?, unclassifiedOnly? } }
 *   • 수정 { secret, patch:[{ clobe_id | _id, mid_cat?, big_cat? }], midToBig?:{중분류:대분류} }
 *
 * 왜 patch 가 따로 있나: push 는 clobe_id 중복을 skip 하므로 재실행으로는 이미 적재된 행의
 * 분류를 못 고친다. 대분류는 대시보드가 catMidToBig[중분류] 로 파생하므로, 새 중분류를
 * 쓸 때는 midToBig 로 cat_data 매핑을 함께 넣어야 '기타' 로 떨어지지 않는다.
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

/* cat_data 의 학습 매핑에서 옛 적요 키의 값을 새 적요 키로 복사한다.
 *   desc_to_mid      : { "동아_세진식품": "매출원가" }        → 키 자체가 적요
 *   desc_type_to_mid : { "동아_세진식품::지출": "매출원가" }  → makeComboKey(desc,type) = desc+'::'+type
 * 대시보드 saveCatDataToSupabase 와 같은 key 별 낙관적 잠금을 쓴다(다른 key 와 간섭 없음).
 * 반환값: 사람이 볼 경고 문자열(문제 없으면 ""). */
async function migrateCatKeys(renameMap: Map<string, string>): Promise<string> {
  const notes: string[] = [];

  for (const key of ["desc_to_mid", "desc_type_to_mid"]) {
    const isCombo = key === "desc_type_to_mid";

    for (let attempt = 1; ; attempt++) {
      const getRes = await fetch(
        `${SUPABASE_URL}/rest/v1/cat_data?select=*&key=eq.${key}&limit=1`,
        { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
      );
      if (!getRes.ok) throw new Error(`cat_data(${key}) 읽기 실패: ${getRes.status}`);
      const arr = await getRes.json();
      if (!arr?.[0]) break;                      // 아직 없는 key — 이관할 것도 없다

      const version = arr[0].version;
      const map: Record<string, string> =
        (arr[0].data && typeof arr[0].data === "object") ? { ...arr[0].data }
        : (typeof arr[0].data === "string" ? JSON.parse(arr[0].data) : {});

      let changed = 0;
      for (const [from, to] of renameMap) {
        if (isCombo) {
          // "적요::구분" 형태라 접두사가 일치하는 키를 모두 훑는다(구분이 입금/지출 둘 다 있을 수 있음)
          for (const k of Object.keys(map)) {
            if (!k.startsWith(from + "::")) continue;
            const nk = to + k.slice(from.length);
            if (map[nk] === undefined && map[k]) { map[nk] = map[k]; changed++; }
          }
        } else if (map[from] && map[to] === undefined) {
          map[to] = map[from];
          changed++;
        }
      }
      if (!changed) break;                       // 복사할 게 없으면 쓰지 않는다

      const cond = (version === undefined || version === null) ? "" : `&version=eq.${version}`;
      const patch = await fetch(`${SUPABASE_URL}/rest/v1/cat_data?key=eq.${key}${cond}`, {
        method: "PATCH",
        headers: {
          apikey: SERVICE_ROLE,
          Authorization: `Bearer ${SERVICE_ROLE}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify({ data: map, updated_at: new Date().toISOString() }),
      });
      if (!patch.ok) throw new Error(`cat_data(${key}) 저장 실패: ${patch.status}`);
      const updated = await patch.json();
      if (Array.isArray(updated) && updated.length > 0) { notes.push(`${key} ${changed}건 이관`); break; }

      // 0행 갱신 = 그새 대시보드가 씀 → 다시 읽어 재시도(복사만 하므로 재시도가 안전)
      if (attempt >= 4) { notes.push(`${key} 동시 수정 충돌로 이관 실패 — 분류 정확도가 일시적으로 낮을 수 있습니다`); break; }
      await new Promise((res) => setTimeout(res, 200 * attempt));
    }
  }
  return notes.join(" / ");
}

const str = (v: unknown) => (v === undefined || v === null) ? "" : String(v).trim();

/* cf_data 를 읽어 mutate 로 제자리 수정한 뒤 낙관적 잠금으로 저장한다.
 * push 경로와 같은 규칙: 읽은 version 일 때만 쓰고, 0행 갱신(=그새 대시보드가 씀)이면
 * 덮어쓰지 않고 다시 읽어 재시도한다. mutate 는 재시도마다 새로 읽은 배열에 다시 적용되므로
 * 반드시 멱등이어야 한다(분류 대입은 멱등). */
async function mutateCfData<T>(mutate: (rows: any[]) => T, maxTries = 4): Promise<{ result: T; total: number }> {
  for (let attempt = 1; ; attempt++) {
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
    /* 빈 배열을 읽었는데 그대로 쓰면 전체가 날아간다(2026-08-01 292건 유실과 같은 모양).
     * patch 는 append 와 달리 복구 근거가 없으므로 아예 중단한다. */
    if (!cfData.length) throw new Error("cf_data 를 빈 배열로 읽었습니다 — 덮어쓰지 않고 중단합니다.");

    const result = mutate(cfData);

    const cond = (version === undefined || version === null) ? "" : `&version=eq.${version}`;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/cf_data?id=eq.${rowId}${cond}`, {
      method: "PATCH",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ data: cfData, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`cf_data 저장 실패: ${res.status} ${await res.text()}`);
    const updated = await res.json();
    if (Array.isArray(updated) && updated.length > 0) return { result, total: cfData.length };

    if (attempt >= maxTries) {
      throw new Error(`cf_data 동시 수정 충돌 — ${maxTries}회 재시도 실패. 대시보드를 닫고 다시 시도하세요.`);
    }
    await new Promise((r) => setTimeout(r, 200 * attempt));
  }
}

/* cat_data.mid_to_big 에 중분류→대분류 매핑을 병합한다(기존 값은 덮지 않는다).
 * 대시보드 getBigCat 이 catMidToBig[중분류] || '기타' 라, 이 매핑이 없으면 새 중분류가 '기타'로 떨어진다.
 * key 별 낙관적 잠금은 migrateCatKeys 와 동일. */
async function mergeMidToBig(add: Record<string, string>): Promise<{ added: string[]; kept: string[] }> {
  for (let attempt = 1; ; attempt++) {
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/cat_data?select=*&key=eq.mid_to_big&limit=1`,
      { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
    );
    if (!getRes.ok) throw new Error(`cat_data(mid_to_big) 읽기 실패: ${getRes.status}`);
    const arr = await getRes.json();
    /* 없으면 새로 만들지 않는다 — 여기서 만들면 대시보드 기본 매핑 전체가 이 몇 건으로 대체된다. */
    if (!arr?.[0]) throw new Error("cat_data 에 mid_to_big 행이 없습니다 — 대시보드에서 한 번 저장한 뒤 다시 시도하세요.");

    const version = arr[0].version;
    const map: Record<string, string> =
      (arr[0].data && typeof arr[0].data === "object") ? { ...arr[0].data }
      : (typeof arr[0].data === "string" ? JSON.parse(arr[0].data) : {});

    const added: string[] = [], kept: string[] = [];
    for (const [mid, big] of Object.entries(add)) {
      const m = str(mid), b = str(big);
      if (!m || !b) continue;
      if (map[m] === undefined) { map[m] = b; added.push(`${m}→${b}`); }
      else kept.push(`${m}→${map[m]}`);      // 이미 있으면 기존 값 유지(무단 재매핑 방지)
    }
    if (!added.length) return { added, kept };

    const cond = (version === undefined || version === null) ? "" : `&version=eq.${version}`;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/cat_data?key=eq.mid_to_big${cond}`, {
      method: "PATCH",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ data: map, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`cat_data(mid_to_big) 저장 실패: ${res.status}`);
    const updated = await res.json();
    if (Array.isArray(updated) && updated.length > 0) return { added, kept };

    if (attempt >= 4) throw new Error("cat_data(mid_to_big) 동시 수정 충돌 — 4회 재시도 실패. 대시보드를 닫고 다시 시도하세요.");
    await new Promise((r) => setTimeout(r, 200 * attempt));
  }
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
  const inspect = (body?.inspect && typeof body.inspect === "object" && !Array.isArray(body.inspect))
    ? body.inspect as Record<string, unknown> : null;
  const patchList = Array.isArray(body?.patch) ? body.patch : [];
  const midToBig = (body?.midToBig && typeof body.midToBig === "object" && !Array.isArray(body.midToBig))
    ? body.midToBig as Record<string, string> : null;

  /* ── 조회 모드 ── 분류를 고치기 전에 대상 행과 현재 상태를 확인한다(_id 선택자도 여기서 얻는다).
   * status·recur_id 도 반환한다(2026-08-14 추가) — 종전엔 이 둘이 빠져 있어 조회 스크립트로
   * "예정/실제" 판별이나 반복거래 추적이 불가능했다(cf_data 저장값 자체엔 늘 있었음, 응답만 안 줬음).
   * inspect.meta:true 를 같이 보내면 cat_data(settings.init_cash, bank_snapshot)도 읽기 전용으로
   * 함께 돌려준다 — 기초잔액·은행 스냅샷을 로그인 없이 확인하기 위한 용도. push/patch 로직은 무변경. */
  if (inspect) {
    try {
      const ids = new Set((Array.isArray(inspect.clobeIds) ? inspect.clobeIds : []).map((v) => str(v)).filter(Boolean));
      const from = str(inspect.from), to = str(inspect.to), descQ = str(inspect.desc);
      const unclassifiedOnly = inspect.unclassifiedOnly === true;
      const wantMeta = inspect.meta === true;

      const getRes = await fetch(
        `${SUPABASE_URL}/rest/v1/cf_data?select=data&limit=1`,
        { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
      );
      if (!getRes.ok) throw new Error(`cf_data 읽기 실패: ${getRes.status}`);
      const arr = await getRes.json();
      const cur: any[] = Array.isArray(arr?.[0]?.data) ? arr[0].data
        : (typeof arr?.[0]?.data === "string" ? JSON.parse(arr[0].data) : []);

      const hit = cur.filter((r) => {
        if (ids.size && !ids.has(str(r.clobe_id))) return false;
        const d = str(r.date);
        if (from && d < from) return false;
        if (to && d > to) return false;
        if (descQ && !str(r.desc).includes(descQ)) return false;
        if (unclassifiedOnly && str(r.mid_cat)) return false;
        return true;
      }).map((r) => ({
        _id: str(r._id), clobe_id: str(r.clobe_id), date: str(r.date), desc: str(r.desc),
        in: Number(r.in || 0), out: Number(r.out || 0), type: str(r.type),
        mid_cat: str(r.mid_cat), big_cat: str(r.big_cat),
        status: str(r.status), recur_id: str(r.recur_id), tx_at: str(r.tx_at),
      }));

      let meta: Record<string, unknown> | undefined;
      if (wantMeta) {
        const metaRes = await fetch(
          `${SUPABASE_URL}/rest/v1/cat_data?select=key,data&key=in.(settings,bank_snapshot)`,
          { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
        );
        if (metaRes.ok) {
          const metaRows: any[] = await metaRes.json();
          meta = {};
          for (const row of metaRows) meta[row.key] = row.data;
        }
      }

      return json({ ok: true, mode: "inspect", matched: hit.length, rows: hit.slice(0, 500), total: cur.length, ...(meta ? { meta } : {}) });
    } catch (e) {
      return json({ ok: false, error: (e as Error).message }, 500);
    }
  }

  /* ── 수정 모드 ── 이미 적재된 행의 중분류/대분류만 고친다(금액·적요·날짜는 건드리지 않는다). */
  if (patchList.length || midToBig) {
    try {
      let catNote: { added: string[]; kept: string[] } | null = null;
      // 대분류 매핑을 먼저 넣는다 — 행만 고치고 매핑이 없으면 대시보드에서 '기타'로 보인다.
      if (midToBig) catNote = await mergeMidToBig(midToBig);

      let changes: any[] = [], notFound: string[] = [], total = 0;
      if (patchList.length) {
        const out = await mutateCfData((cur) => {
          const ch: any[] = [], nf: string[] = [];
          for (const p of patchList) {
            const clobeId = str(p?.clobe_id), rid = str(p?._id);
            if (!clobeId && !rid) { nf.push("(선택자 없음)"); continue; }
            const idx = clobeId
              ? cur.findIndex((r) => str(r.clobe_id) === clobeId)
              : cur.findIndex((r) => str(r._id) === rid);
            if (idx < 0) { nf.push(clobeId || rid); continue; }

            const r = cur[idx];
            const before = { mid_cat: str(r.mid_cat), big_cat: str(r.big_cat) };
            let touched = false;
            if (p?.mid_cat !== undefined) { r.mid_cat = str(p.mid_cat); touched = true; }
            if (p?.big_cat !== undefined) { r.big_cat = str(p.big_cat); touched = true; }
            if (!touched) { nf.push(`${clobeId || rid} (바꿀 필드 없음)`); continue; }
            ch.push({ clobe_id: str(r.clobe_id), _id: str(r._id), date: str(r.date), desc: str(r.desc),
                      before, after: { mid_cat: str(r.mid_cat), big_cat: str(r.big_cat) } });
          }
          return { ch, nf };
        });
        changes = out.result.ch; notFound = out.result.nf; total = out.total;
      }
      return json({
        ok: true, mode: "patch", updated: changes.length, changes,
        ...(notFound.length ? { notFound } : {}),
        ...(catNote ? { midToBig: catNote } : {}),
        ...(total ? { total } : {}),
      });
    } catch (e) {
      return json({ ok: false, error: (e as Error).message }, 500);
    }
  }

  if (body?.action !== "push") {
    return json({ ok: false, error: "unknown action (push / inspect / patch)" }, 400);
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];

  try {
    const today = todaySeoul();
    const MAX_TRIES = 4;
    let added = 0, skipped = 0, total = 0, refreshed = 0, timeFilled = 0;
    let renames: Array<{ from: string; to: string }> = [];

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

    added = 0; skipped = 0; refreshed = 0; timeFilled = 0; renames = [];   // 재시도마다 새로 읽으므로 초기화

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
      /* 실제 거래 시각(ISO, 초 단위). 같은 날짜 안의 순서를 정하는 유일한 근거다 —
         대시보드 잔액 열이 이걸로 정렬한다. 없으면 종전과 동일 동작(하위호환). */
      const txAt = String(r?.tx_at ?? "").trim();

      // 중복 판정: clobe_id(고유) 있으면 그걸로, 없으면 기존 (거래일+거래내용+상태+금액)
      const dupIdx = clobeId
        ? cfData.findIndex((d) => String(d.clobe_id ?? "") === clobeId)
        : cfData.findIndex((d) => {
            if (d.date !== date || d.desc !== desc || d.status !== status) return false;
            const dAmt = (d.amount !== undefined && d.amount !== null)
              ? d.amount : ((d.in || 0) - (d.out || 0));
            return Math.abs(dAmt - amount) < 1;
          });

      if (dupIdx >= 0) {
        /* 이미 있는 행 — clobe_id 로 잡힌 건만 적요 갱신을 검토한다.
         * (적요 기반 폴백 중복 판정은 desc 가 키에 들어가 있어 애초에 바뀐 적요를 못 잡는다.)
         * 갱신 조건: desc_src 가 있고(= 이 기능 이후 적재분), 그 값이 현재 desc 와 같고
         *          (= 사람이 수정한 적 없음), 새로 온 적요가 실제로 다를 때. */
        const ex = cfData[dupIdx];
        const exDesc = String(ex.desc ?? "");
        const exSrc = ex.desc_src === undefined || ex.desc_src === null ? null : String(ex.desc_src);
        /* 거래 시각 백필 — 이 기능 이전에 적재된 행은 tx_at 이 없다. 재적재로 같은 거래를 다시 만나면
         * 그때 채운다(값이 이미 있으면 건드리지 않는다). 스케줄 태스크가 매일 최근 6일을 다시 훑으므로
         * 최근분은 저절로 채워지고, 그보다 오래된 건은 그 기간을 한 번 재적재하면 된다. */
        if (clobeId && txAt && !String(ex.tx_at ?? "").trim()) {
          ex.tx_at = txAt;
          timeFilled++;
        }
        if (clobeId && exSrc !== null && exSrc === exDesc && desc !== exDesc) {
          ex.desc = desc;
          ex.desc_src = desc;
          renames.push({ from: exDesc, to: desc });
          refreshed++;
        } else {
          skipped++;
        }
        continue;
      }

      const rec: any = {
        _id: genId(),
        date, desc, in: inA, out: outA, amount, type, status,
        mid_cat: mid, // 클로브 계정라벨(있으면). 없으면 "" → 자동분류 추천 대상
        big_cat: "",
      };
      if (txAt) rec.tx_at = txAt;   // 같은 날짜 안의 정렬 근거 (대시보드 잔액 열)
      if (clobeId) {
        rec.clobe_id = clobeId;  // 재적재 중복 차단용 고유키
        /* 클로브가 준 원본 적요. 이후 재적재 때 desc 와 비교해 "사람이 손댔는지" 를 가린다 —
         * 이 표시가 없으면 수기 수정과 자동 적재분을 구분할 방법이 없다. */
        rec.desc_src = desc;
      }
      /* 외화 원금(통화 단위). 이 표시가 있는 행만 모아 "외화 실잔액 − 순증" 으로
       * 환산조정액을 계산한다. cf_data 에 계좌 정보가 없어 이것 말고는 구분할 방법이 없다. */
      const fxUsd = Number(r?.fx_usd);
      if (Number.isFinite(fxUsd) && fxUsd > 0) rec.fx_usd = fxUsd;
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

    /* 학습 매핑 키 이관 — 적요가 A→B 로 갱신되면 catDescToMid 의 키도 A 뿐이라
     * classifyMid 의 정확일치가 깨진다(정규화 폴백으로 내려가 정확도 하락).
     * 그래서 A 의 학습값을 B 키로 **복사**한다. 옮기지 않고 복사하는 이유:
     * desc_src 가 없어 보호된 기존 행들이 여전히 A 를 쓰고 있어, A 를 지우면 그쪽 분류가 깨진다.
     * 이미 B 키가 있으면 그쪽이 더 최신이므로 덮어쓰지 않는다.
     * cf_data 는 이미 저장됐으므로 여기서 실패해도 전체를 실패시키지 않고 경고만 싣는다. */
    let catNote = "";
    if (renames.length) {
      try {
        const uniq = new Map<string, string>();
        for (const { from, to } of renames) if (from && to && from !== to) uniq.set(from, to);
        if (uniq.size) catNote = await migrateCatKeys(uniq);
      } catch (e) {
        catNote = `학습 매핑 이관 실패: ${(e as Error).message}`;
      }
    }

    return json({
      ok: true, added, skipped, refreshed, timeFilled, total,
      ...(catNote ? { cat_sync: catNote } : {}),
      /* 갱신된 적요를 그대로 실어 보낸다 — 스케줄 태스크가 요약·슬랙에 남겨
       * 사람이 "무엇이 어떻게 바뀌었는지" 를 사후에 알아볼 수 있게 한다. */
      ...(renames.length ? { renamed: renames.slice(0, 20) } : {}),
    });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});

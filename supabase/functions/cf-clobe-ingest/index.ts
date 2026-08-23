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
 *   • 조회 { secret, inspect:{ clobeIds?, from?, to?, desc?, unclassifiedOnly?, meta? } }
 *     meta: true → settings·bank_snapshot / meta: ["키",…] → 그 cat_data 키들(읽기 전용)
 *   • 수정 { secret, patch:[{ clobe_id | _id, mid_cat?, big_cat?, tx_at?, set_clobe_id? }], midToBig?:{중분류:대분류} }
 *   • 분할 { secret, split:[{ clobe_id | _id, spawn:{ amount, big_cat, mid_cat, desc? } }], dry?, midToBig? }
 *     tx_at 은 비어 있을 때만 채운다(거래 시각 백필용 · 멱등).
 *   • 기준값 { secret, setMeta:{ "settings.init_cash": 숫자, "fx_adjust_base.pre_krw": 숫자 }, dry? }
 *     기초잔액·환산조정 기준값만 고치는 좁은 경로다. **화이트리스트에 있는 경로만** 쓴다 —
 *     cat_data 전체를 SERVICE_ROLE 로 자유롭게 쓰게 만들지 않으려는 의도다.
 *     ⚠ 이 둘은 서로 얽혀 있다: FX_ADJ = fxKrw − (pre_krw + Σfx) 이므로 pre_krw 를 낮추면
 *       잔액이 같은 만큼 올라간다. 따로 뽑은 값을 같이 넣으면 그 차이가 이중반영된다.
 *       scripts/recon-init-cash.mjs 로 **함께** 계산한 값을 넣을 것.
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
  const splitList = Array.isArray(body?.split) ? body.split : [];
  const midToBig = (body?.midToBig && typeof body.midToBig === "object" && !Array.isArray(body.midToBig))
    ? body.midToBig as Record<string, string> : null;
  const setMeta = (body?.setMeta && typeof body.setMeta === "object" && !Array.isArray(body.setMeta))
    ? body.setMeta as Record<string, unknown> : null;

  /* ── 기준값 수정 모드 ──
   * cat_data 는 RLS 때문에 publishable 키로 읽지도 쓰지도 못한다. 조회는 inspect.meta 로
   * 뚫었지만 쓰기는 mid_to_big 병합밖에 없었다. 기초잔액(init_cash)·환산조정 기준(pre_krw)을
   * 고치려면 대시보드에 로그인해 화면에서 눌러야 했고, 스크립트로 역산한 값을 그대로
   * 반영할 수단이 없었다.
   *
   * ⚠ 일부러 화이트리스트로 막는다. "cat_data 아무 키나 쓰기"로 만들면 이 함수가
   *   SERVICE_ROLE 범용 쓰기 도구가 되고, 오타 한 번에 학습 매핑·일별설정이 날아간다.
   *   새 경로가 필요해지면 여기 명시적으로 추가할 것.
   * ⚠ 숫자만 받는다. 값 종류를 늘리면 검증이 헐거워진다.
   * 낙관적 잠금: 읽은 version 일 때만 쓴다(mergeMidToBig 와 같은 규칙). */
  if (setMeta) {
    /* 화이트리스트. 새 경로가 필요하면 여기 명시적으로 추가한다 — 범용 쓰기로 만들지 않는다.
       · fx_adjust_base.unbooked_loss — FX_ADJ 중 '실현됐으나 손익 미기표' 인 금액.
         대시보드 잔액 대조 카드가 이 값을 읽어 환산손익 줄에 근거로 표시한다. 현금 계산에는
         전혀 쓰지 않는다(표시 전용). 0 을 넣으면 표시가 사라진다.
         산출 근거·재현: docs/fx-loss-booking-analysis.md · scripts/verify-fx-loss-booking.mjs */
    const ALLOWED = new Set(["settings.init_cash", "fx_adjust_base.pre_krw", "fx_adjust_base.unbooked_loss"]);
    const dry = body?.dry === true;
    try {
      const plan: Array<{ key: string; field: string; path: string; next: number }> = [];
      const bad: string[] = [];
      for (const [path, raw] of Object.entries(setMeta)) {
        if (!ALLOWED.has(path)) { bad.push(`${path} (허용 경로 아님)`); continue; }
        const n = Number(raw);
        if (!Number.isFinite(n)) { bad.push(`${path} (숫자 아님: ${String(raw)})`); continue; }
        const [key, field] = path.split(".");
        plan.push({ key, field, path, next: Math.round(n) });
      }
      if (bad.length) {
        return json({ ok: false, error: `거부: ${bad.join(", ")}`, allowed: [...ALLOWED] }, 400);
      }
      if (!plan.length) return json({ ok: false, error: "setMeta 가 비었습니다" }, 400);

      const changes: Array<Record<string, unknown>> = [];
      for (const p of plan) {
        for (let attempt = 1; ; attempt++) {
          const getRes = await fetch(
            `${SUPABASE_URL}/rest/v1/cat_data?select=*&key=eq.${p.key}&limit=1`,
            { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
          );
          if (!getRes.ok) throw new Error(`cat_data(${p.key}) 읽기 실패: ${getRes.status}`);
          const arr = await getRes.json();
          /* 없으면 만들지 않는다 — mergeMidToBig 와 같은 이유. 여기서 만들면 대시보드가
             갖고 있던 다른 필드(예: settings 의 다른 설정)가 통째로 사라진다. */
          if (!arr?.[0]) throw new Error(`cat_data 에 ${p.key} 행이 없습니다 — 대시보드에서 한 번 저장한 뒤 다시 시도하세요.`);
          const version = arr[0].version;
          const data: Record<string, unknown> =
            (arr[0].data && typeof arr[0].data === "object") ? { ...arr[0].data }
            : (typeof arr[0].data === "string" ? JSON.parse(arr[0].data) : {});
          const before = data[p.field];
          if (Number(before) === p.next) {
            changes.push({ path: p.path, before, after: p.next, note: "변경 없음(이미 같은 값)" });
            break;
          }
          if (dry) {
            changes.push({ path: p.path, before, after: p.next, note: "dry — 쓰지 않음" });
            break;
          }
          data[p.field] = p.next;
          const cond = (version === undefined || version === null) ? "" : `&version=eq.${version}`;
          const res = await fetch(`${SUPABASE_URL}/rest/v1/cat_data?key=eq.${p.key}${cond}`, {
            method: "PATCH",
            headers: {
              apikey: SERVICE_ROLE,
              Authorization: `Bearer ${SERVICE_ROLE}`,
              "Content-Type": "application/json",
              Prefer: "return=representation",
            },
            body: JSON.stringify({ data, updated_at: new Date().toISOString() }),
          });
          if (!res.ok) throw new Error(`cat_data(${p.key}) 저장 실패: ${res.status}`);
          const updated = await res.json();
          if (Array.isArray(updated) && updated.length > 0) {
            changes.push({ path: p.path, before, after: p.next });
            break;
          }
          if (attempt >= 4) throw new Error(`cat_data(${p.key}) 동시 수정 충돌 — 4회 재시도 실패. 대시보드를 닫고 다시 시도하세요.`);
        }
      }
      return json({ ok: true, mode: dry ? "setMeta(dry)" : "setMeta", changes });
    } catch (e) {
      return json({ ok: false, error: (e as Error).message }, 500);
    }
  }

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
      /* meta: true → 기본 키, meta: ["a","b"] → 그 키들. cat_data 는 RLS 때문에 publishable
         키로 못 읽어서 확인할 때마다 Edge 를 고쳐 배포해야 했다(settings·bank_snapshot·
         daily_settings…). 키 목록을 받게 해서 그 반복을 끝낸다. 읽기 전용이다. */
      const META_DEFAULT = ["settings", "bank_snapshot"];
      const metaKeys = inspect.meta === true ? META_DEFAULT
        : (Array.isArray(inspect.meta)
            ? (inspect.meta as unknown[]).map((v) => str(v)).filter((k) => /^[a-zA-Z0-9_]+$/.test(k)).slice(0, 20)
            : []);
      const wantMeta = metaKeys.length > 0;
      /* ar: true → ar_data 를 읽기 전용으로 함께 돌려준다.
         ar_data 는 RLS 상 **로그인 세션에서만** 읽힌다(대시보드는 되지만 스크립트는 못 읽음).
         그래서 매출채권 관련 계산을 화면 밖에서 검증할 방법이 없었다 — 일별 채권 잔액
         시계열을 만들면서 필요해져 여기 붙인다. 쓰기는 하지 않는다. */
      const wantAr = inspect.ar === true;

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
        /* fx_usd — 외화 환산손익(FX_ADJ) 장부가에 들어가는 행 표시. 이게 없으면 환산손익을
           화면 밖에서 검증할 수 없다(2026-08-22, 태깅 누락 조사 때 필요해져 추가). */
        fx_usd: r.fx_usd ? true : false,
      }));

      let arRows: unknown[] | undefined;
      if (wantAr) {
        const arRes = await fetch(
          `${SUPABASE_URL}/rest/v1/ar_data?select=data&limit=1`,
          { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
        );
        if (arRes.ok) {
          const a = await arRes.json();
          const raw = a?.[0]?.data;
          const list = Array.isArray(raw) ? raw : (typeof raw === "string" ? JSON.parse(raw) : []);
          /* 계산에 필요한 필드만 — 거래처명·비고 같은 건 여기서 쓸 일이 없다 */
          arRows = (Array.isArray(list) ? list : []).map((r: any) => ({
            partner: str(r.partner), start: str(r.start), due_date: str(r.due_date),
            collect_date: str(r.collect_date),
            expected: Number(r.expected) || 0, collected: Number(r.collected) || 0,
            remaining: (r.remaining === undefined || r.remaining === null || r.remaining === "")
              ? null : Number(r.remaining),
          }));
        }
      }
      let meta: Record<string, unknown> | undefined;
      if (wantMeta) {
        const metaRes = await fetch(
          `${SUPABASE_URL}/rest/v1/cat_data?select=key,data&key=in.(${metaKeys.join(",")})`,
          { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
        );
        if (metaRes.ok) {
          const metaRows: any[] = await metaRes.json();
          meta = {};
          for (const row of metaRows) meta[row.key] = row.data;
        }
      }

      return json({ ok: true, mode: "inspect", matched: hit.length, rows: hit.slice(0, 500), total: cur.length,
        ...(meta ? { meta } : {}), ...(arRows ? { ar: arRows, arTotal: arRows.length } : {}) });
    } catch (e) {
      return json({ ok: false, error: (e as Error).message }, 500);
    }
  }

  /* ── 분할 모드 ── 한 행을 두 행으로 쪼갠다. **금액 보존을 서버가 강제한다.**
   *   { secret, split:[{ clobe_id|_id, spawn:{ amount, big_cat, mid_cat, desc? } }], dry?, midToBig? }
   *
   * 왜 필요한가 (2026-08-22): 7/9 환전에서 외화측 출금 754,950,000 과 원화측 입금 745,945,000 의
   *   차이 9,005,000 × 2건 = 18,010,000 은 은행에 실제로 낸 환전 스프레드(1.19%)다. 그런데 한 행
   *   안에 섞여 있어 '자금이동' 으로 묻혀 비용으로 안 잡혔다. 드러내려면 행을 쪼개야 한다.
   *
   * ⚠ 왜 '금액 수정' 이 아니라 '분할' 인가 — 금액을 자유롭게 고치게 열어 두면 현금 총액이 조용히
   *   틀어질 수 있다. 분할은 keep + spawn == 원금액 을 서버가 검증하므로 총액이 구조적으로
   *   보존된다. 금액을 진짜로 정정해야 하는 일이 생기면 그건 별도 수단으로 다룰 것.
   * ⚠ spawn 행에는 clobe_id 를 넣지 않는다. 원본이 clobe_id 를 그대로 들고 있고, push 는 clobe_id
   *   로 찾은 행의 **금액을 갱신하지 않으므로**(적요·거래시각만) 재적재로 분할이 되돌아가지 않는다.
   * ⚠ fx_usd 는 떼낸 행에도 그대로 물려준다 — 그 돈은 실제로 외화계좌에서 나갔다. 태그를 떼면
   *   환산손익 장부가 틀어져 FX_ADJ 가 오히려 악화된다(2026-08-22 검산: -1.26억 → -1.44억).
   * ⚠ 분할은 FX_ADJ 를 바꾸지 않는다. 분류만 바로잡는 작업이다. */
  if (splitList.length) {
    try {
      const dry = body?.dry === true;
      let catNote: { added: string[]; kept: string[] } | null = null;
      if (midToBig && !dry) catNote = await mergeMidToBig(midToBig);

      /* 계획 수립 — 순수 함수. dry 와 실행이 같은 규칙을 쓰도록 한 곳에 둔다. */
      const planSplit = (cur: any[]) => {
        const plan: any[] = [], rejected: string[] = [];
        for (const sp of splitList) {
          const clobeId = str(sp?.clobe_id), rid = str(sp?._id);
          const tag = clobeId || rid || "(선택자 없음)";
          if (!clobeId && !rid) { rejected.push(tag); continue; }
          const idx = clobeId
            ? cur.findIndex((r) => str(r.clobe_id) === clobeId)
            : cur.findIndex((r) => str(r._id) === rid);
          if (idx < 0) { rejected.push(`${tag} (행 없음)`); continue; }
          const r = cur[idx];
          const dir = Number(r.out || 0) > 0 ? "out" : (Number(r.in || 0) > 0 ? "in" : "");
          if (!dir) { rejected.push(`${tag} (금액이 0)`); continue; }
          const orig = Math.round(Number(r[dir]) || 0);
          const amt = Math.round(Number(sp?.spawn?.amount) || 0);
          if (!(amt > 0 && amt < orig)) { rejected.push(`${tag} (분할액 ${amt} 가 0 < x < ${orig} 밖)`); continue; }
          const keep = orig - amt;
          if (keep + amt !== orig) { rejected.push(`${tag} (금액 보존 실패)`); continue; }
          const bigC = str(sp?.spawn?.big_cat), midC = str(sp?.spawn?.mid_cat);
          if (!bigC || !midC) { rejected.push(`${tag} (spawn 의 big_cat/mid_cat 누락)`); continue; }
          plan.push({
            idx, _id: str(r._id), clobe_id: str(r.clobe_id), date: str(r.date), desc: str(r.desc),
            dir, orig, keep, spawn: amt, big_cat: bigC, mid_cat: midC,
            spawn_desc: str(sp?.spawn?.desc) || str(r.desc),
            fx_usd: r.fx_usd ? true : false,
            from: { big_cat: str(r.big_cat), mid_cat: str(r.mid_cat) },
          });
        }
        return { plan, rejected };
      };

      if (dry) {
        const getRes = await fetch(
          `${SUPABASE_URL}/rest/v1/cf_data?select=data&limit=1`,
          { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
        );
        if (!getRes.ok) throw new Error(`cf_data 읽기 실패: ${getRes.status}`);
        const arr = await getRes.json();
        const cur: any[] = Array.isArray(arr?.[0]?.data) ? arr[0].data
          : (typeof arr?.[0]?.data === "string" ? JSON.parse(arr[0].data) : []);
        const { plan, rejected } = planSplit(cur);
        return json({ ok: true, mode: "split(dry)", planned: plan.length, plan,
          ...(rejected.length ? { rejected } : {}), total: cur.length });
      }

      const out = await mutateCfData((cur) => {
        const { plan, rejected } = planSplit(cur);
        /* 뒤에서부터 삽입 — 앞에서부터 넣으면 뒤쪽 idx 가 밀려 엉뚱한 행을 건드린다. */
        for (const q of [...plan].sort((a, b) => b.idx - a.idx)) {
          const r = cur[q.idx];
          r[q.dir] = q.keep;
          r.amount = q.dir === "out" ? -q.keep : q.keep;
          const rec: any = {
            _id: genId(), date: q.date, desc: q.spawn_desc,
            in: q.dir === "in" ? q.spawn : 0, out: q.dir === "out" ? q.spawn : 0,
            amount: q.dir === "out" ? -q.spawn : q.spawn,
            type: str(r.type), status: str(r.status),
            mid_cat: q.mid_cat, big_cat: q.big_cat,
            split_from: q._id,           // 어느 행에서 떼냈는지 — 되돌릴 때 쓴다
          };
          if (str(r.tx_at)) rec.tx_at = str(r.tx_at);
          if (q.fx_usd) rec.fx_usd = true;
          cur.splice(q.idx + 1, 0, rec);
        }
        return { plan, rejected };
      });
      return json({ ok: true, mode: "split", updated: out.result.plan.length, plan: out.result.plan,
        ...(out.result.rejected.length ? { rejected: out.result.rejected } : {}),
        ...(catNote ? { midToBig: catNote } : {}), total: out.total });
    } catch (e) {
      return json({ ok: false, error: (e as Error).message }, 500);
    }
  }

  /* ── 수정 모드 ── 이미 적재된 행의 분류·거래시각·clobe_id 만 고친다.
   *   **금액·적요·날짜·상태는 절대 건드리지 않는다.**
   *
   * set_clobe_id (2026-08-22 추가) — 2026-03~06 의 1,044건은 clobe_id 가 전무해서 은행 원본과
   *   대조할 키가 없다. 그 구간을 클로브로 **재적재하면 667건(408.5억)이 이중계상**된다(실측:
   *   중복 판정이 적요로 떨어지는데 기존 적요는 은행 원본 문자열이고 적재는 거래처명을 넣는다).
   *   그래서 재적재 대신 기존 행에 clobe_id 를 붙인다.
   *   ⚠ 선택자로 쓰는 clobe_id 와 헷갈리지 않게 필드명을 따로 뒀다. 백필 대상은 clobe_id 가
   *     없는 행이므로 선택자는 _id 를 쓴다.
   *   ⚠ tx_at 과 같이 **비어 있을 때만** 채운다(멱등). 이미 있는 clobe_id 를 덮어쓰지 않는다.
   *   ⚠ 같은 clobe_id 가 두 행에 붙으면 push 의 중복 판정이 깨져 이후 적재가 조용히 어긋난다.
   *     그래서 다른 행이 이미 그 id 를 쓰고 있으면 **거부**한다. */
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
            const before = { mid_cat: str(r.mid_cat), big_cat: str(r.big_cat), tx_at: str(r.tx_at), clobe_id: str(r.clobe_id) };
            let touched = false;
            if (p?.mid_cat !== undefined) { r.mid_cat = str(p.mid_cat); touched = true; }
            if (p?.big_cat !== undefined) { r.big_cat = str(p.big_cat); touched = true; }
            /* 거래 시각 백필 — **비어 있을 때만** 채운다(멱등, 재실행 안전).
             * 이미 값이 있으면 조용히 건드리지 않는다. 잘못 들어간 시각을 고치는 건 별개 작업이고,
             * 대량 백필이 기존 값을 덮어쓰는 사고를 막는 게 우선이다. */
            if (p?.tx_at !== undefined && str(p.tx_at) && !str(r.tx_at)) { r.tx_at = str(p.tx_at); touched = true; }
            /* clobe_id 백필 — 비어 있을 때만. 다른 행이 쓰는 id 면 거부(중복 판정 보호) */
            if (p?.set_clobe_id !== undefined && str(p.set_clobe_id)) {
              const cid = str(p.set_clobe_id);
              if (str(r.clobe_id)) {
                if (str(r.clobe_id) !== cid) { nf.push(`${clobeId || rid} (clobe_id 이미 ${str(r.clobe_id)})`); continue; }
              } else if (cur.some((o) => o !== r && str(o.clobe_id) === cid)) {
                nf.push(`${clobeId || rid} (clobe_id ${cid} 를 이미 다른 행이 사용)`); continue;
              } else { r.clobe_id = cid; touched = true; }
            }
            if (!touched) { nf.push(`${clobeId || rid} (바꿀 필드 없음)`); continue; }
            ch.push({ clobe_id: str(r.clobe_id), _id: str(r._id), date: str(r.date), desc: str(r.desc),
                      before, after: { mid_cat: str(r.mid_cat), big_cat: str(r.big_cat), tx_at: str(r.tx_at) } });
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
    return json({ ok: false, error: "unknown action (push / inspect / patch / split / setMeta)" }, 400);
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

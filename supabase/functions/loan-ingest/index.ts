/**
 * loan-ingest — Supabase Edge Function
 *
 * 대출 목록 cat_data('loan_data') 을 **읽고, 지정한 필드만 덧쓴다.**
 * publishable 키는 RLS 에 막혀 cat_data 를 읽지도 쓰지도 못하므로 service_role 을 가진 이 함수를 경유.
 *
 * ⚠ 전체 교체를 하지 않는 이유: 대출 탭의 엑셀 업로드는 전체 교체라, 사람이 대시보드에서
 *   직접 고친 값(차환 계획·비고 등)이 조용히 사라진다. 여기서는 match 로 행을 찾아
 *   set 에 담긴 필드만 바꾸고 나머지는 손대지 않는다.
 *
 * 두 가지 모드:
 *   • 조회 { secret, inspect: true }
 *     현재 loan_data 를 그대로 돌려준다. 쓰기 없음. **덮어쓰기 전에 반드시 이걸로 먼저 볼 것.**
 *   • 수정 { secret, patch: [{ match: {balance, rate}, set: {account, intAmount, intDay, intAccount} }] }
 *     match 는 balance+rate 조합(로가 10건에서 유일함을 확인). 은행명은 줄바꿈이 섞여 있어
 *     ("우리은행\n(중진공)") 매칭키로 쓰지 않는다.
 *     한 건도 못 찾거나 둘 이상 찾으면 그 항목은 건너뛰고 결과에 남긴다(부분 성공 허용).
 *
 * 반환: { ok, changed:[{match, diff}], notFound:[], ambiguous:[], total }
 */
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SECRET       = Deno.env.get('BANK_SYNC_SECRET') || Deno.env.get('CF_SYNC_SECRET') || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });

const num = (v: unknown) => {
  if (v === '' || v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
};
/* 금액·금리는 문자열로 들어와 있을 수 있어(엑셀 업로드분) 숫자로 맞춘 뒤 비교한다.
   금리는 소수 4자리까지 쓰므로 반올림 오차를 피해 0.0001 허용오차로 본다. */
const sameRow = (row: any, m: any) =>
  Math.round(num(row.balance)) === Math.round(num(m.balance)) &&
  Math.abs(num(row.rate) - num(m.rate)) < 0.0001;

const SETTABLE = ['account', 'intAmount', 'intDay', 'intAccount'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ ok: false, error: 'POST only' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'invalid json' }, 400); }
  if (!SECRET || body?.secret !== SECRET) return json({ ok: false, error: 'unauthorized' }, 401);

  const patch = Array.isArray(body?.patch) ? body.patch : [];
  const inspect = body?.inspect === true;
  if (!inspect && !patch.length) return json({ ok: false, error: 'inspect 또는 patch 가 필요합니다' }, 400);

  try {
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/cat_data?key=eq.loan_data&select=key,data`,
      { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
    );
    if (!getRes.ok) throw new Error(`cat_data 읽기 실패: ${getRes.status}`);
    const got = await getRes.json();
    let cur: any[] = [];
    const raw = got?.[0]?.data;
    if (Array.isArray(raw)) cur = raw;
    else if (typeof raw === 'string') { try { cur = JSON.parse(raw); } catch { cur = []; } }
    if (!Array.isArray(cur)) cur = [];

    if (inspect) return json({ ok: true, total: cur.length, rows: cur });

    // 기존이 비었는데 덮어쓰면 통째로 날아간다. 수정은 기존 행이 전제라 여기서 막는다.
    if (!cur.length) return json({ ok: false, error: '기존 대출 목록이 비어 있어 수정을 중단했습니다' }, 409);

    const changed: any[] = [], notFound: any[] = [], ambiguous: any[] = [];
    for (const p of patch) {
      const m = p?.match || {};
      const hits = cur.filter((r) => sameRow(r, m));
      if (hits.length === 0) { notFound.push(m); continue; }
      if (hits.length > 1)   { ambiguous.push({ match: m, count: hits.length }); continue; }
      const row = hits[0], diff: any = {};
      for (const k of SETTABLE) {
        if (!(k in (p?.set || {}))) continue;
        const v = p.set[k];
        const nv = (k === 'intAmount' || k === 'intDay') ? num(v) : String(v ?? '').trim();
        const ov = (k === 'intAmount' || k === 'intDay') ? num(row[k]) : String(row[k] ?? '').trim();
        if (nv === ov) continue;            // 같은 값 — 재실행해도 안전
        diff[k] = { from: row[k] ?? null, to: nv };
        row[k] = nv;
      }
      if (Object.keys(diff).length) changed.push({ bank: row.bank, product: row.product, balance: row.balance, diff });
    }

    if (changed.length) {
      // ⚠ POST 로 upsert 하려면 반드시 ?on_conflict=key 를 붙여야 한다. 없으면
      //   Prefer: resolution=merge-duplicates 가 무시되고 23505(중복키)로 409 가 난다.
      const putRes = await fetch(`${SUPABASE_URL}/rest/v1/cat_data?on_conflict=key`, {
        method: 'POST',
        headers: {
          apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify([{ key: 'loan_data', data: cur }]),
      });
      if (!putRes.ok) throw new Error(`cat_data 저장 실패: ${putRes.status} ${await putRes.text()}`);
    }
    return json({ ok: true, total: cur.length, changedCount: changed.length, changed, notFound, ambiguous });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});

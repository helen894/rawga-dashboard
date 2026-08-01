/**
 * bank-snapshot — Supabase Edge Function
 *
 * 은행 실잔액 스냅샷을 cat_data('bank_snapshot')에 저장한다.
 * 대시보드는 브라우저에서 클로브를 직접 호출할 수 없고, publishable 키는 RLS에 막혀
 * cat_data 쓰기가 불가하므로(401), service_role 을 가진 이 함수를 경유한다.
 *
 * 호출: POST { secret, snapshot: { asOf, source, checking, savings, fxKrw, totalCash, loan, fxRate, fx[] } }
 * 인증: Supabase Secrets 의 BANK_SYNC_SECRET (없으면 CF_SYNC_SECRET 재사용)
 *
 * 자동 갱신 주체: 로컬 스케줄 태스크(Claude)가 클로브 MCP로 잔액을 조회해 이 엔드포인트로 POST.
 */
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SECRET        = Deno.env.get('BANK_SYNC_SECRET') || Deno.env.get('CF_SYNC_SECRET') || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : Number(v) || 0);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'POST only' }, 405);

  let body: any = null;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  if (!SECRET || body?.secret !== SECRET) return json({ error: 'unauthorized' }, 401);

  const s = body?.snapshot;
  if (!s || typeof s !== 'object') return json({ error: 'snapshot 없음' }, 400);

  const totalCash = num(s.totalCash);
  if (!(totalCash > 0)) return json({ error: 'totalCash 가 0 이하 — 수집 실패 데이터로 판단해 저장하지 않음' }, 400);

  // 저장 형태 정규화 (대시보드 renderBankRecon 이 읽는 필드)
  const snapshot = {
    asOf:      String(s.asOf || new Date().toISOString()),
    source:    String(s.source || '클로브'),
    checking:  num(s.checking),
    savings:   num(s.savings),
    fxKrw:     num(s.fxKrw),
    totalCash,
    loan:      num(s.loan),
    fxRate:    num(s.fxRate) || null,
    fx:        Array.isArray(s.fx) ? s.fx.slice(0, 20) : [],
    note:      s.note ? String(s.note) : '',
    updatedAt: new Date().toISOString(),
  };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/cat_data?on_conflict=key`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([{ key: 'bank_snapshot', data: snapshot }]),
  });

  if (!res.ok) {
    const detail = await res.text();
    return json({ error: 'cat_data 저장 실패', status: res.status, detail: detail.slice(0, 300) }, 500);
  }
  return json({ ok: true, totalCash: snapshot.totalCash, asOf: snapshot.asOf });
});

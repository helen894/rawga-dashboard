/**
 * card-ingest — Supabase Edge Function
 *
 * 클로브 '승인내역'(카드 사용) 을 cat_data('corp_card_tx_data') 에 추가한다.
 * publishable 키는 RLS 에 막혀 cat_data 쓰기가 안 되므로 service_role 을 가진 이 함수를 경유.
 *
 * ⚠ 카드 데이터는 cf_data(현금흐름)에 넣지 않는다.
 *   실제 현금 유출은 은행에서 빠지는 '카드대금 결제'이고 그건 입출금 적재가 이미 잡는다.
 *   여기에 카드 사용까지 넣으면 이중계상이 된다. (발생기준 집계 전용 저장소)
 *
 * 중복 차단 2단:
 *   1) approval_id (클로브 승인 고유키) 일치
 *   2) approval_id 없는 기존 행(수기 엑셀 업로드분)을 위해
 *      복합키 use_date|card_no|merchant|billing_amount 일치
 *   → 같은 기간을 다시 적재해도 수기분과 겹치지 않는다.
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

const num = (v: unknown) => Math.round(Number(v) || 0);
const str = (v: unknown) => String(v ?? '').trim();
const compositeKey = (r: any) => [str(r.use_date), str(r.card_no), str(r.merchant), num(r.billing_amount)].join('|');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ ok: false, error: 'POST only' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'invalid json' }, 400); }
  if (!SECRET || body?.secret !== SECRET) return json({ ok: false, error: 'unauthorized' }, 401);

  const rows = Array.isArray(body?.rows) ? body.rows : [];
  if (!rows.length) return json({ ok: false, error: 'rows 없음' }, 400);

  try {
    // 1) 기존 데이터 읽기
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/cat_data?key=eq.corp_card_tx_data&select=key,data`,
      { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
    );
    if (!getRes.ok) throw new Error(`cat_data 읽기 실패: ${getRes.status}`);
    const got = await getRes.json();
    let cur: any[] = [];
    const raw = got?.[0]?.data;
    if (Array.isArray(raw)) cur = raw;
    else if (typeof raw === 'string') { try { cur = JSON.parse(raw); } catch { cur = []; } }
    if (!Array.isArray(cur)) cur = [];

    const seenApproval = new Set(cur.map((r) => str(r.approval_id)).filter(Boolean));
    const seenComposite = new Set(cur.map(compositeKey));

    let added = 0, skipped = 0;
    const now = Date.now();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rec = {
        _id: `corp_card_${now}_${i}_${Math.random().toString(36).slice(2, 9)}`,
        use_date:       str(r.use_date).slice(0, 10),
        card_alias:     str(r.card_alias),
        card_no:        str(r.card_no),
        merchant:       str(r.merchant),
        billing_amount: num(r.billing_amount),
        memo:           str(r.memo),
        approval_id:    str(r.approval_id),
      };
      if (!rec.use_date || rec.billing_amount <= 0) { skipped++; continue; }
      if (rec.approval_id && seenApproval.has(rec.approval_id)) { skipped++; continue; }
      const ck = compositeKey(rec);
      if (seenComposite.has(ck)) { skipped++; continue; }   // 수기 업로드분과 중복
      cur.push(rec);
      if (rec.approval_id) seenApproval.add(rec.approval_id);
      seenComposite.add(ck);
      added++;
    }

    cur.sort((a, b) => String(b.use_date || '').localeCompare(String(a.use_date || '')));  // 최신순(대시보드와 동일)

    const put = await fetch(`${SUPABASE_URL}/rest/v1/cat_data?on_conflict=key`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify([{ key: 'corp_card_tx_data', data: cur }]),
    });
    if (!put.ok) throw new Error(`cat_data 저장 실패: ${put.status} ${(await put.text()).slice(0, 200)}`);

    return json({ ok: true, added, skipped, total: cur.length });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});

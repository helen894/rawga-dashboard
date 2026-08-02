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
 *
 * ⚠ 복합키는 **approval_id 없는 행에만** 적용한다.
 *   같은 날 같은 카드로 같은 가맹점에서 같은 금액을 두 번 긁는 일이 실제로 있다
 *   (하이파킹 132,000×2, 법원행정처 6,000×2 …). 이건 approval_id 가 다른 별개 거래인데
 *   복합키를 전체에 걸면 뒤 건이 중복으로 버려진다 — 2026-07 적재에서 5건 534,900원 누락.
 *   approval_id 가 있는 행끼리는 1)이 이미 정확히 막으므로 복합키를 볼 이유가 없다.
 *
 * 세 가지 모드:
 *   • 적재  { secret, rows:  [{use_date, card_alias, card_no, merchant, billing_amount, memo, approval_id}] }
 *   • 수정  { secret, patch: [{approval_id, memo}] }
 *   • 별칭 채우기 { secret, aliasFill: {"<card_no>": "<별칭>", ...} }
 *     별칭이 **빈 행에만** 채운다. 매핑 파일을 고쳐도 이미 적재된 행은 그대로라
 *     집계표에서 계속 빠지기 때문(2026-07 기준 2장 85건 3,868,021원 = 금액의 14.2%).
 *     이미 별칭이 있는 행은 건드리지 않는다 — 사람이 손으로 고쳐둔 걸 덮으면 안 된다.
 *     이미 적재된 행의 계정과목(memo)만 고친다. 클로브 memo 가
 *     '프리딕티브AGI: 2027 CES 참가비' 처럼 ':' 앞이 계정과목이 아닌 경우의 교정용.
 *     적재는 중복 차단 때문에 재실행으로 고칠 수 없어서 별도 경로가 필요하다.
 *     행을 새로 만들지 않는다 — 없는 approval_id 는 notFound 로 돌려준다.
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

/* memo → 계정과목: 대시보드 extractCCAccount / 적재 스크립트 acctOf 와 같은 규칙.
   '지급수수료: 구독비' 든 '지급수수료' 든 같은 결과라 patch 호출부가 어느 쪽을 보내도 된다. */
const acctOf = (v: unknown) => {
  const s = str(v);
  if (!s) return '미분류';
  return (s.includes(':') ? s.slice(0, s.indexOf(':')) : s).trim() || '미분류';
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ ok: false, error: 'POST only' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'invalid json' }, 400); }
  if (!SECRET || body?.secret !== SECRET) return json({ ok: false, error: 'unauthorized' }, 401);

  const rows  = Array.isArray(body?.rows)  ? body.rows  : [];
  const patch = Array.isArray(body?.patch) ? body.patch : [];
  const aliasFill = (body?.aliasFill && typeof body.aliasFill === 'object' && !Array.isArray(body.aliasFill))
    ? body.aliasFill as Record<string, unknown> : null;
  const modes = [rows.length ? 'rows' : '', patch.length ? 'patch' : '', aliasFill ? 'aliasFill' : ''].filter(Boolean);
  if (modes.length > 1)  return json({ ok: false, error: `모드는 하나만: ${modes.join(', ')}` }, 400);
  if (modes.length === 0) return json({ ok: false, error: 'rows / patch / aliasFill 없음' }, 400);

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

    /* ── 수정 모드 ────────────────────────────────────────────
       읽기가 비었는데 덮어쓰면 전체가 날아간다. 수정은 기존 행이 전제라 여기서 막는다. */
    if (patch.length) {
      if (!cur.length) return json({ ok: false, error: '기존 카드내역이 비어 있어 수정을 중단했습니다' }, 409);

      const want = new Map<string, string>();
      for (const p of patch) {
        const id = str(p?.approval_id);
        if (id) want.set(id, acctOf(p?.memo));
      }
      if (!want.size) return json({ ok: false, error: 'patch 에 approval_id 가 없습니다' }, 400);

      const changes: any[] = [];
      const hit = new Set<string>();
      for (const r of cur) {
        const id = str(r.approval_id);
        if (!id || !want.has(id)) continue;
        hit.add(id);
        const next = want.get(id)!;
        const prev = str(r.memo);
        if (prev === next) continue;              // 이미 그 값 — 재실행해도 안전
        changes.push({ approval_id: id, merchant: str(r.merchant), use_date: str(r.use_date), from: prev, to: next });
        r.memo = next;
      }
      const notFound = [...want.keys()].filter((id) => !hit.has(id));

      if (changes.length) {
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
      }
      return json({ ok: true, mode: 'patch', updated: changes.length, changes, notFound, total: cur.length });
    }

    /* ── 별칭 채우기 모드 ─────────────────────────────────────
       빈 별칭만 채운다. 읽기가 비었으면 patch 와 같은 이유로 중단. */
    if (aliasFill) {
      if (!cur.length) return json({ ok: false, error: '기존 카드내역이 비어 있어 중단했습니다' }, 409);

      const want = new Map<string, string>();
      for (const [no, al] of Object.entries(aliasFill)) {
        const k = str(no), v = str(al);
        if (k && v) want.set(k, v);          // 빈 별칭으로 덮어쓰는 건 의미가 없으니 제외
      }
      if (!want.size) return json({ ok: false, error: 'aliasFill 에 쓸 값이 없습니다' }, 400);

      const filled: Record<string, number> = {};
      let skippedHasAlias = 0;
      // 매핑에 없는 카드번호를 모은다 — 수기 엑셀분은 카드번호 표기가 API와 달라
      // 매핑 키에 안 걸릴 수 있고, 그러면 소급이 조용히 빗나간다. 그걸 눈에 보이게.
      const unmatched = new Map<string, { n: number; blank: number; sum: number; from: string; to: string }>();
      for (const r of cur) {
        const no = str(r.card_no);
        const al = want.get(no);
        if (!al) {
          const d = str(r.use_date).slice(0, 10);
          const e = unmatched.get(no) || { n: 0, blank: 0, sum: 0, from: d, to: d };
          e.n++; e.sum += num(r.billing_amount);
          if (!str(r.card_alias)) e.blank++;
          if (d && (!e.from || d < e.from)) e.from = d;
          if (d && (!e.to   || d > e.to))   e.to   = d;
          unmatched.set(no, e);
          continue;
        }
        if (str(r.card_alias)) { skippedHasAlias++; continue; }   // 이미 있는 별칭은 안 건드린다
        r.card_alias = al;
        filled[al] = (filled[al] || 0) + 1;
      }
      const total = Object.values(filled).reduce((a, b) => a + b, 0);
      const unmatchedList = [...unmatched].map(([card_no, e]) => ({ card_no, ...e })).sort((a, b) => b.n - a.n);

      if (total) {
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
      }
      return json({ ok: true, mode: 'aliasFill', filled: total, byAlias: filled, skippedHasAlias, unmatched: unmatchedList, total: cur.length });
    }

    const seenApproval = new Set(cur.map((r) => str(r.approval_id)).filter(Boolean));
    // 수기 업로드분(approval_id 없음)만 복합키 대상 — 위 주석의 오탈락 방지
    const seenComposite = new Set(cur.filter((r) => !str(r.approval_id)).map(compositeKey));

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
      else seenComposite.add(ck);   // 방금 넣은 승인건까지 복합키에 넣으면 배치 안에서 또 오탈락한다
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

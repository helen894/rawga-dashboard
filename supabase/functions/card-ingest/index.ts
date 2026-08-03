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
 *   • 수정  { secret, patch: [{approval_id | _id, memo?, billing_amount?}] }
 *     선택자는 approval_id 또는 _id. 수기 업로드분은 approval_id 가 없어 _id 로만 잡힌다
 *     (_id 는 inspect 로 확인). 금액 수정은 청구 확정액으로 맞출 때 쓴다.
 *   • 조회 { secret, inspect: { approvalIds?: [...], from?, to?, cardNo?, merchant? } }
 *     저장된 행을 그대로 돌려준다. 쓰기 없음. RLS 때문에 cat_data 를 직접 못 읽어서
 *     '지금 계정과목이 뭔지' 확인할 방법이 없었고, 그 탓에 값을 확인하지 않고 덮어써
 *     사람이 지정한 분류를 지운 적이 있다(2026-08-02). 그걸 막기 위한 최소 조회 경로.
 *   • 기간 지정 별칭 { secret, aliasRange: [{card_no, from, to, card_alias}], dryRun?: boolean }
 *     카드 1장이 기간에 따라 다른 열에 귀속되는 예외를 표현한다. aliasFill 은 카드 단위라
 *     이런 예외를 못 담는다(2026-06 에 비씨카드(김현민) 사용분을 SO 로 처리한 사례).
 *     dryRun:true 면 대상 건수와 옛 별칭 분포만 돌려주고 저장하지 않는다 — 먼저 이걸로 확인할 것.
 *   • 별칭 채우기 { secret, aliasFill: {"<card_no>": "<별칭>", ...}, overwrite?: boolean }
 *     기본은 별칭이 **빈 행에만** 채운다. 매핑 파일을 고쳐도 이미 적재된 행은 그대로라
 *     집계표에서 계속 빠지기 때문(2026-07 기준 2장 85건 3,868,021원 = 금액의 14.2%).
 *     이미 별칭이 있는 행은 건드리지 않는다 — 사람이 손으로 고쳐둔 걸 덮으면 안 된다.
 *     overwrite:true 면 기존 별칭도 덮는다(표기 규칙을 바꿔 과거분까지 통일할 때).
 *     ⚠ 되돌릴 수 없다. 변경 전 값은 응답의 byRewrite 에 '옛값 → 새값' 집계로만 남고
 *       어느 행이었는지는 못 찾는다.
 *     ⚠ 이 매핑은 '카드 1장 = 별칭 1개'를 전제한다. 실제 데이터는 같은 카드에 다른 별칭이
 *       붙어 있을 수 있고(2026-08-02 실행 시 330건 중 72건이 그랬다), 그런 행은 덮어쓰기로
 *       **집계표 열이 바뀐다** — 표기 통일이 아니라 귀속 변경이다.
 *       overwrite 를 쓰기 전에 대상 카드들의 기존 별칭이 균일한지 반드시 먼저 확인할 것.
 *       (지금은 매핑에 없는 카드만 unmatched[].aliases 로 보여준다 — 매칭되는 카드도
 *        같이 보여주도록 고치는 게 맞다.)
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
  const aliasRange = Array.isArray(body?.aliasRange) ? body.aliasRange : [];
  const inspect = (body?.inspect && typeof body.inspect === 'object' && !Array.isArray(body.inspect))
    ? body.inspect as Record<string, unknown> : null;
  const modes = [rows.length ? 'rows' : '', patch.length ? 'patch' : '', aliasFill ? 'aliasFill' : '',
    aliasRange.length ? 'aliasRange' : '', inspect ? 'inspect' : ''].filter(Boolean);
  if (modes.length > 1)  return json({ ok: false, error: `모드는 하나만: ${modes.join(', ')}` }, 400);
  if (modes.length === 0) return json({ ok: false, error: 'rows / patch / aliasFill / aliasRange 없음' }, 400);

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

      /* 선택자는 approval_id('a:') 또는 _id('i:'). 수기 업로드분은 approval_id 가 없어
         _id 로만 잡을 수 있다. 지정한 필드만 바꾸고 나머지는 건드리지 않는다. */
      const want = new Map<string, { memo?: string; billing_amount?: number }>();
      for (const p of patch) {
        const aid = str(p?.approval_id), rid = str(p?._id);
        const key = aid ? 'a:' + aid : (rid ? 'i:' + rid : '');
        if (!key) continue;
        const spec: { memo?: string; billing_amount?: number } = {};
        if (p?.memo !== undefined && p?.memo !== null) spec.memo = acctOf(p.memo);
        if (p?.billing_amount !== undefined && p?.billing_amount !== null) {
          const v = num(p.billing_amount);
          if (v <= 0) return json({ ok: false, error: `billing_amount 는 0보다 커야 합니다 (${key})` }, 400);
          spec.billing_amount = v;
        }
        if (!Object.keys(spec).length) continue;
        want.set(key, spec);
      }
      if (!want.size) return json({ ok: false, error: 'patch 에 선택자(approval_id/_id)나 바꿀 필드가 없습니다' }, 400);

      const changes: any[] = [];
      const hit = new Set<string>();
      for (const r of cur) {
        const aid = str(r.approval_id), rid = str(r._id);
        const key = (aid && want.has('a:' + aid)) ? 'a:' + aid : ((rid && want.has('i:' + rid)) ? 'i:' + rid : '');
        if (!key) continue;
        hit.add(key);
        const spec = want.get(key)!;
        const diff: any = {};
        if (spec.memo !== undefined && str(r.memo) !== spec.memo) { diff.memo = { from: str(r.memo), to: spec.memo }; r.memo = spec.memo; }
        if (spec.billing_amount !== undefined && num(r.billing_amount) !== spec.billing_amount) {
          diff.billing_amount = { from: num(r.billing_amount), to: spec.billing_amount };
          r.billing_amount = spec.billing_amount;
        }
        if (!Object.keys(diff).length) continue;   // 이미 그 값 — 재실행해도 안전
        changes.push({ key, merchant: str(r.merchant), use_date: str(r.use_date), ...diff });
      }
      const notFound = [...want.keys()].filter((k) => !hit.has(k));

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

    /* ── 조회 모드 (읽기 전용) ─────────────────────────────── */
    if (inspect) {
      const ids = new Set((Array.isArray(inspect.approvalIds) ? inspect.approvalIds : []).map((v) => str(v)));
      const from = str(inspect.from), to = str(inspect.to);
      const cardNo = str(inspect.cardNo), merchant = str(inspect.merchant);
      const hit = cur.filter((r) => {
        if (ids.size && !ids.has(str(r.approval_id))) return false;
        const d = str(r.use_date).slice(0, 10);
        if (from && d < from) return false;
        if (to && d > to) return false;
        if (cardNo && str(r.card_no) !== cardNo) return false;
        if (merchant && !str(r.merchant).includes(merchant)) return false;
        return true;
      }).map((r) => ({
        _id: str(r._id),                                  // patch 의 _id 선택자로 쓴다
        approval_id: str(r.approval_id), use_date: str(r.use_date).slice(0, 10),
        card_alias: str(r.card_alias), card_no: str(r.card_no),
        merchant: str(r.merchant), billing_amount: num(r.billing_amount), memo: str(r.memo),
      })).sort((a, b) => b.use_date.localeCompare(a.use_date));
      return json({ ok: true, mode: 'inspect', matched: hit.length, rows: hit.slice(0, 500), total: cur.length });
    }

    /* ── 기간 지정 별칭 모드 ───────────────────────────────────
       card_no + use_date 범위로 행을 골라 별칭을 지정한다. 카드 단위 매핑으로는
       담을 수 없는 '이 카드의 이 기간만 다른 열' 예외용. dryRun 이면 저장하지 않는다. */
    if (aliasRange.length) {
      if (!cur.length) return json({ ok: false, error: '기존 카드내역이 비어 있어 중단했습니다' }, 409);
      const dryRun = body?.dryRun === true;

      const specs = aliasRange.map((s: any) => ({
        card_no: str(s?.card_no), from: str(s?.from), to: str(s?.to), card_alias: str(s?.card_alias),
      })).filter((s) => s.card_no && s.from && s.to && s.card_alias);
      if (!specs.length) return json({ ok: false, error: 'aliasRange 항목에 card_no/from/to/card_alias 가 모두 필요합니다' }, 400);

      const results = specs.map((s) => ({ ...s, matched: 0, changed: 0, fromAlias: {} as Record<string, number> }));
      for (const r of cur) {
        const no = str(r.card_no), d = str(r.use_date).slice(0, 10);
        for (let i = 0; i < specs.length; i++) {
          const s = specs[i];
          if (no !== s.card_no || d < s.from || d > s.to) continue;
          const res = results[i];
          res.matched++;
          const old = str(r.card_alias) || '(빈값)';
          res.fromAlias[old] = (res.fromAlias[old] || 0) + 1;
          if (str(r.card_alias) !== s.card_alias) { res.changed++; if (!dryRun) r.card_alias = s.card_alias; }
          break;   // 한 행은 첫 번째로 맞는 spec 에만 귀속
        }
      }
      const changed = results.reduce((a, b) => a + b.changed, 0);

      if (!dryRun && changed) {
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
      return json({ ok: true, mode: 'aliasRange', dryRun, changed, results, total: cur.length });
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

      const overwrite = body?.overwrite === true;
      const filled: Record<string, number> = {};
      const rewritten: Record<string, number> = {};   // 기존 별칭을 덮은 건수 ('옛값→새값')
      let skippedHasAlias = 0, unchanged = 0;
      // 매핑에 없는 카드번호를 모은다 — 수기 엑셀분은 카드번호 표기가 API와 달라
      // 매핑 키에 안 걸릴 수 있고, 그러면 소급이 조용히 빗나간다. 그걸 눈에 보이게.
      const unmatched = new Map<string, { n: number; blank: number; sum: number; from: string; to: string; aliases: Set<string> }>();
      for (const r of cur) {
        const no = str(r.card_no);
        const al = want.get(no);
        if (!al) {
          const d = str(r.use_date).slice(0, 10);
          const e = unmatched.get(no) || { n: 0, blank: 0, sum: 0, from: d, to: d, aliases: new Set<string>() };
          e.n++; e.sum += num(r.billing_amount);
          const a = str(r.card_alias);
          if (!a) e.blank++; else e.aliases.add(a);
          if (d && (!e.from || d < e.from)) e.from = d;
          if (d && (!e.to   || d > e.to))   e.to   = d;
          unmatched.set(no, e);
          continue;
        }
        const curAlias = str(r.card_alias);
        if (curAlias) {
          if (!overwrite) { skippedHasAlias++; continue; }        // 기본: 있는 별칭은 안 건드린다
          if (curAlias === al) { unchanged++; continue; }         // 이미 새 값이면 쓸 것도 없다
          const k = `${curAlias} → ${al}`;
          rewritten[k] = (rewritten[k] || 0) + 1;
          r.card_alias = al;
          continue;
        }
        r.card_alias = al;
        filled[al] = (filled[al] || 0) + 1;
      }
      const nFilled = Object.values(filled).reduce((a, b) => a + b, 0);
      const nRewritten = Object.values(rewritten).reduce((a, b) => a + b, 0);
      const total = nFilled + nRewritten;   // 저장이 필요한 변경 건수
      const unmatchedList = [...unmatched]
        .map(([card_no, e]) => ({ ...e, card_no, aliases: [...e.aliases] }))
        .sort((a, b) => b.n - a.n);

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
      return json({
        ok: true, mode: 'aliasFill', overwrite,
        filled: nFilled, byAlias: filled,
        rewritten: nRewritten, byRewrite: rewritten,
        skippedHasAlias, unchanged,
        unmatched: unmatchedList, total: cur.length,
      });
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

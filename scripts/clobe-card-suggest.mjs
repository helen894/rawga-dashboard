#!/usr/bin/env node
/**
 * clobe-card-suggest — 미분류 행을 **이 회사의 과거 라벨 이력**으로 분류한다
 *
 * 사용:
 *   node scripts/clobe-card-suggest.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *                                       [--tier A|B|C] [--apply] [--eval]
 *
 * 예:
 *   node scripts/clobe-card-suggest.mjs --from 2026-08-01                # 이번 달 미분류 제안 보기
 *   node scripts/clobe-card-suggest.mjs --from 2026-08-01 --apply        # B등급 이상 적용
 *   node scripts/clobe-card-suggest.mjs --eval                           # 규칙 정확도 자가측정
 *
 * 왜 이게 필요한가 (2026-08-07):
 *   account-rules.json 은 '식당·카페는 가맹점명만으로 구분 불가' 라고 못박아 뒀다. 맞는 말이지만
 *   그건 **가맹점만** 봤을 때다. 맥도날드가 접대비 9 / 복리후생비 2 로 갈린 것도 '누가 썼냐' 의
 *   차이였다 — 같은 가게라도 박우현 카드로 먹으면 거래처 미팅, SO 공용카드면 팀 식대이고,
 *   그 패턴이 사람마다 일관된다. 그래서 키를 (가맹점 × 카드사용자) 로 잡는다.
 *
 *   키워드 규칙과 달리 **사람이 한 번 정하면 그 다음부터 자동**이라, 쓸수록 커버리지가 오른다.
 *
 * 실측 (--eval, leave-one-out, 라벨 2,660건 / 그중 식음 1,337건):
 *       등급   커버(전체)   정확(전체)   정확(식음)
 *        A       34%        96.0%       91.8%     ← 이것만 자동 적용한다 (기본값)
 *        B        6%        87.1%       81.8%     ← 기존 식음 규칙(78%)과 큰 차이 없음. 제안만.
 *        C       16%        84.6%       78.7%     ← 제안만.
 *   B·C 를 자동 적용하지 않는 이유는 account-rules.json _why_not_auto 와 같다 —
 *   그럴듯한 계정과목으로 틀리면 눈에 안 띄어 그대로 묻힌다.
 *
 * 한계 (반드시 알고 쓸 것):
 *   - 이력이 없는 신규 가맹점은 원리적으로 못 푼다. 첫 건은 사람이 정해야 한다(판정불가 45%).
 *   - PG사(KCP·이니시스·NICE 등)는 가맹점명이 결제대행사로만 찍혀 실체가 안 보인다.
 *     이력도 뒤섞여 있어(KCP 김현민: 지급수수료3/접대비3/여비2) 아예 제안하지 않는다.
 *   - A등급도 25건 중 1건은 틀린다. 금액 큰 건은 눈으로 확인할 것.
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const EVAL = argv.includes('--eval');
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
/* 기본 A — B·C 는 정확도가 기존 규칙 수준이라 자동 적용하지 않는다(위 실측표 참고).
   그래도 밀어붙이려면 --tier B. 화면에는 등급과 무관하게 전부 보여준다. */
const TIER_MIN = (flag('--tier') || 'A').toUpperCase();

const EDGE = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/card-ingest';
const SECRET_FILE = 'C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret';
/* Edge 게이트웨이가 verify_jwt=true 라 Authorization 헤더 필요(없으면 401).
   index.html 에 이미 박혀 배포되는 공개 publishable 키라 비밀이 아니다. */
const SUPA_PUBLISHABLE_KEY = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const secret = readFileSync(SECRET_FILE, 'utf8').trim();

const won = (n) => Number(n || 0).toLocaleString('ko-KR');
const acctOf = (s) => { const t = String(s || '').trim(); if (!t) return '미분류'; return (t.includes(':') ? t.slice(0, t.indexOf(':')) : t).trim() || '미분류'; };
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ');

/* PG사 — 가맹점명이 결제대행사로만 찍혀 실체가 안 보이는 것들. 제안 대상에서 뺀다.
   account-rules.json _subscription_note 가 같은 이유로 71건을 손대지 않고 둔 것과 같은 원칙. */
const PG_MERCHANTS = ['KCP', '이니시스', 'NICE결제', '나이스페이', '스마트로', 'Adyen', '자동결제',
  '전자지급결제', '페이먼츠', '인터넷상거래', '통신판매'];
const isPG = (m) => PG_MERCHANTS.some(p => m.includes(p));

async function fetchRows(body) {
  const res = await fetch(EDGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPA_PUBLISHABLE_KEY, Authorization: `Bearer ${SUPA_PUBLISHABLE_KEY}` },
    body: JSON.stringify({ secret, ...body }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.ok === false) {
    console.error(`\n조회 실패 (HTTP ${res.status}):`, JSON.stringify(out).slice(0, 300));
    process.exit(3);
  }
  return out;
}

/* Edge 가 rows 를 500 에서 자르므로 월 단위로 나눠 받는다 */
async function fetchAll() {
  const now = new Date();
  const out = [];
  for (let y = 2025; y <= now.getUTCFullYear(); y++) {
    for (let m = 1; m <= 12; m++) {
      if (y === now.getUTCFullYear() && m > now.getUTCMonth() + 1) break;
      const mm = String(m).padStart(2, '0');
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const r = await fetchRows({ inspect: { from: `${y}-${mm}-01`, to: `${y}-${mm}-${last}` } });
      if ((r.rows || []).length >= 500 && r.matched > r.rows.length) {
        console.error(`⚠ ${y}-${mm} 이 500건에서 잘렸습니다 — 이력이 불완전합니다.`);
        process.exit(3);
      }
      out.push(...(r.rows || []));
    }
  }
  const seen = new Map();
  for (const r of out) seen.set(String(r.approval_id || r._id), r);
  return [...seen.values()].map(r => ({
    id: r.approval_id || '', _id: r._id, date: r.use_date,
    merchant: norm(r.merchant), alias: norm(r.card_alias),
    acct: acctOf(r.memo), amt: Number(r.billing_amount || 0),
  }));
}

/* ── 이력 색인 ────────────────────────────────────────────────
   키는 (가맹점 × 카드사용자). 사용자 이력이 없을 때만 가맹점 전체로 물러난다. */
const keyMA = (r) => r.merchant + '\u0000' + r.alias;
function buildIndex(labeled) {
  const ma = new Map(), m = new Map();
  for (const r of labeled) {
    for (const [map, k] of [[ma, keyMA(r)], [m, r.merchant]]) {
      if (!map.has(k)) map.set(k, {});
      map.get(k)[r.acct] = (map.get(k)[r.acct] || 0) + 1;
    }
  }
  return { ma, m };
}
const vote = (c) => {
  const e = Object.entries(c || {}).sort((a, b) => b[1] - a[1]);
  if (!e.length) return null;
  const tot = e.reduce((a, x) => a + x[1], 0);
  return { acct: e[0][0], n: e[0][1], tot, purity: e[0][1] / tot };
};

/* 등급 — 실측 정확도는 --eval 로 재확인할 것
   A: 가맹점+사용자 이력 3건 이상, 순도 90% 이상
   B: 가맹점+사용자 이력 2건 이상, 순도 90% 이상
   C: 가맹점+사용자 이력 1건  또는  사용자 이력 없이 가맹점 전체 3건 이상 순도 90% 이상 */
function classify(r, idx, exclude = null) {
  const drop = (c) => {   // leave-one-out: 자기 자신 1표를 뺀다
    if (!exclude || !c) return c;
    const cc = { ...c };
    if (cc[exclude] > 1) cc[exclude]--; else delete cc[exclude];
    return Object.keys(cc).length ? cc : null;
  };
  const a = vote(drop(idx.ma.get(keyMA(r))));
  const b = vote(drop(idx.m.get(r.merchant)));

  /* A등급은 PG사라도 인정한다. '이니시스_취급수수료/(주)여기어때컴퍼니' 처럼 PG 이름 뒤에
     실제 가맹점이 붙어 나오는 경우가 있고, 그 조합이 3건 이상 한 계정과목으로 수렴했다면
     이름이 안 보여도 이력 자체가 직접 증거다. */
  if (a && a.purity >= 0.9 && a.tot >= 3) return { acct: a.acct, tier: 'A', why: `${r.alias} 이력 ${a.n}/${a.tot}` };

  /* 그 아래 등급에서는 PG사를 포기한다 — 가맹점명이 결제대행사로만 찍혀 실체가 안 보이는데
     이력까지 얕으면 근거가 없다(KCP 김현민: 지급수수료3/접대비3/여비2). */
  if (isPG(r.merchant)) return { abstain: 'PG', detail: a || b };

  if (a && a.purity >= 0.9 && a.tot >= 2) return { acct: a.acct, tier: 'B', why: `${r.alias} 이력 ${a.n}/${a.tot}` };
  if (a && a.tot === 1) return { acct: a.acct, tier: 'C', why: `${r.alias} 이력 1건` };
  if (b && b.tot >= 3 && b.purity >= 0.9) return { acct: b.acct, tier: 'C', why: `가맹점 전체 ${b.n}/${b.tot}` };

  /* 이력이 아예 없는 것과 있는데 갈리는 것은 다르다 — 사람이 볼 때 판단이 달라진다 */
  if (b) return { abstain: 'MIXED', detail: b };
  return { abstain: 'NONE' };
}

const rows = await fetchAll();
const labeled = rows.filter(r => r.merchant && r.acct !== '미분류');
const idx = buildIndex(labeled);

/* ── --eval : leave-one-out 자가측정 ────────────────────────── */
if (EVAL) {
  const FOOD = new Set(['복리후생비', '업무추진비(접대비)']);
  console.log(`=== 규칙 자가측정 (leave-one-out) — 라벨 ${labeled.length}건 ===\n`);
  for (const [name, pool] of [['전체', labeled], ['식음만(복리후생비·접대비)', labeled.filter(r => FOOD.has(r.acct))]]) {
    const st = {};
    for (const r of pool) {
      const g = classify(r, idx, r.acct);
      const t = g.tier || '판정불가';
      st[t] = st[t] || { n: 0, hit: 0 };
      st[t].n++; if (g.acct === r.acct) st[t].hit++;
    }
    console.log(`  [${name}] ${pool.length}건`);
    let cum = 0, cumHit = 0;
    for (const t of ['A', 'B', 'C']) {
      const s = st[t] || { n: 0, hit: 0 };
      cum += s.n; cumHit += s.hit;
      console.log(`    ${t}등급  ${String(s.n).padStart(5)}건  정확 ${s.n ? (s.hit / s.n * 100).toFixed(1).padStart(5) : '    -'}%   (누적 ${String(cum).padStart(5)}건 커버 ${(cum / pool.length * 100).toFixed(0).padStart(3)}% 정확 ${(cumHit / cum * 100).toFixed(1)}%)`);
    }
    console.log(`    판정불가 ${String((st['판정불가'] || { n: 0 }).n).padStart(4)}건\n`);
  }
  process.exit(0);
}

/* ── 미분류 행에 제안 ──────────────────────────────────────── */
const from = flag('--from'), to = flag('--to');
let un = rows.filter(r => r.acct === '미분류');
if (from) un = un.filter(r => r.date >= from);
if (to) un = un.filter(r => r.date <= to);
un.sort((a, b) => b.date.localeCompare(a.date));

const RANK = { A: 3, B: 2, C: 1 };
const picked = [], skipped = [];
for (const r of un) {
  const g = classify(r, idx);
  if (g.tier && RANK[g.tier] >= RANK[TIER_MIN]) picked.push({ r, g });
  else skipped.push({ r, g });
}

console.log(`=== 이력 기반 계정과목 제안 — 미분류 ${un.length}건 ${won(un.reduce((a, x) => a + x.amt, 0))}원 ===`);
console.log(`    이력 ${labeled.length}건 학습 · ${TIER_MIN}등급 이상 적용\n`);

const ACC = { A: '96.0%', B: '87.1%', C: '84.6%' };   // --eval 실측(전체). 식음만 보면 각각 91.8/81.8/78.7%
for (const t of ['A', 'B', 'C']) {
  const g = [...picked, ...skipped].filter(x => x.g.tier === t);
  if (!g.length) continue;
  const on = RANK[t] >= RANK[TIER_MIN];
  console.log(`  [${t}등급] ${g.length}건 ${won(g.reduce((a, x) => a + x.r.amt, 0))}원 · 실측 정확 ${ACC[t]} · ${on ? '적용 대상' : '제안만(보류)'}`);
  for (const { r, g: s } of g)
    console.log(`     ${r.date}  ${won(r.amt).padStart(10)}원  ${r.merchant.slice(0, 24).padEnd(26)} → 「${s.acct}」  ${s.why}`);
  console.log('');
}
const none = skipped.filter(x => !x.g.tier);
if (none.length) {
  console.log(`  [판정불가] ${none.length}건 ${won(none.reduce((a, x) => a + x.r.amt, 0))}원 — 사람이 정해야 합니다`);
  const dist = (d) => d ? `최빈 ${d.acct} ${d.n}/${d.tot}` : '';
  for (const { r, g } of none) {
    const d = g.detail;
    const why = g.abstain === 'PG' ? 'PG사 — 실체 불명'
      // 순도 100% 인데 표가 얕은 것과 실제로 갈리는 것은 사람이 볼 때 판단이 다르다
      : g.abstain !== 'MIXED' ? '이력 없음 — 신규 가맹점'
      : d.purity >= 0.9 ? `이 사용자 이력 없음 · 가맹점 이력 ${d.tot}건뿐 — ${dist(d)}`
      : `이력이 갈림 — ${dist(d)}`;
    console.log(`     ${r.date}  ${won(r.amt).padStart(10)}원  ${r.merchant.slice(0, 24).padEnd(26)} (${why})`);
  }
  console.log('');
}
if (skipped.length) {
  console.log('  ↑ 보류·판정불가 건을 사람이 정하면, 그 값이 다음부터 이력이 되어 자동 분류됩니다.');
  console.log('     node scripts/clobe-card-patch.mjs <approval_id> <계정과목> ...\n');
}

if (!picked.length) { console.log('적용할 제안이 없습니다.'); process.exit(0); }
if (!APPLY) {
  console.log(`[미리보기] 저장하지 않았습니다. 맞으면 --apply 를 붙이세요 (${picked.length}건 적용 예정).`);
  process.exit(0);
}

/* ── 적용 ─────────────────────────────────────────────────── */
/* 선택자는 approval_id 와 _id 중 하나만 보낸다(clobe-card-patch 와 동일 규칙).
   수기 엑셀 업로드분은 approval_id 가 비어 있어 _id 로 가리켜야 한다. */
const patch = picked.map(({ r, g }) => ({ ...(r.id ? { approval_id: String(r.id) } : { _id: r._id }), memo: g.acct }));
const res = await fetchRows({ patch });
console.log(`적용 완료 — 변경 ${res.updated}건 / 카드내역 총 ${res.total}건`);
for (const c of res.changes || [])
  if (c.memo) console.log(`  ${c.use_date}  ${c.merchant}  「${c.memo.from}」 → 「${c.memo.to}」`);
if (res.notFound?.length) console.error(`\n⚠ 없는 선택자: ${res.notFound.join(', ')}`);

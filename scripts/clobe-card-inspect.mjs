#!/usr/bin/env node
/**
 * clobe-card-inspect — 적재된 법인카드 행(corp_card_tx_data) 조회 (읽기 전용)
 *
 * 사용:
 *   node scripts/clobe-card-inspect.mjs [approval_id ...]
 *                                       [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *                                       [--merchant 가맹점조각] [--card-no 490298******1187]
 *                                       [--alias 별칭조각] [--unclassified] [--by-account]
 *
 * 예:
 *   node scripts/clobe-card-inspect.mjs 29561212                       # 특정 승인건의 현재 계정과목 확인
 *   node scripts/clobe-card-inspect.mjs --from 2026-08-01 --unclassified   # 이번 달 미분류만 (월말 정리용)
 *   node scripts/clobe-card-inspect.mjs --from 2026-07-01 --to 2026-07-31 --by-account
 *
 * 왜 따로 있나:
 *   clobe-card-patch 는 고치기만 하고 현재 값을 못 보여준다. 클로브에서 memo 를 채워도
 *   이미 적재된 행은 안 바뀌므로(ingest 가 approval_id 중복을 차단), 무엇이 아직 미분류인지
 *   확인할 경로가 필요하다. 여기서 얻은 approval_id / _id 를 그대로 clobe-card-patch 에 넘긴다.
 *
 * 계정과목은 memo 의 ':' 앞이다(대시보드 extractCCAccount 와 동일). Edge 가 저장할 때
 * 이미 잘라 넣지만, 수기 업로드분은 전체 memo 가 남아 있을 수 있어 여기서도 같은 규칙을 쓴다.
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const UNCLASSIFIED = argv.includes('--unclassified');
const BY_ACCOUNT = argv.includes('--by-account');

const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const FLAG_NAMES = ['--from', '--to', '--merchant', '--card-no', '--alias'];
// 플래그와 그 값을 걷어내고 남은 것이 approval_id 들
const approvalIds = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { if (FLAG_NAMES.includes(a) && argv[i + 1] && !argv[i + 1].startsWith('--')) i++; continue; }
  approvalIds.push(a);
}

const EDGE = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/card-ingest';
const SECRET_FILE = 'C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret';
/* Edge 게이트웨이가 verify_jwt=true 라 Authorization 헤더 필요(없으면 401).
   index.html 에 이미 박혀 배포되는 공개 publishable 키라 비밀이 아니다. */
const SUPA_PUBLISHABLE_KEY = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';

const won = (n) => Number(n || 0).toLocaleString('ko-KR');
/* memo '계정과목: 세부' → 계정과목, 빈값 → 미분류 (extractCCAccount 와 동일 규칙) */
const acctOf = (s) => {
  const t = String(s || '').trim();
  if (!t) return '미분류';
  return (t.includes(':') ? t.slice(0, t.indexOf(':')) : t).trim() || '미분류';
};

const inspect = {};
if (approvalIds.length) inspect.approvalIds = approvalIds;
if (flag('--from')) inspect.from = flag('--from');
if (flag('--to')) inspect.to = flag('--to');
if (flag('--merchant')) inspect.merchant = flag('--merchant');
if (flag('--card-no')) inspect.cardNo = flag('--card-no');

const secret = readFileSync(SECRET_FILE, 'utf8').trim();
const res = await fetch(EDGE, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    apikey: SUPA_PUBLISHABLE_KEY,
    Authorization: `Bearer ${SUPA_PUBLISHABLE_KEY}`,
  },
  body: JSON.stringify({ secret, inspect }),
});
const out = await res.json().catch(() => ({}));
if (!res.ok || out.ok === false) {
  console.error(`\n조회 실패 (HTTP ${res.status}):`, JSON.stringify(out).slice(0, 400));
  process.exit(3);
}

/* Edge 가 지원하지 않는 필터는 여기서 건다 — 별칭 부분일치, 미분류만 */
const aliasQ = flag('--alias');
let rows = out.rows || [];
if (aliasQ) rows = rows.filter(r => String(r.card_alias || '').includes(aliasQ));
if (UNCLASSIFIED) rows = rows.filter(r => acctOf(r.memo) === '미분류');

const sum = rows.reduce((a, r) => a + Number(r.billing_amount || 0), 0);
const head = [
  UNCLASSIFIED ? '미분류' : null,
  aliasQ ? `별칭~${aliasQ}` : null,
].filter(Boolean).join(' · ');
console.log(`=== 법인카드 조회${head ? ` (${head})` : ''} — ${rows.length}건 ${won(sum)}원 / 총 ${out.total}건 ===`);

/* Edge 는 rows 를 500건에서 자른다 — 잘렸으면 기간을 좁히라고 알린다 */
if ((out.rows || []).length >= 500 && out.matched > (out.rows || []).length) {
  console.error(`⚠ 조건에 ${out.matched}건이 맞지만 500건만 받았습니다 — --from/--to 로 좁히세요.`);
}

for (const r of rows) {
  console.log(`  ${r.use_date}  ${won(r.billing_amount).padStart(11)}원  ${r.merchant}`);
  console.log(`      계정과목「${acctOf(r.memo)}」  ${r.card_alias || '(별칭없음)'}  approval_id=${r.approval_id || '-'}  _id=${r._id}`);
}

if (BY_ACCOUNT) {
  const agg = {};
  for (const r of rows) {
    const k = acctOf(r.memo);
    if (!agg[k]) agg[k] = { n: 0, sum: 0 };
    agg[k].n++; agg[k].sum += Number(r.billing_amount || 0);
  }
  console.log('\n계정과목별');
  for (const [k, v] of Object.entries(agg).sort((a, b) => b[1].sum - a[1].sum)) {
    console.log(`  ${k.padEnd(20)} ${String(v.n).padStart(4)}건  ${won(v.sum).padStart(13)}원`);
  }
}

if (UNCLASSIFIED && rows.length) {
  console.log(`\n교정은: node scripts/clobe-card-patch.mjs ${rows.slice(0, 5).map(r => `${r.approval_id || `i:${r._id}`} <계정과목>`).join(' ')}${rows.length > 5 ? ' ...' : ''}`);
}

/* process.exit(0) 로 끊으면 fetch 의 keep-alive 소켓이 닫히는 중에
   libuv assertion(win/async.c:94)으로 죽어 종료코드 127 이 나온다 — 정상 반환시킨다. */
process.exitCode = 0;

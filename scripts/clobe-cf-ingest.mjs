#!/usr/bin/env node
/**
 * clobe-cf-ingest — 클로브 거래내역(JSON) → 검증 → cf_data 적재
 *
 * 사용:
 *   node scripts/clobe-cf-ingest.mjs <clobe.json> [--dry-run] [--allow-today] [--fx-ref <원/USD>]
 *                                    [--fx-accounts <id[:통화],...>] [--allow-large-cancel]
 *
 * <clobe.json> 은 클로브 MCP `get_labeled_transactions` 응답을 그대로 저장한 파일.
 * 여러 페이지면 { content:[...], totalElements } 를 합쳐도 되고, 배열로 담아도 된다.
 *
 * ⚠⚠ **검증 로직은 이 파일에 없다.** `supabase/functions/cf-clobe-ingest/clobe-validate.mjs`
 *   가 단일 출처이고, Edge 함수도 **같은 파일**을 쓴다(2026-11-13 클라우드 이전 작업).
 *   여기는 I/O 만 한다: 인자 파싱 · 파일 읽기 · 캐시 · 출력 · 적재 POST.
 *   검증 규칙을 고칠 일이 있으면 그 모듈을 고칠 것 — 여기 복사해 오면 로컬과 클라우드가 갈린다.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { validateClobe } from '../supabase/functions/cf-clobe-ingest/clobe-validate.mjs';

const args = process.argv.slice(2);
/* 값을 받는 옵션은 먼저 걷어낸다 — 안 그러면 "--fx-ref 1433.6" 의 값이 파일 인자로 오인된다 */
const takeOpt = name => {
  const i = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return null;
  const a = args[i];
  if (a.includes('=')) { args.splice(i, 1); return a.slice(a.indexOf('=') + 1); }
  const v = args[i + 1] ?? null;
  args.splice(i, 2);
  return v;
};
const FX_REF_ARG = takeOpt('fx-ref');
const FX_ACC_ARG = takeOpt('fx-accounts');
const EMIT_JSON = takeOpt('emit-json');          // 동치 테스트용 — 판정·행을 파일로 덤프
const file = args.find(a => !a.startsWith('--'));
const DRY = args.includes('--dry-run');
const ALLOW_TODAY = args.includes('--allow-today');
const ALLOW_LARGE_CANCEL = args.includes('--allow-large-cancel');
if (!file) {
  console.error('사용법: node scripts/clobe-cf-ingest.mjs <clobe.json> [--dry-run] [--allow-today]');
  console.error('           [--fx-ref <원/USD>] [--fx-accounts <id[:통화],...>] [--allow-large-cancel]');
  process.exit(1);
}

const EDGE = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
const SECRET_FILE = 'C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret';
/* 이 함수는 verify_jwt=true 로 배포돼 있어 게이트웨이가 키를 요구한다. 아래는 index.html 에
 * 이미 박혀 브라우저로 배포되는 공개 publishable 키라 비밀이 아니다 — 실제 인증은 본문 secret. */
const SUPA_PUBLISHABLE_KEY = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const FX_ACC_CACHE = 'C:/Users/RAWGA/AppData/Local/rawga/fx-accounts.json';
const FX_REF_CACHE = 'C:/Users/RAWGA/AppData/Local/rawga/fx-ref-rate.json';

const won = n => Math.round(n).toLocaleString('ko-KR');
const todayKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const today = todayKST();

/* ── 외화계좌 화이트리스트: 인자 → 캐시 ─────────────────────── */
const parseFxAccounts = s => {
  const o = {};
  for (const tok of String(s || '').split(',').map(t => t.trim()).filter(Boolean)) {
    const [id, cur] = tok.split(':');
    if (/^\d+$/.test(id)) o[id] = (cur || 'USD').toUpperCase();
  }
  return o;
};
let fxAccounts = parseFxAccounts(FX_ACC_ARG), fxAccSrc = '--fx-accounts';
if (Object.keys(fxAccounts).length) {
  try { writeFileSync(FX_ACC_CACHE, JSON.stringify({ accounts: fxAccounts, savedAt: today }, null, 2)); }
  catch (e) { console.log(`  (외화계좌 목록 캐시 저장 실패 — 검증에는 지장 없음: ${e.message})`); }
} else {
  try {
    const c = JSON.parse(readFileSync(FX_ACC_CACHE, 'utf8'));
    fxAccounts = c?.accounts || {};
    fxAccSrc = `캐시 ${c?.savedAt ?? '날짜불명'}`;
  } catch { fxAccSrc = ''; }
}

/* ── 기준환율: 인자 → 캐시 ──────────────────────────────────── */
let fxRef = Number(FX_REF_ARG) > 0 ? Number(FX_REF_ARG) : 0;
let fxRefAsOf = null;
if (fxRef > 0) {
  fxRefAsOf = today;
  try { writeFileSync(FX_REF_CACHE, JSON.stringify({ rate: fxRef, savedAt: fxRefAsOf }, null, 2)); }
  catch (e) { console.log(`  (기준환율 캐시 저장 실패 — 검증에는 지장 없음: ${e.message})`); }
} else {
  try {
    const c = JSON.parse(readFileSync(FX_REF_CACHE, 'utf8'));
    if (Number(c?.rate) > 0) { fxRef = Number(c.rate); fxRefAsOf = c.savedAt || null; }
  } catch { /* 캐시 없음 — 넓은 밴드로 간다 */ }
}

/* ── 검증 (단일 출처 모듈) ──────────────────────────────────── */
const raw = JSON.parse(readFileSync(file, 'utf8'));
const res = validateClobe({
  pages: raw, fxAccounts, fxRef, fxRefAsOf, today,
  allowToday: ALLOW_TODAY, allowLargeCancel: ALLOW_LARGE_CANCEL,
});
const R = res.report;

console.log('=== 클로브 거래내역 적재 검증 ===');
if (R.rawCount !== undefined) console.log(`원본 행 ${R.rawCount} · dedupe 후 ${R.uniqCount} (중복 제거 ${R.dupRemoved})`);
if (R.totalElements) console.log(`totalElements ${R.totalElements} 대조: ${R.uniqCount === R.totalElements ? 'OK' : '⚠ 불일치 — 페이지 누락 의심'}`);
if (Object.keys(fxAccounts).length) {
  console.log(`외화계좌 화이트리스트 ${Object.entries(fxAccounts).map(([i, c]) => `${i}:${c}`).join(' ')} (${fxAccSrc})`);
}
if (R.resIn !== undefined) {
  console.log('\nAPI 합계 대조 (행 누락 감지)');
  console.log(`  입금  API ${won(R.expIn)} vs 원화계좌 ${won(R.krwIn)} → 잔차 ${won(R.resIn)}${R.fxIn ? ` (외화 ${R.fxIn} 환산분 포함)` : ''}`);
  console.log(`  출금  API ${won(R.expOut)} vs 원화계좌 ${won(R.krwOut)} → 잔차 ${won(R.resOut)}${R.fxOut ? ` (외화 ${R.fxOut} 환산분 포함)` : ''}`);
  if (R.rateBand) console.log(`  환율 허용 밴드 ${R.rateBand[0].toFixed(0)}~${R.rateBand[1].toFixed(0)}원 — ${R.bandNote}`);
}
for (const w of res.warnings) console.log(`⚠ ${w}`);
for (const n of res.notes) console.log(`  ${n}`);

if (EMIT_JSON) {
  try {
    writeFileSync(EMIT_JSON, JSON.stringify({
      abort: res.abort ? res.abort.code : null,
      targetCount: R.targetCount ?? 0,
      byDate: R.byDate ?? {},
      rows: res.rows,
    }, null, 2));
  } catch (e) { console.log(`  (emit-json 실패: ${e.message})`); }
}

if (res.abort) {
  console.error(`\n⚠ ${res.abort.message}`);
  if (res.abort.detail) console.error(`   ${JSON.stringify(res.abort.detail)}`);
  if (!DRY) { console.error('적재를 중단합니다.'); process.exit(2); }
  console.log('[dry-run] 중단 조건이지만 dry-run 이라 계속 표시합니다.');
}

/* ── 일자별 검증표 ──────────────────────────────────────────── */
console.log('\n일자별 (적재 대상, 외화는 원화환산 포함)');
let sumIn = 0, sumOut = 0;
for (const d of Object.keys(R.byDate || {}).sort()) {
  const b = R.byDate[d]; sumIn += b.in; sumOut += b.out;
  console.log(`  ${d}  ${String(b.n).padStart(3)}건   입금 ${won(b.in).padStart(15)}   출금 ${won(b.out).padStart(15)}   순 ${won(b.in - b.out).padStart(15)}`);
}
console.log(`  합계        ${String(res.rows.length).padStart(3)}건   입금 ${won(sumIn).padStart(15)}   출금 ${won(sumOut).padStart(15)}   순 ${won(sumIn - sumOut).padStart(15)}`);

if (DRY) { console.log(`\n[dry-run] 적재하지 않았습니다. 대상 ${res.rows.length}건.`); process.exit(0); }

/* ── 적재 ───────────────────────────────────────────────────── */
const secret = readFileSync(SECRET_FILE, 'utf8').trim();
const resp = await fetch(EDGE, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    apikey: SUPA_PUBLISHABLE_KEY,
    Authorization: `Bearer ${SUPA_PUBLISHABLE_KEY}`,
  },
  body: JSON.stringify({ secret, action: 'push', rows: res.rows }),
});
const out = await resp.json().catch(() => ({}));
if (!resp.ok || out.ok === false) {
  console.error(`\n적재 실패 (HTTP ${resp.status}):`, JSON.stringify(out).slice(0, 300));
  process.exit(3);
}
console.log(`\n적재 완료 — 추가 ${out.added ?? '?'}건 · 중복 skip ${out.skipped ?? '?'}건`
  + (out.refreshed ? ` · 적요 갱신 ${out.refreshed}건` : '')
  + ` · cf_data 총 ${out.total ?? '?'}건`);
/* 적요 갱신은 조용히 넘기면 안 된다 — 클로브가 거래처를 뒤늦게 붙였다는 뜻이라
 * 사람이 무엇이 어떻게 바뀌었는지 확인할 수 있어야 한다. */
if (Array.isArray(out.renamed) && out.renamed.length) {
  console.log('  갱신된 적요 (수기 수정분은 보호됨):');
  for (const { from, to } of out.renamed) console.log(`   "${from}" → "${to}"`);
}
if (out.cat_sync) console.log(`  학습 매핑: ${out.cat_sync}`);

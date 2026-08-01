#!/usr/bin/env node
/**
 * clobe-cf-ingest — 클로브 거래내역(JSON) → 검증 → cf_data 적재
 *
 * 사용:
 *   node scripts/clobe-cf-ingest.mjs <clobe.json> [--dry-run] [--allow-today]
 *
 * <clobe.json> 은 클로브 MCP `get_labeled_transactions` 응답을 그대로 저장한 파일.
 * 여러 페이지면 { content:[...], totalElements } 를 합쳐 하나로 만들어도 되고,
 * 응답 객체를 배열로 담아도 된다: [ {응답1}, {응답2} ]
 *
 * 반드시 지키는 규칙 (실데이터에서 확인된 함정)
 *  1) transactionId 중복 — 라벨이 여러 개면 같은 거래가 여러 행으로 온다. transactionId 로 dedupe.
 *     dedupe 후 건수가 totalElements 와 다르면 페이지 누락 의심 → 중단.
 *  2) 외화(FX) 계좌 — inAmount/outAmount 가 USD 원금이라 원화로 섞으면 안 된다. 기본 제외하고 보고만.
 *  3) 오늘자 거래는 스냅샷이 불완전할 수 있어 기본 제외(--allow-today 로 해제).
 *  4) 적재 전 일자별 건수·합계를 출력해 눈으로 대조할 수 있게 한다.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const DRY = args.includes('--dry-run');
const ALLOW_TODAY = args.includes('--allow-today');
if (!file) { console.error('사용법: node scripts/clobe-cf-ingest.mjs <clobe.json> [--dry-run] [--allow-today]'); process.exit(1); }

const EDGE = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
const SECRET_FILE = 'C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret';

const won = n => Math.round(n).toLocaleString('ko-KR');
const todayKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

/* ── 1) 입력 파싱 ─────────────────────────────────────────── */
const raw = JSON.parse(readFileSync(file, 'utf8'));
const pages = Array.isArray(raw) ? raw : [raw];
const rowsRaw = pages.flatMap(p => Array.isArray(p?.content) ? p.content : []);
const totalElements = pages.reduce((s, p) => s + (Number(p?.totalElements) || 0), 0);
if (!rowsRaw.length) { console.error('거래 행이 없습니다.'); process.exit(1); }

/* ── 2) transactionId dedupe (라벨 다중 → 행 복제 방지) ────── */
const byId = new Map();
for (const r of rowsRaw) {
  const id = String(r.transactionId);
  if (!byId.has(id)) byId.set(id, r);          // 첫 행의 category 를 대표로 사용
}
const uniq = [...byId.values()];
const dupRemoved = rowsRaw.length - uniq.length;

/* ── 3) 외화 계좌 분리 (USD 원금이라 원화와 섞으면 안 됨) ──── */
const isFx = r => /외화|수출입/.test(String(r.accountName || ''));
const fxRows = uniq.filter(isFx);
const krwRows = uniq.filter(r => !isFx(r));

/* ── 4) 오늘자 제외 (스냅샷 불완전 방어) ───────────────────── */
const today = todayKST();
const dateOf = r => String(r.transactionAt || '').slice(0, 10);
const target = krwRows.filter(r => ALLOW_TODAY ? true : dateOf(r) < today);
const todaySkipped = krwRows.length - target.length;

/* ── 5) 일자별 검증표 ──────────────────────────────────────── */
const byDate = new Map();
for (const r of target) {
  const d = dateOf(r);
  const b = byDate.get(d) || { n: 0, in: 0, out: 0 };
  b.n++; b.in += Number(r.inAmount) || 0; b.out += Number(r.outAmount) || 0;
  byDate.set(d, b);
}

console.log('=== 클로브 거래내역 적재 검증 ===');
console.log(`원본 행 ${rowsRaw.length} · dedupe 후 ${uniq.length} (중복 제거 ${dupRemoved})`);
if (totalElements) {
  const ok = uniq.length === totalElements;
  console.log(`totalElements ${totalElements} 대조: ${ok ? 'OK' : '⚠ 불일치 — 페이지 누락 의심'}`);
  if (!ok && !DRY) { console.error('건수 불일치로 적재를 중단합니다. 전체 페이지를 받아 다시 시도하세요.'); process.exit(2); }
}
if (fxRows.length) {
  console.log(`\n⚠ 외화(FX) 거래 ${fxRows.length}건 — 금액이 USD 원금이라 자동 적재에서 제외합니다. 수동 확인 필요:`);
  for (const r of fxRows) console.log(`   ${dateOf(r)} ${r.accountName} ${r.transactionDescription} in ${r.inAmount} out ${r.outAmount} (외화)`);
}
if (todaySkipped) console.log(`\n오늘(${today})자 ${todaySkipped}건은 수집 미완성 가능성으로 제외 (--allow-today 로 포함)`);

/* ── 5-b) 합계 교차검증 — API가 보고한 합계와 대조해 행 누락을 잡는다 ──
 *   잔차(API 합계 − 우리가 센 원화 합계)의 정상적인 원인은 두 가지뿐이다.
 *     ① 외화 행 — API 합계엔 원화 환산으로 들어가지만 우리는 제외한다(환율 미상)
 *     ② 취소·정정 거래 — 한 행이 입금·출금 레그를 같은 금액으로 달고 있어 양쪽을 똑같이 부풀린다
 *   ②는 netRes(=입금잔차−출금잔차)에서 상쇄되므로 netRes 엔 ①의 환산 순액만 남아야 한다.
 *   한 방향만 부풀리는 진짜 행 누락은 netRes 를 틀어 아래 판정에서 걸린다. */
const expIn  = pages.reduce((s, p) => s + (Number(p?.inAmountSumKrw)  || 0), 0);
const expOut = pages.reduce((s, p) => s + (Number(p?.outAmountSumKrw) || 0), 0);
if (expIn || expOut) {
  const krwIn  = uniq.filter(r => !isFx(r)).reduce((s, r) => s + (Number(r.inAmount)  || 0), 0);
  const krwOut = uniq.filter(r => !isFx(r)).reduce((s, r) => s + (Number(r.outAmount) || 0), 0);
  const fxIn   = fxRows.reduce((s, r) => s + (Number(r.inAmount)  || 0), 0);
  const fxOut  = fxRows.reduce((s, r) => s + (Number(r.outAmount) || 0), 0);
  const resIn  = expIn  - krwIn;    // 외화 환산분이 여기 포함됨
  const resOut = expOut - krwOut;
  const TOL = 1;
  console.log('\nAPI 합계 대조 (행 누락 감지)');
  console.log(`  입금  API ${won(expIn)} vs 원화계좌 ${won(krwIn)} → 잔차 ${won(resIn)}${fxIn ? ` (외화 ${fxIn} 환산분 포함)` : ''}`);
  console.log(`  출금  API ${won(expOut)} vs 원화계좌 ${won(krwOut)} → 잔차 ${won(resOut)}${fxOut ? ` (외화 ${fxOut} 환산분 포함)` : ''}`);
  /* 방향별로 따로 보면 외화가 낀 쪽은 환율을 몰라 검사할 수가 없다(그 방향의 행 누락이 그대로
   * 통과해 버린다). 그래서 양쪽을 netRes 하나로 합쳐서 판정한다 —— 취소 레그는 서로 상쇄되고
   * 외화 환산분만 남으므로, 역산 환율이 상식 범위면 잔차가 ①②로 설명된 것으로 본다.
   * 환율을 맞히려는 게 아니라 터무니없는 값(=한 방향만 부풀었다는 신호)을 걸러내는 용도다.
   * 실제 사례: 2026-07-31 신한 140-013-243160 취소 220,000,000 (in=out)
   * 한계: 외화 계좌가 두 통화 이상 섞이면 단일 환율 가정이 깨진다(현재는 USD뿐). */
  const fxNet     = fxIn - fxOut;              // 외화 순액 (원금 통화)
  const netRes    = resIn - resOut;
  const rate      = fxNet ? netRes / fxNet : 0;
  const hasRes    = Math.abs(resIn) > TOL || Math.abs(resOut) > TOL;
  const explained = fxNet ? (rate > 5 && rate < 5000) : Math.abs(netRes) <= TOL;

  if (hasRes && !explained) {
    console.error(`\n⚠ 합계가 맞지 않습니다 (입금 잔차 ${won(resIn)}, 출금 잔차 ${won(resOut)}) — 한 방향만 부풀어 행 누락이 의심됩니다.`);
    if (fxNet) console.error(`   외화 ${fxNet} 로 설명하려면 환율이 ${won(rate)}원이어야 해 비현실적입니다.`);
    if (!DRY) { console.error('적재를 중단합니다. 전체 페이지를 원본 그대로 저장해 다시 시도하세요.'); process.exit(2); }
  } else if (hasRes) {
    const cancelAmt = Math.min(Math.abs(resIn), Math.abs(resOut));   // 양쪽에 공통으로 낀 몫 = 취소 레그
    if (cancelAmt > TOL) {
      console.log(`\n⚠ 입·출금 양쪽에 동액 잔차 ${won(cancelAmt)} — 순액 0이라 적재를 계속합니다.`);
      console.log('   취소·정정 거래가 클로브 집계에만 잡히고 행 목록에서 빠진 형태입니다.');
    }
    if (fxNet) console.log(`${cancelAmt > TOL ? '   ' : '\n'}외화 ${fxNet} 환산분 역산 ${won(rate)}원 — 잔차 설명됨`);
  }
}

console.log('\n일자별 (적재 대상, 원화 계좌만)');
let sumIn = 0, sumOut = 0;
for (const d of [...byDate.keys()].sort()) {
  const b = byDate.get(d); sumIn += b.in; sumOut += b.out;
  console.log(`  ${d}  ${String(b.n).padStart(3)}건   입금 ${won(b.in).padStart(15)}   출금 ${won(b.out).padStart(15)}   순 ${won(b.in - b.out).padStart(15)}`);
}
console.log(`  합계        ${String(target.length).padStart(3)}건   입금 ${won(sumIn).padStart(15)}   출금 ${won(sumOut).padStart(15)}   순 ${won(sumIn - sumOut).padStart(15)}`);

/* ── 6) cf_data 행으로 변환 ────────────────────────────────── */
const CLOBE_SKIP_CATEGORY = /^계정 없는/;   // '계정 없는 입금/출금' 은 미분류로 비움
const rows = target.map(r => {
  const inA = Number(r.inAmount) || 0, outA = Number(r.outAmount) || 0;
  const cat = String(r.category || '').trim();
  const desc = String(r.transactionDescription || r.transactionName || '').trim();
  return {
    date: dateOf(r),
    desc: desc || '(거래내용 없음)',
    in: inA, out: outA,
    status: inA > 0 ? '실제 입금' : '실제 지출',
    mid: CLOBE_SKIP_CATEGORY.test(cat) ? '' : cat,
    clobe_id: String(r.transactionId),
  };
});

if (DRY) { console.log(`\n[dry-run] 적재하지 않았습니다. 대상 ${rows.length}건.`); process.exit(0); }

/* ── 7) 적재 ───────────────────────────────────────────────── */
const secret = readFileSync(SECRET_FILE, 'utf8').trim();
const res = await fetch(EDGE, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ secret, action: 'push', rows }),
});
const out = await res.json().catch(() => ({}));
if (!res.ok || out.ok === false) {
  console.error(`\n적재 실패 (HTTP ${res.status}):`, JSON.stringify(out).slice(0, 300));
  process.exit(3);
}
console.log(`\n적재 완료 — 추가 ${out.added ?? '?'}건 · 중복 skip ${out.skipped ?? '?'}건 · cf_data 총 ${out.total ?? '?'}건`);

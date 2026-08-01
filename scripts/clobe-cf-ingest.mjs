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
 *  2) 외화(FX) 계좌 — 금액이 USD 원금이다. API 합계 잔차에서 그날 환율을 역산해 원화로 환산한 뒤
 *     함께 적재한다(5·6번 블록). 역산이 불가능하면 제외하고 목록만 보고한다.
 *  3) 오늘자 거래는 스냅샷이 불완전할 수 있어 기본 제외(--allow-today 로 해제).
 *  4) 적재 전 일자별 건수·합계를 출력해 눈으로 대조할 수 있게 한다.
 *  5) desc 는 businessEntityName 우선(은행 원본 문자열은 잘려서 학습 키가 분산됨).
 *     중분류는 보내지 않고 대시보드 '자동분류 추천'에 맡긴다 — 이유는 6) 블록 주석 참고.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const DRY = args.includes('--dry-run');
const ALLOW_TODAY = args.includes('--allow-today');
if (!file) { console.error('사용법: node scripts/clobe-cf-ingest.mjs <clobe.json> [--dry-run] [--allow-today]'); process.exit(1); }

const EDGE = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
const SECRET_FILE = 'C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret';
/* 이 함수는 verify_jwt=true 로 배포돼 있어 게이트웨이가 키를 요구한다
 * (없으면 함수에 닿기도 전에 401 UNAUTHORIZED_NO_AUTH_HEADER).
 * 아래는 index.html 에 이미 박혀 브라우저로 배포되는 공개 publishable 키라 비밀이 아니다.
 * 실제 인증은 본문의 secret(=BANK_SYNC_SECRET) 이 한다.
 * 나중에 --no-verify-jwt 로 재배포해도 이 헤더는 무시될 뿐이라 그대로 둬도 된다. */
const SUPA_PUBLISHABLE_KEY = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';

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

const today = todayKST();
const dateOf = r => String(r.transactionAt || '').slice(0, 10);

console.log('=== 클로브 거래내역 적재 검증 ===');
console.log(`원본 행 ${rowsRaw.length} · dedupe 후 ${uniq.length} (중복 제거 ${dupRemoved})`);
if (totalElements) {
  const ok = uniq.length === totalElements;
  console.log(`totalElements ${totalElements} 대조: ${ok ? 'OK' : '⚠ 불일치 — 페이지 누락 의심'}`);
  if (!ok && !DRY) { console.error('건수 불일치로 적재를 중단합니다. 전체 페이지를 받아 다시 시도하세요.'); process.exit(2); }
}
/* ── 5) 합계 교차검증 + 외화 환율 역산 ─────────────────────────
 *   API 합계는 외화를 원화로 환산해 넣지만 환율은 알려주지 않는다. 잔차의 원인은 둘뿐:
 *     ① 외화 환산분 (환율 r 미상)
 *     ② 취소·정정 거래 — 한 행이 입금·출금 레그를 같은 금액 c 로 달아 양쪽을 똑같이 부풀린다
 *   연립하면  입금잔차 = fxIn·r + c ,  출금잔차 = fxOut·r + c  이므로
 *     r = (입금잔차 − 출금잔차) / (fxIn − fxOut) ,  c = 입금잔차 − fxIn·r
 *   r 로 외화 행을 원화 환산해 함께 적재하고, c 는 순액 0이라 무시한다.
 *   한 방향만 부풀리는 진짜 행 누락은 r 을 상식 밖 값으로 밀어내 band 검사에서 걸린다.
 *   ⚠ 하루치(단일 환율) 기준이다. 여러 날을 한 파일에 담으면 날짜별 환율이 섞여 실패한다
 *     (2026-07 실측 1,489~1,555원/USD). 외화 계좌가 두 통화 이상이어도 깨진다(현재는 USD뿐).
 *   ⚠ r 은 클로브의 평가환율이지 은행이 실제 적용한 환율이 아니다. 환전 건은 실제 원화 대금과
 *     차이날 수 있다(2026-07-09 실측: 평가 1,509.9 vs 실제 1,491.89, 2건 합계 1,801만원 차). */
const TOL = 1, RATE_MIN = 100, RATE_MAX = 5000;
const sumOf  = (a, k) => a.reduce((s, r) => s + (Number(r[k]) || 0), 0);
const expIn  = pages.reduce((s, p) => s + (Number(p?.inAmountSumKrw)  || 0), 0);
const expOut = pages.reduce((s, p) => s + (Number(p?.outAmountSumKrw) || 0), 0);
const fxIn = sumOf(fxRows, 'inAmount'), fxOut = sumOf(fxRows, 'outAmount');
const fxNet = fxIn - fxOut;
let fxRate = 0;

if (expIn || expOut) {
  const krwIn = sumOf(krwRows, 'inAmount'), krwOut = sumOf(krwRows, 'outAmount');
  const resIn = expIn - krwIn, resOut = expOut - krwOut;
  console.log('\nAPI 합계 대조 (행 누락 감지)');
  console.log(`  입금  API ${won(expIn)} vs 원화계좌 ${won(krwIn)} → 잔차 ${won(resIn)}${fxIn ? ` (외화 ${fxIn} 환산분 포함)` : ''}`);
  console.log(`  출금  API ${won(expOut)} vs 원화계좌 ${won(krwOut)} → 잔차 ${won(resOut)}${fxOut ? ` (외화 ${fxOut} 환산분 포함)` : ''}`);

  const hasRes    = Math.abs(resIn) > TOL || Math.abs(resOut) > TOL;
  const r         = fxNet ? (resIn - resOut) / fxNet : 0;
  const c         = fxNet ? resIn - fxIn * r : resIn;          // 취소 레그(양쪽 공통분)
  const explained = (fxNet ? (r > RATE_MIN && r < RATE_MAX) : Math.abs(resIn - resOut) <= TOL) && c >= -TOL;

  if (hasRes && !explained) {
    console.error(`\n⚠ 합계가 맞지 않습니다 (입금 잔차 ${won(resIn)}, 출금 잔차 ${won(resOut)}) — 행 누락이 의심됩니다.`);
    if (fxNet) console.error(`   외화 ${fxNet} 로 설명하려면 환율이 ${won(r)}원이어야 해 비현실적입니다.`);
    if (!DRY) { console.error('적재를 중단합니다. 하루치씩 나눠 원본 그대로 저장해 다시 시도하세요.'); process.exit(2); }
  } else {
    if (c > TOL) {
      console.log(`\n⚠ 입·출금 양쪽에 동액 잔차 ${won(c)} — 순액 0이라 적재를 계속합니다.`);
      console.log('   취소·정정 거래가 클로브 집계에만 잡히고 행 목록에서 빠진 형태입니다.');
    }
    fxRate = fxNet ? r : 0;
  }
}

/* ── 6) 외화 행 원화 환산 ──────────────────────────────────────
 *   accountName 에 적용 환율을 남겨 나중에 근거를 추적할 수 있게 하고,
 *   desc 는 적요코드(TRN·POS·48ITT…)보다 송금인/수취인이 유용하므로 transactionName 을 쓴다. */
let fxKrwRows = [];
if (fxRows.length && fxRate) {
  fxKrwRows = fxRows.map(r => ({
    ...r,
    inAmount:  Math.round((Number(r.inAmount)  || 0) * fxRate),
    outAmount: Math.round((Number(r.outAmount) || 0) * fxRate),
    accountName: `${r.accountNumber} (외화 원화환산 @${fxRate.toFixed(2)})`,
    businessEntityName: r.transactionName || r.businessEntityName || r.transactionDescription,
  }));
  console.log(`\n외화 ${fxRows.length}건 — 역산 환율 ${fxRate.toFixed(2)}원으로 환산해 함께 적재합니다:`);
  for (const r of fxKrwRows) console.log(`   ${dateOf(r)} ${r.businessEntityName} 입 ${won(r.inAmount)} 출 ${won(r.outAmount)}`);
} else if (fxRows.length) {
  console.log(`\n⚠ 외화 ${fxRows.length}건 — 환율 역산 불가(합계 검증 미통과 · 외화 순액 0 · API 합계 없음 중 하나)로 적재에서 제외합니다:`);
  for (const r of fxRows) console.log(`   ${dateOf(r)} ${r.accountName} ${r.transactionDescription} 입 ${r.inAmount} 출 ${r.outAmount}`);
}

/* ── 7) 오늘자 제외 (스냅샷 불완전 방어) + 일자별 검증표 ────── */
const allRows = [...krwRows, ...fxKrwRows];
const target = allRows.filter(r => ALLOW_TODAY ? true : dateOf(r) < today);
const todaySkipped = allRows.length - target.length;
if (todaySkipped) console.log(`\n오늘(${today})자 ${todaySkipped}건은 수집 미완성 가능성으로 제외 (--allow-today 로 포함)`);

const byDate = new Map();
for (const r of target) {
  const d = dateOf(r);
  const b = byDate.get(d) || { n: 0, in: 0, out: 0 };
  b.n++; b.in += Number(r.inAmount) || 0; b.out += Number(r.outAmount) || 0;
  byDate.set(d, b);
}

console.log('\n일자별 (적재 대상, 외화는 원화환산 포함)');
let sumIn = 0, sumOut = 0;
for (const d of [...byDate.keys()].sort()) {
  const b = byDate.get(d); sumIn += b.in; sumOut += b.out;
  console.log(`  ${d}  ${String(b.n).padStart(3)}건   입금 ${won(b.in).padStart(15)}   출금 ${won(b.out).padStart(15)}   순 ${won(b.in - b.out).padStart(15)}`);
}
console.log(`  합계        ${String(target.length).padStart(3)}건   입금 ${won(sumIn).padStart(15)}   출금 ${won(sumOut).padStart(15)}   순 ${won(sumIn - sumOut).padStart(15)}`);

/* ── 6) cf_data 행으로 변환 ────────────────────────────────── */
/* desc — businessEntityName(클로브가 정규화한 거래처명) 우선.
 *   은행 원본 문자열은 잘리거나 이체수단마다 달라져서("주식회사스파크" ↔ "스파크플러스",
 *   "휴온스엔" ↔ "휴온스푸디언스") 대시보드 학습 매핑(catDescToMid)의 키가 분산된다.
 *   기존 드라이브/CSV 적재 경로도 businessEntityName 우선이라 이쪽이 이력과도 맞는다.
 *   거래처가 안 붙은 건(세무서·특송 등)은 은행 문자열로 폴백.
 * 중분류(mid) — 보내지 않는다. 대시보드가 분류한다.
 *   클로브 계정라벨은 대시보드 중분류와 어휘 체계가 다르고(매출원가·세금 환급 등 미등록),
 *   한 거래에 라벨이 여러 개 붙어 어느 것이 채택될지가 응답 순서에 좌우된다.
 *   mid 를 비우면 Edge 가 mid_cat:"" 로 넣고 대시보드 '✨ 자동분류 추천'의 대상이 된다. */
const rows = target.map(r => {
  const inA = Number(r.inAmount) || 0, outA = Number(r.outAmount) || 0;
  const desc = String(r.businessEntityName || r.transactionDescription || r.transactionName || '').trim();
  return {
    date: dateOf(r),
    desc: desc || '(거래내용 없음)',
    in: inA, out: outA,
    status: inA > 0 ? '실제 입금' : '실제 지출',
    clobe_id: String(r.transactionId),
  };
});

if (DRY) { console.log(`\n[dry-run] 적재하지 않았습니다. 대상 ${rows.length}건.`); process.exit(0); }

/* ── 7) 적재 ───────────────────────────────────────────────── */
const secret = readFileSync(SECRET_FILE, 'utf8').trim();
const res = await fetch(EDGE, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    apikey: SUPA_PUBLISHABLE_KEY,
    Authorization: `Bearer ${SUPA_PUBLISHABLE_KEY}`,
  },
  body: JSON.stringify({ secret, action: 'push', rows }),
});
const out = await res.json().catch(() => ({}));
if (!res.ok || out.ok === false) {
  console.error(`\n적재 실패 (HTTP ${res.status}):`, JSON.stringify(out).slice(0, 300));
  process.exit(3);
}
console.log(`\n적재 완료 — 추가 ${out.added ?? '?'}건 · 중복 skip ${out.skipped ?? '?'}건 · cf_data 총 ${out.total ?? '?'}건`);

#!/usr/bin/env node
/**
 * clobe-cf-ingest — 클로브 거래내역(JSON) → 검증 → cf_data 적재
 *
 * 사용:
 *   node scripts/clobe-cf-ingest.mjs <clobe.json> [--dry-run] [--allow-today] [--fx-ref <원/USD>]
 *
 * <clobe.json> 은 클로브 MCP `get_labeled_transactions` 응답을 그대로 저장한 파일.
 * 여러 페이지면 { content:[...], totalElements } 를 합쳐 하나로 만들어도 되고,
 * 응답 객체를 배열로 담아도 된다: [ {응답1}, {응답2} ]
 *
 * 반드시 지키는 규칙 (실데이터에서 확인된 함정)
 *  1) transactionId 중복 — 라벨이 여러 개면 같은 거래가 여러 행으로 온다. transactionId 로 dedupe.
 *     dedupe 후 건수가 totalElements 와 다르면 페이지 누락 의심 → 중단.
 *  1-1) 외화계좌 판정은 --fx-accounts 화이트리스트(accountId)로 한다. 계좌명 정규식은 목록에
 *     없는 외화계좌를 잡는 트립와이어로만 남긴다 — 새 계좌가 열리면 중단하고 알려준다.
 *     그날 외화 통화가 둘 이상이면 단일 환율이 성립하지 않으므로 중단한다.
 *  2) 외화(FX) 계좌 — 금액이 USD 원금이다. API 합계 잔차에서 그날 환율을 역산해 원화로 환산한 뒤
 *     함께 적재한다(5·6번 블록). 역산이 불가능하면 제외하고 목록만 보고한다.
 *     역산값의 타당성 검사가 외화 낀 날의 유일한 행-누락 방어선이라 --fx-ref 로 기준환율을
 *     받아 밴드를 좁힌다(5-a 블록). 안 주면 캐시 → 그것도 없으면 넓은 밴드 + 경고.
 *     외화 순액이 0(환전·pass-through)이면 역산이 불가능하므로 기준환율로 환산한다 —
 *     이 경우 순액은 환율과 무관하게 0이라 총액 크기만 영향을 받는다.
 *  2-1) 취소 레그(입·출금 양쪽 공통분 c)가 그날 총액의 절반을 넘으면 취소가 아니라 계좌 단위
 *     행 누락으로 보고 중단한다(--allow-large-cancel 로 통과).
 *  3) 오늘자 거래는 스냅샷이 불완전할 수 있어 기본 제외(--allow-today 로 해제).
 *  4) 적재 전 일자별 건수·합계를 출력해 눈으로 대조할 수 있게 한다.
 *  5) desc 는 businessEntityName 우선(은행 원본 문자열은 잘려서 학습 키가 분산됨).
 *     중분류는 보내지 않고 대시보드 '자동분류 추천'에 맡긴다 — 이유는 6) 블록 주석 참고.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
/* 값을 받는 옵션은 args 에서 먼저 걷어낸다 — 안 그러면 "--fx-ref 1433.6" 의 값이
 * 파일 인자로 오인된다(둘 다 '--' 로 시작하지 않으므로). */
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

/* ── 3) 외화 계좌 분리 (USD 원금이라 원화와 섞으면 안 됨) ──────
 *   판정 기준은 accountId 화이트리스트다 — 거래 payload 에는 accountType·currencyCode 가
 *   없지만 get_bank_accounts 에는 있으므로, 거기서 뽑아 --fx-accounts 로 넘긴다:
 *     --fx-accounts 56034:USD,145016:USD      (accountType === 'FX' 인 계좌의 bankAccountId:currencyCode)
 *   --fx-ref 와 같은 방식으로 캐시에 저장하고, 안 넘어오면 캐시로 버틴다.
 *
 *   계좌명 정규식은 주 판정에서 내려오되 **트립와이어**로 남긴다: 화이트리스트에 없는데
 *   이름이 외화계좌처럼 생긴 행이 나오면 새 외화계좌가 생긴 것이므로 중단한다.
 *   (화이트리스트만 두면 새 계좌의 USD 원금이 원화로 섞여 조용히 망가진다 — 정규식만
 *    두던 예전보다 오히려 위험하다. 그래서 둘을 겹쳐 쓴다.)
 *
 *   통화는 하나여야 한다. 역산이든 기준환율이든 그날 환율은 하나뿐이라, 두 통화가 섞이면
 *   fxIn 합계 자체가 무의미해진다("외화다통화예금"은 이름 그대로 다통화 계좌다). */
const FX_ACC_CACHE = 'C:/Users/RAWGA/AppData/Local/rawga/fx-accounts.json';
const parseFxAccounts = s => {
  const m = new Map();
  for (const tok of String(s || '').split(',').map(t => t.trim()).filter(Boolean)) {
    const [id, cur] = tok.split(':');
    if (/^\d+$/.test(id)) m.set(id, (cur || 'USD').toUpperCase());
  }
  return m;
};

let fxAccounts = parseFxAccounts(FX_ACC_ARG), fxAccSrc = '--fx-accounts';
if (fxAccounts.size) {
  try { writeFileSync(FX_ACC_CACHE, JSON.stringify({ accounts: Object.fromEntries(fxAccounts), savedAt: todayKST() }, null, 2)); }
  catch (e) { console.log(`  (외화계좌 목록 캐시 저장 실패 — 검증에는 지장 없음: ${e.message})`); }
} else {
  try {
    const c = JSON.parse(readFileSync(FX_ACC_CACHE, 'utf8'));
    fxAccounts = new Map(Object.entries(c?.accounts || {}));
    fxAccSrc = `캐시 ${c?.savedAt ?? '날짜불명'}`;
  } catch { fxAccSrc = ''; }
}

const looksFx = r => /외화|수출입|FX/i.test(String(r.accountName || ''));
const isFx = r => fxAccounts.size ? fxAccounts.has(String(r.accountId)) : looksFx(r);
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

/* ── 4) 외화계좌 판정 검증 (트립와이어 + 통화 단일성) ────────── */
if (fxAccounts.size) {
  console.log(`외화계좌 화이트리스트 ${[...fxAccounts.entries()].map(([i, c]) => `${i}:${c}`).join(' ')} (${fxAccSrc})`);

  /* 목록에 없는데 이름이 외화계좌처럼 생긴 행 — 새 계좌가 열린 것이다.
   * 그냥 두면 USD 원금이 원화로 섞여 조용히 망가지므로 여기서 멈춘다. */
  const strays = uniq.filter(r => !fxAccounts.has(String(r.accountId)) && looksFx(r));
  if (strays.length) {
    const seen = new Map(strays.map(r => [String(r.accountId), r]));
    console.error(`\n⚠ 화이트리스트에 없는 외화계좌로 보이는 거래 ${strays.length}건 — 새 외화계좌가 열렸는지 확인하세요.`);
    for (const [id, r] of seen) console.error(`   accountId ${id} · ${r.accountName} (${r.accountNumber})`);
    console.error('   get_bank_accounts 에서 accountType=FX 계좌를 다시 뽑아 --fx-accounts 로 넘기세요.');
    console.error('   (원화로 잘못 섞이면 USD 원금이 원화 금액으로 적재됩니다.)');
    if (!DRY) { console.error('적재를 중단합니다.'); process.exit(2); }
  }

  /* 그날 외화 행의 통화가 둘 이상이면 단일 환율 모델이 성립하지 않는다. */
  const curs = [...new Set(fxRows.map(r => fxAccounts.get(String(r.accountId))))];
  if (curs.length > 1) {
    console.error(`\n⚠ 외화 거래의 통화가 ${curs.join('·')} 로 섞여 있습니다 — 단일 환율로 환산할 수 없습니다.`);
    console.error('   통화별로 파일을 나눠 각각 해당 통화의 --fx-ref 로 적재하세요.');
    if (!DRY) { console.error('적재를 중단합니다.'); process.exit(2); }
  }
} else if (fxRows.length) {
  console.log(`⚠ 외화계좌 화이트리스트 없음 — 계좌명(${'/외화|수출입|FX/'})으로만 판정했습니다. --fx-accounts 로 넘기는 편이 안전합니다.`);
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
const TOL = 1;
/* ③ 취소 레그 상한 — 둘 다 넘어야 중단(작은 날의 비율은 노이즈라 절대액 하한을 같이 건다) */
const C_STOP_RATIO = 0.50, C_STOP_ABS = 10_000_000;
const sumOf  = (a, k) => a.reduce((s, r) => s + (Number(r[k]) || 0), 0);
const expIn  = pages.reduce((s, p) => s + (Number(p?.inAmountSumKrw)  || 0), 0);
const expOut = pages.reduce((s, p) => s + (Number(p?.outAmountSumKrw) || 0), 0);
const fxIn = sumOf(fxRows, 'inAmount'), fxOut = sumOf(fxRows, 'outAmount');
const fxNet = fxIn - fxOut;
let fxRate = 0, fxRateSrc = '';
let fxRef = 0;                                   // 기준환율(--fx-ref 또는 캐시) — 5-a 에서 채운다

/* ── 5-a) 환율 밴드 ────────────────────────────────────────────
 *   미지수 2개(r, c)에 식 2개라 연립은 어떤 입력에도 해를 내놓는다. 남는 잔차가 없어
 *   모델이 틀렸는지 데이터로는 알 수 없고, 검증 전부가 r 의 타당성 밴드에 걸려 있다.
 *   밴드가 넓으면 한쪽에만 누락된 원화 행이 환율에 흡수돼 그냥 통과한다
 *   (예전 [100,5000] · fxNet 1495 USD 기준 최대 약 500만원까지 흡수).
 *
 *   그래서 클로브 평가환율을 기준점으로 받아 ±5% 로 좁힌다. 같은 예에서 감지 한계가
 *   약 500만원 → 약 11만원으로 내려간다. 기준환율 구하는 법:
 *     get_bank_accounts → FX 계좌의 krwBalance / balance  (통화가 같으면 계좌 불문 동일)
 *   --fx-ref 로 넘기면 캐시에 저장하고, 다음 실행에 안 넘어오면 캐시로 버틴다.
 *   캐시가 오래되면 밴드를 완화하고, 기준점이 아예 없으면 예전 넓은 밴드 + 경고. */
const FX_REF_CACHE = 'C:/Users/RAWGA/AppData/Local/rawga/fx-ref-rate.json';
const FX_TOL = 0.05, FX_TOL_STALE = 0.10, STALE_DAYS = 14;
let RATE_MIN = 100, RATE_MAX = 5000;
let bandNote = '⚠ 기준환율 없음(--fx-ref 미지정·캐시 없음) — 행 누락 감지가 약합니다';

if (fxRows.length) {
  fxRef = Number(FX_REF_ARG) > 0 ? Number(FX_REF_ARG) : 0;
  let refAsOf = null, fromCache = false;

  if (fxRef > 0) {
    refAsOf = todayKST();
    try { writeFileSync(FX_REF_CACHE, JSON.stringify({ rate: fxRef, savedAt: refAsOf }, null, 2)); }
    catch (e) { console.log(`  (기준환율 캐시 저장 실패 — 검증에는 지장 없음: ${e.message})`); }
  } else {
    try {
      const c = JSON.parse(readFileSync(FX_REF_CACHE, 'utf8'));
      if (Number(c?.rate) > 0) { fxRef = Number(c.rate); refAsOf = c.savedAt || null; fromCache = true; }
    } catch { /* 캐시 없음 — 아래에서 넓은 밴드로 간다 */ }
  }

  if (fxRef > 0) {
    const age = refAsOf ? Math.round((Date.parse(todayKST()) - Date.parse(refAsOf)) / 864e5) : 9999;
    const tol = age > STALE_DAYS ? FX_TOL_STALE : FX_TOL;
    RATE_MIN = fxRef * (1 - tol);
    RATE_MAX = fxRef * (1 + tol);
    bandNote = `기준 ${fxRef.toFixed(2)}원 ±${(tol * 100).toFixed(0)}%`
      + (fromCache ? ` · 캐시 ${refAsOf ?? '날짜불명'}${age > STALE_DAYS ? ` (${age}일 경과라 밴드 완화)` : ''}` : '');
  }
}

if (expIn || expOut) {
  const krwIn = sumOf(krwRows, 'inAmount'), krwOut = sumOf(krwRows, 'outAmount');
  const resIn = expIn - krwIn, resOut = expOut - krwOut;
  console.log('\nAPI 합계 대조 (행 누락 감지)');
  console.log(`  입금  API ${won(expIn)} vs 원화계좌 ${won(krwIn)} → 잔차 ${won(resIn)}${fxIn ? ` (외화 ${fxIn} 환산분 포함)` : ''}`);
  console.log(`  출금  API ${won(expOut)} vs 원화계좌 ${won(krwOut)} → 잔차 ${won(resOut)}${fxOut ? ` (외화 ${fxOut} 환산분 포함)` : ''}`);
  if (fxRows.length) console.log(`  환율 허용 밴드 ${RATE_MIN.toFixed(0)}~${RATE_MAX.toFixed(0)}원 — ${bandNote}`);

  const hasRes = Math.abs(resIn) > TOL || Math.abs(resOut) > TOL;

  /* ② fxNet 이 0 이면 연립이 r 을 못 낸다 — 입·출금 레그가 정확히 상쇄되기 때문이고,
   *    환전(USD 입금 + 동액 USD 출금)이나 pass-through 가 이 모양이다.
   *    이때는 기준환율을 그대로 쓴다: fxIn === fxOut 이라 어떤 환율을 써도 순액은 0 이고
   *    총입금·총출금 크기만 달라지므로, 행을 통째로 버리는 것보다 환산해 넣는 편이 낫다.
   *    기준환율마저 없으면 예전처럼 제외하고 목록만 보고한다(6번 블록). */
  const rDerived = fxNet ? (resIn - resOut) / fxNet : 0;
  const rUsed    = fxNet ? rDerived : (fxRows.length && fxRef > 0 ? fxRef : 0);
  const c        = rUsed ? resIn - fxIn * rUsed : resIn;        // 취소 레그(양쪽 공통분)
  /* c 가 외화 환산분과 분리됐는지 — 환율을 못 정하면 c 안에 외화가 섞여 있어 ③ 검사를 못 건다 */
  const cIsolated = !fxRows.length || rUsed > 0;

  const rateOk    = fxNet ? (rDerived > RATE_MIN && rDerived < RATE_MAX)
                          : Math.abs(resIn - resOut) <= TOL;
  const explained = rateOk && c >= -TOL;

  if (hasRes && !explained) {
    console.error(`\n⚠ 합계가 맞지 않습니다 (입금 잔차 ${won(resIn)}, 출금 잔차 ${won(resOut)}) — 행 누락이 의심됩니다.`);
    if (fxNet) {
      console.error(`   외화 ${fxNet} 로 설명하려면 환율이 ${rDerived.toFixed(2)}원이어야 하는데 허용 밴드 ${RATE_MIN.toFixed(0)}~${RATE_MAX.toFixed(0)}원 밖입니다 (${bandNote}).`);
      console.error('   환율이 실제로 그만큼 움직였다면 최신 기준환율을 --fx-ref 로 넘겨 다시 시도하세요');
      console.error('   (get_bank_accounts → FX 계좌의 krwBalance / balance).');
    }
    if (!DRY) { console.error('적재를 중단합니다. 하루치씩 나눠 원본 그대로 저장해 다시 시도하세요.'); process.exit(2); }
  } else {
    /* ③ 취소 레그 c 의 상한 — c 는 "집계에는 있는데 행 목록에는 없는" 양쪽 공통분이라
     *    정상 원인은 취소·정정뿐이다. 이게 그날 총액의 상당 비율이면 취소가 아니라
     *    계좌 하나가 통째로 빠진 피드 장애일 수 있으므로 규모를 보고 중단한다.
     *    (실측: 2026-07-31 의 220,000,000원 = 총액의 14.7% 는 정상으로 확인된 취소쌍이다.
     *     정상 데이터를 깨지 않도록 중단선은 넉넉히 두고, 넘으면 --allow-large-cancel 로 통과.) */
    const gross  = Math.max(expIn, expOut);
    const cRatio = gross ? c / gross : 0;

    if (c > TOL) {
      console.log(`\n⚠ 입·출금 양쪽에 동액 잔차 ${won(c)} — 순액 0이라 적재를 계속합니다`
        + (cIsolated ? ` (그날 총액의 ${(cRatio * 100).toFixed(1)}%).` : ' — 환율 미정이라 외화 환산분이 섞여 있어 규모 판정은 건너뜁니다.'));
      console.log('   취소·정정 거래가 클로브 집계에만 잡히고 행 목록에서 빠진 형태입니다.');
    }

    if (cIsolated && c > C_STOP_ABS && cRatio > C_STOP_RATIO && !ALLOW_LARGE_CANCEL) {
      console.error(`\n⚠ 취소 레그가 그날 총액의 ${(cRatio * 100).toFixed(1)}% (${won(c)}) 로 과대합니다 — 계좌 단위 행 누락이 의심됩니다.`);
      console.error('   클로브에서 그날 취소·정정이 실제로 이 규모인지 확인하고, 맞으면 --allow-large-cancel 로 다시 실행하세요.');
      if (!DRY) { console.error('적재를 중단합니다.'); process.exit(2); }
    }

    fxRate = rUsed;
    fxRateSrc = rUsed ? (fxNet ? '역산 환율' : '기준환율') : '';
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
    accountName: `${r.accountNumber} (외화 원화환산 @${fxRate.toFixed(2)} ${fxRateSrc})`,
    businessEntityName: r.transactionName || r.businessEntityName || r.transactionDescription,
    /* 외화 원금(통화 단위)을 그대로 실어 cf_data 에 남긴다 — 이 표시가 있어야 나중에
     * "외화 실잔액 − 외화 행 순증" 으로 환산조정액을 계산할 수 있다. 원화 행과 섞이면
     * 구분할 방법이 없다(계좌 정보는 cf_data 에 저장되지 않는다). */
    _fxUsd: (Number(r.inAmount) || 0) + (Number(r.outAmount) || 0),
  }));
  console.log(`\n외화 ${fxRows.length}건 — ${fxRateSrc} ${fxRate.toFixed(2)}원으로 환산해 함께 적재합니다:`);
  if (fxRateSrc === '기준환율') {
    console.log('   외화 순액 0(환전·pass-through)이라 역산이 불가능해 기준환율을 그대로 썼습니다.');
    console.log('   순액은 환율과 무관하게 0이고 총입금·총출금 크기만 이 환율을 탑니다 — 실제 환전 대금과는 다를 수 있습니다.');
  }
  for (const r of fxKrwRows) console.log(`   ${dateOf(r)} ${r.businessEntityName} 입 ${won(r.inAmount)} 출 ${won(r.outAmount)}`);
} else if (fxRows.length) {
  console.log(`\n⚠ 외화 ${fxRows.length}건 — 환율을 정할 수 없어(합계 검증 미통과 · API 합계 없음 · 순액 0인데 기준환율도 없음) 적재에서 제외합니다:`);
  console.log('   순액 0 때문이라면 --fx-ref 로 기준환율을 넘기면 환산해 적재합니다.');
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
    ...(r._fxUsd ? { fx_usd: r._fxUsd } : {}),   // 외화 행에만 원금(통화 단위)을 남긴다
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

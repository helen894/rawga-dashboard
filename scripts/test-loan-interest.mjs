#!/usr/bin/env node
/**
 * test-loan-interest.mjs — 대출 월이자 일수식 계산 + 역산 검증 회귀 테스트.
 *
 * 왜 있는가 (2026-11-06)
 *   종전 `잔액×금리÷12` 는 한 달을 30.417일로 고정해 30일달 -1.4% / 31일달 +1.9% 가
 *   구조적으로 어긋났다. 그걸 "공식으로는 못 맞추는 오차" 로 잘못 읽고 실측 입력값
 *   (intAmount)이 계산을 덮도록 둔 탓에, **잔액·금리를 고쳐도 월이자가 안 따라갔다.**
 *   일수식으로 바꾸니 실측 10건 중 9건이 원 단위까지 맞았다.
 *
 * 무엇을 지키는가
 *   (1) 월이자 = 잔액 × 금리 × 그 달 일수 / 365   — 실측값과 원 단위 일치
 *   (2) intAmount 는 계산을 덮지 않는다           — 낡은 값이 이기면 전환한 의미가 없다
 *   (3) 거치 중(잔액>=원금)이면 원금분을 더하지 않는다
 *   (4) 상환 중이면 월상환액(=원금분) + 그 달 이자
 *   (5) 역산 검증은 적요로 대출이 특정되는 건만 — 애매하면 검사하지 않는다
 *
 * 판정 함수는 index.html 에서 떼어 와 쓴다. 사본을 만들면 화면과 테스트가 갈린다.
 * 쓰는 법: node scripts/test-loan-interest.mjs
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const grab = (n) => {
  const i = src.indexOf(`function ${n}(`);
  if (i < 0) throw new Error(`${n} 를 index.html 에서 못 찾음`);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error(`${n} 본문 끝을 못 찾음`);
};
const mk = (cfData, loanData) => {
  const env = { cfData, loanData,
    loanNum: (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0,
    todayKST: () => '2026-11-06', LOAN_AMORT: ['원리금균등', '원금분할'] };
  return new Function(...Object.keys(env), `
    ${grab('loanDaysInMonth')} ${grab('loanInterestFor')} ${grab('loanMonthlyInterest')}
    ${grab('loanInGrace')} ${grab('loanIsAmort')} ${grab('loanMonthlyOut')}
    ${grab('loanTail7')} ${grab('loanActualOut')}
    const LOAN_GAP_TOL = 0.10;
    ${grab('loanBalanceCheck')}
    return { loanInterestFor, loanMonthlyOut, loanBalanceCheck, loanInGrace };`)(...Object.values(env));
};
let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const r0 = (v) => Math.round(v);

// ── (1) 일수식이 실측값과 맞는가 — 2026-11-06 실데이터 ──────────────────
{
  const api = mk([], []);
  const cases = [
    ['기업 00033', { balance: 200000000, rate: 5.2685 }, '2026-09', 866054],   // 30일
    ['기업 00035', { balance: 500000000, rate: 4.7889 }, '2026-09', 1968041],  // 30일
    ['국민 97409', { balance: 3200000000, rate: 3.17 },  '2026-09', 8337534],  // 30일
    ['우리 18984', { balance: 300000000, rate: 2.88 },   '2026-10', 733808],   // 31일
    ['우리 18238', { balance: 400000000, rate: 2.74 },   '2026-10', 930849],   // 31일
  ];
  for (const [name, L, ym, want] of cases)
    t(`일수식 ${name}`, Math.abs(r0(api.loanInterestFor(L, ym)) - want) <= 1, true);
  t('÷12 였다면 31일달이 어긋남', r0(300000000 * 2.88 / 100 / 12), 720000);   // 실측 733,808 과 1.9% 차
}
// ── (2) intAmount 가 계산을 덮지 않는다 ─────────────────────────────────
{
  const api = mk([], []);
  const L = { balance: 2364909091, rate: 3.35, intAmount: 2557321 };   // 낡은 입력값
  t('intAmount 무시하고 계산', r0(api.loanInterestFor(L, '2026-11')) > 6000000, true);
}
// ── (3)(4) 거치 / 상환 분기 ─────────────────────────────────────────────
{
  const api = mk([], []);
  const grace  = { balance: 300000000, principal: 300000000, rate: 2.88, repay: '원리금균등', monthly: 1940000 };
  const paying = { balance: 67900000,  principal: 70000000,  rate: 3.24, repay: '원리금균등', monthly: 1940000 };
  t('거치 중이면 원금분 제외', [api.loanInGrace(grace), api.loanMonthlyOut(grace, '2026-11').kind], [true, '이자']);
  t('  금액은 이자만', r0(api.loanMonthlyOut(grace, '2026-11').amt), r0(api.loanInterestFor(grace, '2026-11')));
  const mo = api.loanMonthlyOut(paying, '2026-10');
  /* 실제 출금 2,110,731(2026-10-12)은 9/12~10/12 = 30일치다. 달력 10월은 31일이라
     계산값이 조금 크게 나온다 — 이자 기간과 달력 달은 원래 안 맞는다. 1% 안이면 맞는 것으로 본다. */
  t('상환 중이면 원금분+이자', [mo.kind, r0(mo.principal), Math.abs(mo.amt - 2110731) / 2110731 < 0.01], ['원리금', 1940000, true]);
  const noMonthly = { ...paying, monthly: 0 };
  t('월상환액 미입력이면 partial', api.loanMonthlyOut(noMonthly, '2026-10').partial, true);
  t('만기일시는 거치 여부와 무관하게 이자만', api.loanMonthlyOut({ balance: 1e8, principal: 2e8, rate: 3, repay: '만기일시' }, '2026-11').kind, '이자');
}
// ── (5) 역산 검증 — 적요 매칭 ───────────────────────────────────────────
{
  const loans = [
    { account: '810116-04-598927', balance: 2364909091, rate: 3.35, principal: 3280000000, repay: '만기일시' },
    { account: '487-060219-32-00033', balance: 200000000, rate: 5.2685, principal: 200000000, repay: '만기일시' },
    { account: '2700-4666-218984', balance: 300000000, rate: 2.88, principal: 300000000, repay: '원리금균등' },
  ];
  const cf = [
    { status: '실제 지출', out: 4632755, date: '2026-10-12', desc: '81011604598927', mid_cat: '이자비용' },
    { status: '실제 지출', out: 866054,  date: '2026-10-27', desc: '이자-32-00033 다음납입예정일-20261127', mid_cat: '이자비용' },
    { status: '실제 지출', out: 733808,  date: '2026-10-29', desc: '중진공대출', mid_cat: '이자비용' },
  ];
  const api = mk(cf, loans);
  const a = api.loanBalanceCheck(loans[0]);
  t('국민 — 적요=계좌번호로 매칭', [a !== null, a && a.ok, r0(a.actual)], [true, false, 4632755]);
  t('  역산 잔액이 기록보다 작다', a.impliedBal < loans[0].balance, true);
  const b = api.loanBalanceCheck(loans[1]);
  t('기업 — 하이픈 끊긴 적요도 매칭', [b !== null, r0(b.actual)], [true, 866054]);
  t('  10% 안이라 경고 아님', b.ok, true);
  t('우리/중진공 — 적요에 숫자 없어 검사 안 함', api.loanBalanceCheck(loans[2]), null);
  // 원금 상환 행이 섞여도 이자비용만 본다
  const api2 = mk([...cf, { status: '실제 지출', out: 900000000, date: '2026-11-01', desc: '81011604598927', mid_cat: '차입금상환' }], loans);
  t('이자비용 아닌 행은 무시', r0(api2.loanBalanceCheck(loans[0]).actual), 4632755);
}

console.log(`\n${fail ? '❌' : '✅'} ${pass}/${pass + fail} 통과`);
process.exit(fail ? 1 : 0);

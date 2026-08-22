#!/usr/bin/env node
/**
 * test-cf-match.mjs — cf-match.mjs 의 매칭 규칙 검증. 네트워크 없음.
 *
 * 왜 필요한가: clobe_id 없이 날짜+금액으로 맞추는 추정 로직이라, 조용히 틀리면
 * "누락 0건" 이라는 잘못된 안심을 준다. 카드 적재에서 42건 16.5억이 조용히 빠진 게
 * 그런 종류의 사고였다. 규칙을 바꿀 때마다 이걸 돌린다.
 */

import { matchTx, addDays } from './cf-match.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}\n       받음 ${JSON.stringify(got)}\n       기대 ${JSON.stringify(want)}`); }
};
const C = (date, amt, desc = '') => ({ date, amt, desc, acc: '테스트' });
const O = (date, amt, cat = '-/-') => ({ date, amt, cat, desc: '', _id: `x${date}${amt}${Math.abs(amt)}` });

console.log('\n[addDays — 월·연 경계와 윤년]');
eq('2026-01-31 +1', addDays('2026-01-31', 1), '2026-02-01');
eq('2026-03-01 -1', addDays('2026-03-01', -1), '2026-02-28');
eq('2026-12-31 +1', addDays('2026-12-31', 1), '2027-01-01');
eq('2028-02-28 +1 (윤년)', addDays('2028-02-28', 1), '2028-02-29');

console.log('\n[1단계 — 같은 날·같은 금액]');
{
  const r = matchTx([C('2026-03-03', -548367), C('2026-03-03', 957179)],
                    [O('2026-03-03', 957179), O('2026-03-03', -548367)]);
  eq('순서 달라도 2건 매칭', [r.matched1, r.missing.length, r.ghost.length], [2, 0, 0]);
}

console.log('\n[1단계 — 같은 날 같은 금액이 여러 건 (다중집합)]');
{
  /* 실제 사례: 2026-07-09 745,945,000 이 2건. Set 으로 맞추면 1건이 누락으로 잡힌다. */
  const r = matchTx([C('2026-07-09', 745945000), C('2026-07-09', 745945000)],
                    [O('2026-07-09', 745945000), O('2026-07-09', 745945000)]);
  eq('2건 전부 매칭 (누락 0)', [r.matched1, r.missing.length, r.ghost.length], [2, 0, 0]);
}
{
  const r = matchTx([C('2026-07-09', 745945000), C('2026-07-09', 745945000), C('2026-07-09', 745945000)],
                    [O('2026-07-09', 745945000), O('2026-07-09', 745945000)]);
  eq('클로브 3 vs cf 2 → 누락 1건', [r.matched1, r.missing.length, r.ghost.length], [2, 1, 0]);
}
{
  const r = matchTx([O('2026-07-09', 745945000)].map((o) => C(o.date, o.amt)),
                    [O('2026-07-09', 745945000), O('2026-07-09', 745945000)]);
  eq('클로브 1 vs cf 2 → 유령 1건', [r.matched1, r.missing.length, r.ghost.length], [1, 0, 1]);
}

console.log('\n[2단계 — ±1일 어긋남]');
{
  const r = matchTx([C('2026-04-20', -76234976)], [O('2026-04-21', -76234976)]);
  eq('하루 뒤 → 매칭', [r.matched1, r.matched2, r.missing.length], [0, 1, 0]);
}
{
  const r = matchTx([C('2026-04-20', -76234976)], [O('2026-04-19', -76234976)]);
  eq('하루 앞 → 매칭', [r.matched2, r.missing.length], [1, 0]);
}
{
  const r = matchTx([C('2026-04-20', -76234976)], [O('2026-04-23', -76234976)]);
  eq('사흘 차 → 매칭 안 함(누락)', [r.matched2, r.missing.length, r.ghost.length], [0, 1, 1]);
}

console.log('\n[3단계 — 분할 매칭 (클로브 1 = cf 2)]');
{
  /* 실제 사례: 2026-07-09 외환차손 분할. 754,950,000 = 745,945,000 + 9,005,000 */
  const r = matchTx([C('2026-07-09', -754950000)],
                    [O('2026-07-09', -745945000, '자금이동/계좌간이체'), O('2026-07-09', -9005000, '영업외비용/외환차손')]);
  eq('합이 맞는 2건으로 매칭', [r.matched3, r.missing.length, r.ghost.length], [1, 0, 0]);
  eq('분할 내역 보고', r.splitHits.map((s) => s.parts.map((p) => p.amt)), [[-745945000, -9005000]]);
}
{
  const r = matchTx([C('2026-07-09', -754950000)],
                    [O('2026-07-09', -745945000), O('2026-07-09', -9005001)]);
  eq('합이 1원이라도 다르면 분할 아님', [r.matched3, r.mismatch.length], [0, 1]);
}
{
  /* 방향이 다르면 짝이 아니다 — 입금 + 출금으로 합을 맞추면 안 된다 */
  const r = matchTx([C('2026-05-08', 20000000)],
                    [O('2026-05-08', 60000000), O('2026-05-08', -40000000)]);
  eq('입금+출금 조합은 분할로 안 봄', [r.matched3, r.missing.length], [0, 1]);
}

console.log('\n[4단계 — 금액 불일치 (2% 이내)]');
{
  /* 환전 스프레드 1.19% — 이 그물에 걸려야 한다 */
  const r = matchTx([C('2026-07-09', -754950000)], [O('2026-07-09', -745945000)]);
  eq('1.19% 차 → 불일치로 잡힘', [r.mismatch.length, r.missing.length], [1, 0]);
  eq('차액 부호·크기', r.mismatch.map((m) => m.gap), [-9005000]);
}
{
  const r = matchTx([C('2026-07-09', -1000000000)], [O('2026-07-09', -900000000)]);
  eq('10% 차 → 불일치 아님(누락+유령)', [r.mismatch.length, r.missing.length, r.ghost.length], [0, 1, 1]);
}
{
  /* 여러 후보 중 가장 가까운 것을 물어야 한다 */
  const r = matchTx([C('2026-07-09', -1000000)],
                    [O('2026-07-09', -1015000), O('2026-07-09', -1001000)]);
  eq('가장 가까운 후보와 짝', r.mismatch.map((m) => m.o.amt), [-1001000]);
  eq('남은 하나는 유령', r.ghost.map((g) => g.amt), [-1015000]);
}
{
  const r = matchTx([C('2026-07-09', -1000000)], [O('2026-07-09', 1010000)]);
  eq('방향 다르면 불일치로 안 봄', [r.mismatch.length, r.missing.length, r.ghost.length], [0, 1, 1]);
}

console.log('\n[경계 — 빈 입력, 원본 불변]');
{
  const r = matchTx([], []);
  eq('양쪽 비어 있음', [r.matched1, r.missing.length, r.ghost.length], [0, 0, 0]);
}
{
  const r = matchTx([C('2026-02-15', -50000000)], []);
  eq('cf_data 통째로 비어 있음 → 전부 누락', [r.missing.length, r.ghost.length], [1, 0]);
}
{
  const cl = [C('2026-03-03', 957179)], os = [O('2026-03-03', 957179)];
  matchTx(cl, os);
  eq('호출 후 입력 배열 길이 불변', [cl.length, os.length], [1, 1]);
}

console.log(`\n${fail ? '❌' : '✅'} ${pass}/${pass + fail} 통과`);
process.exit(fail ? 1 : 0);

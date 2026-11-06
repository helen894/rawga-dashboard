#!/usr/bin/env node
/**
 * test-loan-plan-move.mjs — 이자 출금일 변경 시 예정 행 이동 회귀 테스트.
 *
 * 왜 있는가 (2026-11-06)
 *   generateLoanPlanned 의 중복 판정이 loan_id+date 라, 출금일만 바꾸면 옛 날짜 행이
 *   남은 채 새 날짜에 하나가 더 생겨 그 달 이자가 두 번 잡힌다. 우리은행(중진공)
 *   2700-4666-218984 를 29일로 바꾸신 건은 마침 겹치는 달이 없어 조용히 넘어갔다.
 *
 * 무엇을 지키는가
 *   (1) 옛 설정이 만들었을 바로 그 날짜에 있는 행만 옮긴다
 *   (2) 사람이 손으로 옮겨 둔 행은 안 건드린다  ← 이게 제일 중요하다
 *   (3) 실제 거래·지난 날짜는 안 건드린다
 *   (4) 옮길 자리에 이미 행이 있으면 중복을 만들지 않고 건너뛰며 보고한다
 *
 * 판정 함수는 index.html 에서 떼어 와 쓴다. 사본을 만들면 화면과 테스트가 갈린다.
 * 쓰는 법: node scripts/test-loan-plan-move.mjs
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`${name} 를 index.html 에서 못 찾음`);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error(`${name} 본문 끝을 못 찾음`);
};

const TODAY = '2026-11-06';
const mk = (rows) => {
  const cfData = rows;
  const fn = new Function('cfData', 'todayKST', 'saveData', `
    ${grab('loanShiftToBizDay')}
    ${grab('moveLoanPlanDates')}
    return moveLoanPlanDates;`)(cfData, () => TODAY, () => {});
  return { cfData, move: fn };
};
const plan = (date, acct = 'A', out = 733808) =>
  ({ _id: 'p' + date, date, desc: '우리은행(중진공) 18984', in: 0, out, status: '지출 예정', loan_id: acct });

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// ① 실제 사례 — 25일 → 29일. 11/25→11/30(29일이 일요일), 12/25→12/29
{
  const { cfData, move } = mk([plan('2026-11-25'), plan('2026-12-25'), plan('2027-01-25')]);
  const r = move('A', 25, 29);
  t('출금일 25→29 · 3개월 이동', [r.moved, cfData.map(x => x.date)],
    [3, ['2026-11-30', '2026-12-29', '2027-01-29']]);
  t('  건너뛴 달 없음', r.skipped, []);
}
// ② 사람이 손으로 옮겨 둔 행은 보호된다  ← 핵심
{
  const { cfData, move } = mk([plan('2026-11-27'), plan('2026-12-25')]);   // 11월은 손으로 27일로 옮겨 둠
  const r = move('A', 25, 29);
  t('손으로 옮긴 11월 행은 그대로', cfData.map(x => x.date), ['2026-11-27', '2026-12-29']);
  t('  옮긴 건 12월 1건뿐', r.moved, 1);
}
// ③ 실제 거래는 안 건드린다
{
  const real = { ...plan('2026-11-25'), status: '실제 지출' };
  const { cfData, move } = mk([real, plan('2026-12-25')]);
  const r = move('A', 25, 29);
  t('실제 지출 행 보호', [r.moved, cfData[0].date], [1, '2026-11-25']);
}
// ④ 지난 날짜는 안 건드린다
{
  const { cfData, move } = mk([plan('2026-10-25'), plan('2026-12-25')]);
  const r = move('A', 25, 29);
  t('지난 달 행 보호', [r.moved, cfData.map(x => x.date)], [1, ['2026-10-25', '2026-12-29']]);
}
// ⑤ 옮길 자리에 이미 행이 있으면 중복을 안 만든다
{
  const { cfData, move } = mk([plan('2026-12-25'), { ...plan('2026-12-29'), _id: 'dup' }]);
  const r = move('A', 25, 29);
  t('중복 자리 회피', [r.moved, r.skipped.length], [0, 1]);
  t('  행 수 그대로', cfData.length, 2);
}
// ⑥ 다른 대출은 건드리지 않는다
{
  const { cfData, move } = mk([plan('2026-12-25', 'A'), plan('2026-12-25', 'B')]);
  move('A', 25, 29);
  // ⚠ 이동 뒤 cfData 는 날짜순으로 다시 정렬된다(의도된 동작) — 순서 말고 내용으로 본다
  t('다른 계좌 보호', cfData.map(x => `${x.loan_id}:${x.date}`).sort(), ['A:2026-12-29', 'B:2026-12-25'].sort());
}
// ⑦ 주말 보정으로 결국 같은 날이면 아무 것도 안 한다
{
  // 2026-12-26(토)→28(월) · 2026-12-27(일)→28(월) — 26일과 27일은 같은 자리로 간다
  const { cfData, move } = mk([plan('2026-12-28')]);
  const r = move('A', 26, 27);
  t('보정 후 같은 날이면 무동작', [r.moved, cfData[0].date], [0, '2026-12-28']);
}
// ⑧ 말일 보정 — 31일 설정은 달마다 말일로
{
  const { cfData, move } = mk([plan('2027-02-25')]);
  const r = move('A', 25, 31);     // 2027-02 말일 28일(일) → 3/1(월)
  t('말일 보정', [r.moved, cfData[0].date], [1, '2027-03-01']);
}

console.log(`\n${fail ? '❌' : '✅'} ${pass}/${pass + fail} 통과`);
process.exit(fail ? 1 : 0);

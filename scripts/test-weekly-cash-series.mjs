#!/usr/bin/env node
/**
 * test-weekly-cash-series.mjs — 주간 리포트 '일별 현금 잔액 추이·궤적' 계산 검증.
 *
 * 왜: 경계 조건이 많다. 확정/궤적의 경계는 **오늘**이지 선택 주차의 끝이 아니고, 주차를
 * 앞뒤로 넘기면 과거 주차(전부 확정) · 현재 주차(중간에 갈림) · 미래 주차(전부 궤적)가
 * 모두 나온다. 여기에 연체 예정(오늘로 몰아 얹기)까지 겹친다. 차트는 틀려도 그냥
 * 그럴듯한 선이 그려지므로 눈으로는 못 잡는다.
 *
 * 어떻게: index.html 에서 computeWeeklyCashSeries 와 addDays 를 그대로 잘라내 격리 실행한다.
 *
 * 실행: node scripts/test-weekly-cash-series.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function grab(name){
  const i = html.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('없음: ' + name);
  let d = 0, started = false;
  for (let j = html.indexOf('{', i); j < html.length; j++){
    if (html[j] === '{') { d++; started = true; }
    else if (html[j] === '}') { d--; if (started && d === 0) return html.slice(i, j+1); }
  }
  throw new Error('불균형: ' + name);
}
const fn = new Function(`${grab('addDays')}\n${grab('computeWeeklyCashSeries')}\nreturn computeWeeklyCashSeries;`)();

const INIT = 1000, FX = 0, H = 14;          // 기초 1000 · 환산손익 0 · 2주로 짧게
const A_IN  = (date, v) => ({ date, status: '실제 입금', in: v, out: 0 });
const A_OUT = (date, v) => ({ date, status: '실제 지출', in: 0, out: v });
const P_IN  = (date, v) => ({ date, status: '입금 예정', in: v, out: 0 });
const P_OUT = (date, v) => ({ date, status: '지출 예정', in: 0, out: v });

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '  ✅' : '  ❌'} ${label}${ok ? '' : `\n       기대 ${JSON.stringify(want)}\n       실제 ${JSON.stringify(got)}`}`);
  ok ? pass++ : fail++;
};
const at = (S, ymd) => { const i = S.dates.indexOf(ymd); return i < 0 ? 'OUT_OF_RANGE' : i; };

console.log('');
console.log('[1] 현재 주차 — 오늘에서 확정→궤적으로 갈린다');
/* 주 시작 06-01(월), 오늘 06-03. 06-02 실제입금 +500, 06-05 지출예정 -200 */
let S = fn('2026-06-01', [A_IN('2026-06-02', 500), P_OUT('2026-06-05', 200)], INIT, FX, '2026-06-03', H);
check('구간 시작', S.dates[0], '2026-06-01');
check('구간 끝(14일)', S.dates[13], '2026-06-14');
check('06-01 확정 = 기초', S.actVals[at(S,'2026-06-01')], 1000);
check('06-02 확정 = 1500', S.actVals[at(S,'2026-06-02')], 1500);
check('06-03(오늘) 확정 = 1500', S.actVals[at(S,'2026-06-03')], 1500);
check('06-04 확정은 null', S.actVals[at(S,'2026-06-04')], null);
check('궤적은 오늘 지점에서 이어짐', S.projVals[at(S,'2026-06-03')], 1500);
check('06-04 궤적 = 1500(예정 없음)', S.projVals[at(S,'2026-06-04')], 1500);
check('06-05 궤적 = 1300', S.projVals[at(S,'2026-06-05')], 1300);

console.log('');
console.log('[2] 과거 주차 — 구간 전체가 확정, 궤적 없음');
S = fn('2026-05-04', [A_IN('2026-05-05', 300)], INIT, FX, '2026-06-03', H);
check('마지막 날도 확정', S.actVals[13] !== null, true);
check('궤적은 전부 null', S.projVals.every(v => v === null), true);
check('05-05 확정 = 1300', S.actVals[at(S,'2026-05-05')], 1300);

console.log('');
console.log('[3] ⚠ 미래 주차 — 전부 궤적. 오늘~구간시작 사이 예정도 반영돼야 한다');
/* 오늘 06-03, 주 시작 06-15. 그 사이 06-10 에 -400 예정이 있으면 출발점이 600 이어야 한다. */
S = fn('2026-06-15', [P_OUT('2026-06-10', 400), P_OUT('2026-06-16', 100)], INIT, FX, '2026-06-03', H);
check('확정은 전부 null', S.actVals.every(v => v === null), true);
check('구간 밖 예정이 출발점에 반영', S.startProj, 600);
check('06-15 궤적 = 600', S.projVals[at(S,'2026-06-15')], 600);
check('06-16 궤적 = 500', S.projVals[at(S,'2026-06-16')], 500);

console.log('');
console.log('[4] 연체 예정 — 오늘 시점에 한꺼번에 얹는다 (과거로 그리지 않는다)');
/* 오늘 06-03. 06-01 에 지출예정 -700 이 남아 있다(실제로 안 나감) */
S = fn('2026-06-01', [P_OUT('2026-06-01', 700), P_OUT('2026-06-05', 100)], INIT, FX, '2026-06-03', H);
check('연체 합계', S.overdueSum, -700);
check('연체 건수', S.overdueN, 1);
check('확정선은 연체에 안 흔들림', S.actVals[at(S,'2026-06-01')], 1000);
/* 이음점은 '확정값' 이다(연체 미포함) — 두 선이 만나야 하니까. 연체는 그 다음 칸부터
   반영돼 확정 끝 → 첫 궤적 점의 낙차로 보인다(대시보드 추이 차트와 같은 표현). */
check('이음점은 확정값 그대로', S.projVals[at(S,'2026-06-03')], 1000);
check('궤적 누적 출발점에 연체 반영', S.startProj, 300);
check('06-04 궤적 = 300 (연체 반영된 첫 칸)', S.projVals[at(S,'2026-06-04')], 300);
check('06-05 궤적 = 200', S.projVals[at(S,'2026-06-05')], 200);

console.log('');
console.log('[5] 구간 이전 거래가 기초에 누적된다');
S = fn('2026-06-01', [A_IN('2026-05-20', 250), A_OUT('2026-05-25', 50)], INIT, FX, '2026-06-03', H);
check('06-01 확정 = 1200', S.actVals[at(S,'2026-06-01')], 1200);

console.log('');
console.log('[6] 거래 없는 날은 앞값을 이어 간다 (0 으로 떨어지지 않는다)');
S = fn('2026-06-01', [A_IN('2026-06-01', 100)], INIT, FX, '2026-06-03', H);
check('06-02', S.actVals[at(S,'2026-06-02')], 1100);
check('06-03', S.actVals[at(S,'2026-06-03')], 1100);

console.log('');
console.log('[7] 환산손익(FX_ADJ)이 기준선에 얹힌다 — 대시보드와 같은 기준');
S = fn('2026-06-01', [], INIT, -300, '2026-06-03', H);
check('06-01 = 700', S.actVals[at(S,'2026-06-01')], 700);

console.log('');
console.log('[8] 구간을 벗어난 예정은 궤적에 안 들어간다');
S = fn('2026-06-01', [P_OUT('2026-07-20', 900)], INIT, FX, '2026-06-03', H);
check('마지막 날 궤적 = 1000', S.projVals[13], 1000);

console.log('');
console.log(`${fail === 0 ? '✅ 전부 통과' : '❌ 실패 ' + fail + '건'} (${pass}/${pass+fail})`);
process.exitCode = fail ? 1 : 0;

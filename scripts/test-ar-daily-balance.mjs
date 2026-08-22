#!/usr/bin/env node
/**
 * test-ar-daily-balance.mjs — 매출채권 일별 잔액(arDailyDelta) 검증.
 *
 * 왜: 회수일이 비어 있는 행이 32건 46.4억(전체 회수의 25%)이라, 그 회수 시점을 추정해야
 * 일별 채권 곡선이 나온다. 추정이 틀리면 총자산 구성 차트에서 **가장 큰 층**이 통째로
 * 어긋난다. 그런데 차트는 틀려도 그럴듯한 그림이 나오므로 눈으로는 못 잡는다.
 *
 * 핵심 불변식: 마지막 날의 채권 잔액 = ar_data 미회수 합계.
 * 추정이 어디로 가든 **총액은 보존돼야** 한다 — 이게 깨지면 추정 로직이 금액을 잃거나
 * 이중으로 뺀 것이다.
 *
 * 실행: node scripts/test-ar-daily-balance.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
function grab(name){
  const i = html.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('없음: ' + name);
  let d = 0, st = false;
  for (let j = html.indexOf('{', i); j < html.length; j++){
    if (html[j] === '{') { d++; st = true; }
    else if (html[j] === '}') { d--; if (st && d === 0) return html.slice(i, j+1); }
  }
}
const LAG = Number((html.match(/const AR_LAG_DAYS = (\d+)/) || [])[1]);
const FB  = Number((html.match(/const AR_FALLBACK_DAYS = (\d+)/) || [])[1]);
const fn = new Function(`
  const AR_LAG_DAYS = ${LAG}, AR_FALLBACK_DAYS = ${FB};
  ${grab('addDays')}
  ${grab('arDailyDelta')}
  return { arDailyDelta: arDailyDelta, addDays: addDays };`)();
const addDays = fn.addDays;

const T = '2026-06-30';
const bal = (arRows, cfRows, upto) => {
  const { delta } = fn.arDailyDelta(arRows, cfRows, T);
  return Object.keys(delta).filter(d => d <= upto).reduce((s, d) => s + delta[d], 0);
};
let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '  ✅' : '  ❌'} ${label}${ok ? '' : `\n       기대 ${JSON.stringify(want)}\n       실제 ${JSON.stringify(got)}`}`);
  ok ? pass++ : fail++;
};
const AR = (o) => ({ partner:'P', start:'', due_date:'', collect_date:'', expected:0, collected:0, ...o });
const DEP = (date, amt, t) => ({ date, status:'실제 입금', in: amt, out: 0, mid_cat: t, desc: '' });

console.log('');
console.log(`설정: 예정일+${LAG}일 · 발생일+${FB}일`);

console.log('');
console.log('[1] 회수일이 있으면 그 날짜에 그대로 빠진다');
let r = fn.arDailyDelta([AR({ start:'2026-01-10', expected:100, collected:100, collect_date:'2026-02-05' })], [], T);
check('발생일 +100', r.delta['2026-01-10'], 100);
check('회수일 -100', r.delta['2026-02-05'], -100);
check('실제 회수로 집계', r.byRule.actual, 100);

console.log('');
console.log('[2] ① 실제 입금 FIFO — 거래처 입금일로 빠진다');
r = fn.arDailyDelta([AR({ partner:'디앤비푸드', start:'2026-01-31', expected:300, collected:300 })],
       [DEP('2026-02-10', 200, '디앤비푸드'), DEP('2026-02-20', 500, '디앤비푸드')], T);
check('첫 입금일 -200', r.delta['2026-02-10'], -200);
check('두 번째 입금일 -100', r.delta['2026-02-20'], -100);
check('FIFO 집계', r.byRule.fifo, 300);

console.log('');
console.log('[3] 발생일 이전 입금은 그 채권 것이 아니다');
r = fn.arDailyDelta([AR({ partner:'A', start:'2026-03-01', expected:100, collected:100, due_date:'2026-03-20' })],
       [DEP('2026-01-05', 999, 'A')], T);
check('과거 입금 안 씀', r.byRule.fifo, 0);
check('예정일+9일로', r.delta[`2026-03-29`], -100);

console.log('');
console.log('[4] ② 예정일이 미래면 쓰지 않는다 (로가온 2027-04-30 사례)');
r = fn.arDailyDelta([AR({ partner:'로가온', start:'2026-02-26', expected:100, collected:100, due_date:'2027-04-30' })], [], T);
check('예정일 규칙 안 씀', r.byRule.due, 0);
check('발생일+30일로', r.delta['2026-03-28'], -100);
check('2027년으로 안 감', Object.keys(r.delta).every(d => d <= T), true);

console.log('');
console.log('[5] 추정일이 오늘보다 뒤면 오늘로 당긴다');
r = fn.arDailyDelta([AR({ partner:'B', start:'2026-06-25', expected:50, collected:50 })], [], T);
check('오늘로 당겨짐', r.delta[T], -50);

console.log('');
console.log('[6] ⚠ 총액 보존 — 어떤 조합이든 마지막 잔액 = 예상−회수');
const mix = [
  AR({ partner:'디앤비푸드', start:'2025-09-30', expected:1000, collected:1000 }),
  AR({ partner:'천대표', start:'2026-01-05', expected:800, collected:300, due_date:'2026-02-01' }),
  AR({ partner:'로가온', start:'2026-02-26', expected:500, collected:500, due_date:'2027-04-30' }),
  AR({ partner:'C', start:'2026-03-03', expected:400, collected:0 }),
  AR({ partner:'D', start:'2026-04-04', expected:200, collected:200, collect_date:'2026-05-05' }),
];
const cfm = [DEP('2025-11-01', 600, '디앤비푸드'), DEP('2026-02-10', 300, '천대표')];
const want = mix.reduce((s, x) => s + x.expected - x.collected, 0);
check('마지막 잔액 = 예상−회수', bal(mix, cfm, T), want);
const rr = fn.arDailyDelta(mix, cfm, T);
check('규칙별 합 = 총 회수액',
  rr.byRule.actual + rr.byRule.fifo + rr.byRule.due + rr.byRule.fallback,
  mix.reduce((s, x) => s + x.collected, 0));

console.log('');
console.log('[7] 잔액이 중간에 음수로 내려가지 않는다 (회수가 발생보다 먼저 빠지면 안 됨)');
/* ⚠ toISOString() 로 하루씩 더하면 KST 자정이 UTC 전날 15:00 이라 날짜가 안 올라가고
   무한 루프가 된다(작성 중 실제로 밟았다). index.html 의 addDays 를 쓴다. */
const days = [];
for (let d = '2025-09-01'; d <= T; d = addDays(d, 1)) days.push(d);
let run = 0, minv = 0;
const dl = fn.arDailyDelta(mix, cfm, T).delta;
for (const d of days) { run += (dl[d] || 0); if (run < minv) minv = run; }
check('최저 잔액 ≥ 0', minv >= 0, true);

console.log('');
console.log(`${fail === 0 ? '✅ 전부 통과' : '❌ 실패 ' + fail + '건'} (${pass}/${pass+fail})`);
process.exitCode = fail ? 1 : 0;

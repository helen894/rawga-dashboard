#!/usr/bin/env node
/**
 * test-pending-due.mjs — 입출금 예정 임박 알림(collectPendingDue)의 분류 규칙을 검증한다.
 *
 * 핵심은 '지남' 을 두 갈래로 나누는 것이다:
 *   · 미집행  — 적재가 덮은 날(covered)인데도 예정이 남아 있다 → 실제로 안 나갔다
 *   · 확인 전 — covered 보다 뒤 날짜 → 아직 적재가 안 됐을 뿐, 단정할 수 없다
 * 이 구분이 없으면 적재(평일 09:10) 전에 대시보드를 여는 매일 아침 가짜 경보가 뜬다.
 *
 * index.html 의 함수 본문을 그대로 떼어 와 돌린다 — 사본을 만들면 원본과 갈린다.
 */
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`${name} 를 못 찾음`);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error(`${name} 본문 끝을 못 찾음`);
};
const addDays = (d, n) => { const [y,m,dd]=d.split('-').map(Number);
  const t=new Date(Date.UTC(y,m-1,dd+n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth()+1).padStart(2,'0')}-${String(t.getUTCDate()).padStart(2,'0')}`; };
/* 임박 일수도 원본에서 읽는다 — 테스트에 상수를 베껴 두면 원본이 바뀔 때 조용히 갈린다. */
const DUE_DAYS = Number((src.match(/const PENDING_DUE_DAYS\s*=\s*(\d+)/) || [])[1]);
if (!Number.isFinite(DUE_DAYS)) throw new Error('PENDING_DUE_DAYS 를 못 읽음');
console.log(`원본에서 읽은 PENDING_DUE_DAYS = ${DUE_DAYS}
`);
let TODAY = '2026-09-18', cfData = [];
const fn = new Function('addDays', 'getCf', 'getToday', 'PENDING_DUE_DAYS', `
  const todayKST = getToday;
  Object.defineProperty(globalThis, 'cfData', { get: getCf, configurable: true });
  ${grab('collectPendingDue')}
  return collectPendingDue;`)(addDays, () => cfData, () => TODAY, DUE_DAYS);

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '  OK ' : '  X  '} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const P = (date, out = 1000, status = '지출 예정') => ({ date, status, out, in: 0 });
const A = (date, out = 1000) => ({ date, status: '실제 지출', out, in: 0 });

console.log('=== 적재 커버리지에 따른 분류 ===');
cfData = [A('2026-09-17'), P('2026-09-16'), P('2026-09-17'), P('2026-09-18'), P('2026-09-21'), P('2026-09-22')];
let r = fn();
eq('covered = 실거래 마지막 날', r.covered, '2026-09-17');
eq('9/16·9/17 예정 → 미집행 2건', r.overdue.length, 2);
eq('확인 전 0건', r.unconfirmed.length, 0);
eq(`오늘(9/18)·D+${DUE_DAYS}(9/21) → 임박 2건`, r.soon.length, 2);
eq('D+4(9/22) 는 제외', r.soon.map(x => x.date).includes('2026-09-22'), false);

console.log('\n=== 적재가 뒤처진 아침 (가짜 경보 방지) ===');
cfData = [A('2026-09-15'), P('2026-09-16'), P('2026-09-17')];
r = fn();
eq('covered 가 9/15 면 9/16·9/17 은 미집행 아님', r.overdue.length, 0);
eq('둘 다 확인 전으로', r.unconfirmed.length, 2);

console.log('\n=== 실거래가 아예 없을 때 ===');
cfData = [P('2026-09-10')];
r = fn();
eq('covered 빈값이면 단정하지 않는다', r.overdue.length, 0);
eq('확인 전으로 1건', r.unconfirmed.length, 1);

console.log('\n=== 입금 예정도 대상 ===');
cfData = [A('2026-09-17'), { date: '2026-09-16', status: '입금 예정', in: 5000, out: 0 }];
r = fn();
eq('입금 예정도 미집행으로 잡힘', r.overdue.length, 1);
eq('순액은 부호 그대로', r.overdueNet, 5000);

console.log('\n=== 실제/예정 아닌 행은 무시 ===');
cfData = [A('2026-09-17'), { date: '2026-09-16', status: '보류', out: 100, in: 0 }];
r = fn();
eq('상태가 예정이 아니면 제외', r.overdue.length + r.unconfirmed.length + r.soon.length, 0);

console.log(`\n${fail ? `X ${fail}건 실패` : `전부 통과 (${pass}/${pass})`}`);
process.exitCode = fail ? 1 : 0;

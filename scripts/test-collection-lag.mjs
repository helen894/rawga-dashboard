#!/usr/bin/env node
/**
 * test-collection-lag.mjs — 클로브 수집 지연 일수 판정을 못 박는다.
 *
 * 왜 있는가 (2026-11-23)
 *   07:00 예약 실행이 **매일 성공했는데 대시보드는 하루 늦었다.** 클로브가 그날 자료를
 *   긁는 시각이 09:13 이라, 07:00 에 읽으면 늘 어제치였다. 실제로 11-23 07:06 에 빠진
 *   카드대금 6,148,296 이 그래서 하루 밀렸고, 로그는 '거래 없음' 이라 아무도 몰랐다.
 *   예약을 10:00 으로 옮기면서 **지연 일수를 머리줄에 찍게** 했는데, 그 판정이 틀리면
 *   경고가 안 뜨거나(놓침) 매일 뜬다(아무도 안 봄). 둘 다 지금 상태로 되돌아가는 길이다.
 *
 * 쓰는 법: node scripts/test-collection-lag.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../apps-script/clobe-direct-ingest.gs', import.meta.url), 'utf8');

/* 파일 전체를 돌리면 GAS 전역이 없어 터진다. 순수 함수 하나만 떼어 온다.
   ⚠ 베껴 적지 않는다 — 베끼면 소스가 바뀌어도 테스트는 옛 사본을 통과시킨다. */
const m = src.match(/function collectionLagDays_\([\s\S]*?\n}/);
if (!m) { console.error('❌ collectionLagDays_ 를 소스에서 못 찾았습니다 (이름이 바뀌었나?)'); process.exit(1); }
const ctx = vm.createContext({});
vm.runInContext(m[0] + '\nglobalThis.lag = collectionLagDays_;', ctx);
const lag = ctx.lag;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (got === want) { pass++; console.log(`  ✅ ${name.padEnd(42)} ${got}`); }
  else { fail++; console.log(`  ❌ ${name.padEnd(42)} ${got} (기대 ${want})`); }
};

console.log('\n클로브 수집 지연 판정\n');

/* 본래 쓰임 */
eq('당일 수집', lag('2026-11-23', '2026-11-23'), 0);
eq('하루 지연 — 11-23 에 본 사고', lag('2026-11-22', '2026-11-23'), 1);
eq('이틀 지연 — 메일 경계(>=2)', lag('2026-11-21', '2026-11-23'), 2);
eq('사흘 지연', lag('2026-11-20', '2026-11-23'), 3);

/* 판정 불가 — 0 으로 떨어져야 한다. 경고를 올리면 매일 울어서 아무도 안 본다. */
eq("빈 문자열", lag('', '2026-11-23'), 0);
eq("'(확인 실패)' — get_scraping_status 실패 시", lag('(확인 실패)', '2026-11-23'), 0);
eq('null', lag(null, '2026-11-23'), 0);
eq('형식 다른 값(ISO 시각 통째)', lag('2026-11-22T09:13:07', '2026-11-23'), 0);
eq('today 쪽이 깨진 경우', lag('2026-11-22', ''), 0);

/* 시계 어긋남 — 미래를 음수 지연으로 만들지 않는다 */
eq('수집일이 미래', lag('2026-11-24', '2026-11-23'), 0);

/* 경계 — 날짜 산술이 조용히 틀리는 자리 */
eq('월 경계 (10-31 → 11-01)', lag('2026-10-31', '2026-11-01'), 1);
eq('연 경계 (2026-12-31 → 2027-01-01)', lag('2026-12-31', '2027-01-01'), 1);
eq('윤년 2월 (2028-02-28 → 03-01)', lag('2028-02-28', '2028-03-01'), 2);
eq('평년 2월 (2027-02-28 → 03-01)', lag('2027-02-28', '2027-03-01'), 1);
eq('긴 공백 (연휴 끼고 10일)', lag('2026-11-13', '2026-11-23'), 10);

const notifyOk = /if \(lagDays >= 2 && opts\.notifyOnFail\)/.test(src);
eq('이틀 이상 멈추면 실패 아니어도 알림', notifyOk, true);

/* ── 예약표 ────────────────────────────────────────────────────────────────
   지연 판정만 맞고 **클로브 수집 뒤에 도는 회차가 없으면** 아무 소용이 없다.
   11-23 에 당한 게 정확히 그 모양이라, 시각 자체를 요구사항으로 못 박는다. */
console.log('\n예약표 — 마감 기준\n');

const dueRaw = src.match(/var DIRECT_DEADLINES = (\[\[[\s\S]*?\]\]);/);
if (!dueRaw) { console.error('❌ DIRECT_DEADLINES 를 소스에서 못 찾았습니다'); process.exit(1); }
const due = JSON.parse(dueRaw[1]);
const mins = ([h, m]) => h * 60 + m;

eq('하루 3회', due.length, 3);
eq('1회차 마감 07:00', JSON.stringify(due[0]), '[7,0]');
eq('2회차 마감 11:30', JSON.stringify(due[1]), '[11,30]');
eq('3회차 마감 16:30', JSON.stringify(due[2]), '[16,30]');
eq('시·분이 유효 범위', due.every(([h, m]) => h >= 0 && h <= 23 && m >= 0 && m <= 59), true);
eq('같은 마감 중복 없음', new Set(due.map(mins)).size, due.length);

/* ★ 11-23 의 교훈. 회차를 어떻게 바꾸든 클로브 수집 **뒤에 시작하는** 회차가 하나는
   있어야 한다. 가장 이른 시작은 마감-30분이라 거기로 잰다 — 마감으로 재면 11:30
   마감짜리가 실제로는 11:00 에 돌 수 있다는 걸 놓친다.

   기준 09:30 은 **관측된 가장 늦은 수집(11-23 의 09:13)** 보다 뒤로 잡은 값이다.
   수집 시각은 날마다 다르다(11-24 는 02:36 이었다). 더 늦게 수집되는 날이 보이면
   이 숫자를 올린다 — 내리지는 않는다. */
eq('클로브 수집(09:1x) 뒤에 시작하는 회차가 있다',
   due.some((hm) => mins(hm) - 30 >= 9 * 60 + 30), true);

/* 마감 → 중심/구간.
   중심을 마감에 그대로 두면 ±15분 중 **절반이 마감을 넘겨** 돈다. 그게 이번 수정의 전부다. */
const grab = (name) => {
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`));
  if (!m) { console.error(`❌ ${name} 을 소스에서 못 찾았습니다`); process.exit(1); }
  return m[0];
};
vm.runInContext([grab('triggerCenter_'), grab('deadlineSpan_'), grab('hhmm_')].join('\n')
  + '\nglobalThis.center = triggerCenter_; globalThis.span = deadlineSpan_;', ctx);
const { center, span } = ctx;

eq('07:00 마감 → 구간', span(7, 0), '06:30~07:00');
eq('11:30 마감 → 구간', span(11, 30), '11:00~11:30');
eq('16:30 마감 → 구간', span(16, 30), '16:00~16:30');
eq('자정 마감 → 감싼다', span(0, 0), '23:30~00:00');

eq('07:00 마감 → 중심 06:45', JSON.stringify(center(7, 0)), '[6,45]');
eq('11:30 마감 → 중심 11:15', JSON.stringify(center(11, 30)), '[11,15]');
eq('16:30 마감 → 중심 16:15', JSON.stringify(center(16, 30)), '[16,15]');
eq('00:10 마감 → 중심 23:55 (자정 감쌈)', JSON.stringify(center(0, 10)), '[23,55]');
eq('중심이 atHour/nearMinute 유효 범위',
   due.every((hm) => { const c = center(...hm); return c[0] >= 0 && c[0] <= 23 && c[1] >= 0 && c[1] <= 59; }),
   true);

console.log(`\n${fail ? '❌' : '✅'} 통과 ${pass} · 실패 ${fail}\n`);
process.exitCode = fail ? 1 : 0;

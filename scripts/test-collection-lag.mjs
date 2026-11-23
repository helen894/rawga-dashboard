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
console.log('\n예약표\n');

const schedRaw = src.match(/var DIRECT_SCHEDULE = (\[\[[\s\S]*?\]\]);/);
if (!schedRaw) { console.error('❌ DIRECT_SCHEDULE 을 소스에서 못 찾았습니다'); process.exit(1); }
const sched = JSON.parse(schedRaw[1]);
const mins = ([h, m]) => h * 60 + m;

eq('하루 3회', sched.length, 3);
eq('1회차 07:00', JSON.stringify(sched[0]), '[7,0]');
eq('2회차 11:30', JSON.stringify(sched[1]), '[11,30]');
eq('3회차 16:30', JSON.stringify(sched[2]), '[16,30]');
eq('시·분이 유효 범위', sched.every(([h, m]) => h >= 0 && h <= 23 && m >= 0 && m <= 59), true);
/* ★ 이 줄이 11-23 의 교훈이다. 회차를 어떻게 바꾸든 09:1x 이후가 하나는 있어야 한다. */
eq('클로브 수집(09:1x) 이후 회차가 있다', sched.some((hm) => mins(hm) >= 9 * 60 + 30), true);
eq('같은 시각 중복 없음', new Set(sched.map(mins)).size, sched.length);

/* 사람이 읽는 구간 표시 — ±15분이라 07:00 은 06:45~07:15 이다. 여기가 틀리면 로그만 거짓말한다. */
const spanSrc = src.match(/function scheduleSpan_\([\s\S]*?\n}/);
const hhmmSrc = src.match(/function hhmm_\([\s\S]*?\n}/);
if (!spanSrc || !hhmmSrc) { console.error('❌ scheduleSpan_ / hhmm_ 을 소스에서 못 찾았습니다'); process.exit(1); }
vm.runInContext(spanSrc[0] + '\n' + hhmmSrc[0] + '\nglobalThis.span = scheduleSpan_;', ctx);
const span = ctx.span;

eq('07:00 → ±15분', span(7, 0), '06:45~07:15');
eq('11:30 → ±15분', span(11, 30), '11:15~11:45');
eq('16:30 → ±15분', span(16, 30), '16:15~16:45');
eq('자정을 넘겨도 감싼다', span(0, 0), '23:45~00:15');
eq('23:50 → 다음날로 감싼다', span(23, 50), '23:35~00:05');

console.log(`\n${fail ? '❌' : '✅'} 통과 ${pass} · 실패 ${fail}\n`);
process.exitCode = fail ? 1 : 0;

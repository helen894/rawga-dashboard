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

/* 예약 시각이 실제로 옮겨졌는지도 같이 본다 — 지연 판정만 맞고 07:00 그대로면 의미가 없다. */
const hourOk = /\.atHour\(10\)\.nearMinute\(0\)/.test(src);
eq('예약 시각이 10시 (클로브 수집 09:13 이후)', hourOk, true);
const notifyOk = /if \(lagDays >= 2 && opts\.notifyOnFail\)/.test(src);
eq('이틀 이상 멈추면 실패 아니어도 알림', notifyOk, true);

console.log(`\n${fail ? '❌' : '✅'} 통과 ${pass} · 실패 ${fail}\n`);
process.exitCode = fail ? 1 : 0;

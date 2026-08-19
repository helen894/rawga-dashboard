#!/usr/bin/env node
/**
 * test-freshness-badge.mjs — 데이터 신선도 요약 배지의 '가장 낡은 항목' 선정 검증.
 *
 * 왜: 배지에 이름 하나만 나오므로 **엉뚱한 이름이 나와도 티가 안 난다**. 특히 등급이 같을 때
 * 누구를 고를지가 sev(자기 기준선 대비 초과 배수)에 달려 있는데, 소스마다 기준 단위가 달라
 * (은행 24시간 · 입출금 영업일 1일 · 매출채권 7일 · 법인카드 40일) 실수하기 쉽다.
 * "3일 지남" 은 매출채권엔 정상이고 은행잔액엔 심각하다 — 경과일로 비교하면 틀린다.
 *
 * 어떻게: renderFreshness 는 DOM 을 만지므로 통째로 못 돌린다. 대신 **배지 문구를 정하는
 * 그 세 줄을 index.html 에서 그대로 잘라내** 같은 식으로 계산해 검사한다.
 *
 * 실행: node scripts/test-freshness-badge.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* 배지 선정 3줄을 소스에서 추출 — 코드가 바뀌면 여기서 '못 찾음' 으로 터진다 */
const m = html.match(/const worstOne = src\.filter[\s\S]*?const label = worst === 0 \? '최신' : \(worstOne \? worstOne\.name : '확인'\);/);
if (!m) { console.error('❌ 배지 선정 코드를 index.html 에서 못 찾았습니다 — 리팩터링됐다면 이 테스트도 고쳐야 합니다.'); process.exit(1); }
const pick = new Function('src', `
  const worst = Math.max(...src.map(s => s.lvl));
  ${m[0]}
  return { label, worst };
`);

/* FRESH_LIMIT 도 소스에서 읽어 실제 기준선으로 sev 를 만든다 */
const lim = JSON.parse(
  html.match(/const FRESH_LIMIT = \{([^}]+)\}/)[1]
      .replace(/(\w+):/g, '"$1":').replace(/\s*\/\/.*$/gm, '').trim()
      .replace(/,\s*$/, '').replace(/^/, '{').replace(/$/, '}')
);
const S = {
  bank: (h)  => ({ name: '은행잔액', lvl: h <= 24 ? 0 : (h <= 72 ? 1 : 2), sev: h / lim.bank }),
  cf:   (g)  => ({ name: '입출금',   lvl: g <= 1  ? 0 : (g <= 3  ? 1 : 2), sev: g / lim.cf }),
  ar:   (d)  => ({ name: '매출채권', lvl: d <= 7  ? 0 : (d <= 14 ? 1 : 2), sev: d / lim.ar }),
  card: (mo, d) => ({ name: '법인카드', lvl: mo <= 0 ? 0 : (mo === 1 ? 1 : 2), sev: d / lim.card }),
};

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '  ✅' : '  ❌'} ${label}${ok ? '' : `\n       기대 ${JSON.stringify(want)}\n       실제 ${JSON.stringify(got)}`}`);
  ok ? pass++ : fail++;
};

console.log('');
console.log(`기준선: 은행 ${lim.bank}시간 · 입출금 ${lim.cf}영업일 · 매출채권 ${lim.ar}일 · 법인카드 ${lim.card}일`);

console.log('');
console.log('[1] 전부 정상 → 이름이 아니라 "최신"');
check('라벨', pick([S.bank(1), S.cf(0), S.ar(2), S.card(0, 20)]).label, '최신');

console.log('');
console.log('[2] 하나만 나쁘면 그 이름');
check('빨강 1개', pick([S.bank(1), S.cf(0), S.ar(30), S.card(0, 20)]).label, '매출채권');
check('노랑 1개', pick([S.bank(1), S.cf(2), S.ar(2), S.card(0, 20)]).label, '입출금');

console.log('');
console.log('[3] 등급이 다르면 나쁜 등급이 이긴다 (경과일이 짧아도)');
/* 은행 100시간 = 빨강(sev 4.2) vs 매출채권 10일 = 노랑(sev 1.4) → 은행 */
check('빨강 > 노랑', pick([S.bank(100), S.ar(10)]).label, '은행잔액');

console.log('');
console.log('[4] ⚠ 핵심 — 등급이 같을 때는 기준선 대비로 고른다');
/* 둘 다 빨강. 매출채권 21일(sev 3.0) vs 은행 100시간(sev 4.17) → 은행이 더 낡음.
   경과일로 비교하면 21일 > 4.2일 이라 매출채권을 고르게 되는데 그건 틀렸다. */
const r4 = pick([S.bank(100), S.ar(21)]);
check('은행 100시간 vs AR 21일 → 은행', r4.label, '은행잔액');
/* 반대로 매출채권 60일(sev 8.6) vs 은행 100시간(sev 4.17) → 매출채권 */
check('은행 100시간 vs AR 60일 → 매출채권', pick([S.bank(100), S.ar(60)]).label, '매출채권');

console.log('');
console.log('[5] 데이터 없음(sev Infinity)은 같은 등급 안에서 가장 낡다');
check('없음이 이긴다',
  pick([{ name: '법인카드', lvl: 2, sev: Infinity }, S.bank(200)]).label, '법인카드');

console.log('');
console.log('[6] sev 가 없어도(구버전 데이터) 죽지 않는다');
check('sev 누락 허용', pick([{ name: '입출금', lvl: 2 }, { name: '은행잔액', lvl: 2 }]).label, '입출금');

console.log('');
console.log(`${fail === 0 ? '✅ 전부 통과' : '❌ 실패 ' + fail + '건'} (${pass}/${pass+fail})`);
process.exitCode = fail ? 1 : 0;

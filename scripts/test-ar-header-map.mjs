#!/usr/bin/env node
/**
 * test-ar-header-map.mjs — AR 시트 동기화의 헤더 이름 매핑 검증.
 *
 * 왜: 헤더 이름이 바뀌면 그 열을 못 찾고 **조용히 0** 이 된다. 2026-08-21 에 천대표(부산영업)
 * 탭의 '최종 회수액(1)' 이 '최종회수액' 으로 바뀌면서 회수액 55건이 전부 0 이 되고 미회수가
 * 10.5억 부풀었다 — 입금은 실제로 들어와 있었는데도. 스크립트는 아무 경고도 내지 않았다.
 * 헤더 후보 목록과 '못 찾음' 경고가 실제로 동작하는지 여기서 잡는다.
 *
 * 실행: node scripts/test-ar-header-map.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'apps-script/ar-sheet-sync.gs'), 'utf8');

function grab(name){
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('없음: ' + name);
  let d = 0, st = false;
  for (let j = src.indexOf('{', i); j < src.length; j++){
    if (src[j] === '{') { d++; st = true; }
    else if (src[j] === '}') { d--; if (st && d === 0) return src.slice(i, j+1); }
  }
}
const FIELDS = JSON.parse((src.match(/var FIELDS\s*=\s*(\[[^\]]*\])/) || [])[1].replace(/'/g, '"'));
const cfgLine = src.match(/'천대표\(부산영업\)':\s*(\{[^}]*\})/)[1];
const cfg = eval('(' + cfgLine + ')');
const api = new Function(`
  var FIELDS = ${JSON.stringify(FIELDS)};
  ${grab('norm_')}
  ${grab('cfgNames_')}
  ${grab('mapCols_')}
  return { mapCols_: mapCols_, norm_: norm_, cfgNames_: cfgNames_ };
`)();

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '  ✅' : '  ❌'} ${label}${ok ? '' : `\n       기대 ${JSON.stringify(want)}\n       실제 ${JSON.stringify(got)}`}`);
  ok ? pass++ : fail++;
};
const map = (headers) => api.mapCols_(headers.map(api.norm_), cfg);

console.log('');
console.log('천대표(부산영역) 설정:', JSON.stringify(cfg));
console.log('');
console.log('[1] 새 헤더 (2026-08-21 변경: O열 최종회수일 · P열 최종회수액)');
let m = map(['거래처','송금일','예상회수액','예상회수일','비고','최종회수일','최종회수액']);
check('예상회수액 열', m.expected, 2);
check('최종회수일 → collect', m.collect, 5);
check('최종회수액 → collected', m.collected, 6);

console.log('');
console.log('[2] 예전 헤더도 계속 잡힌다 (옛 사본 시트 호환)');
m = map(['거래처','송금일','예상회수액','예상회수일','최종회수일(1)','최종 회수액(1)']);
check('collect', m.collect, 4);
check('collected', m.collected, 5);

console.log('');
console.log('[3] 공백 차이는 무시한다');
m = map(['송금일','예상회수액','최종 회수 액','최종 회수일']);
check('공백 넣은 최종회수일', m.collect, 3);

console.log('');
console.log('[4] ⚠ 회수액 열이 없으면 매핑에서 빠진다 → 호출부가 경고해야 하는 상황');
m = map(['거래처','송금일','예상회수액','예상회수일']);
check('collected 없음', m.collected, undefined);
check('collect 없음', m.collect, undefined);
check('expected 는 있음', m.expected, 2);

console.log('');
console.log('[5] 경고 문구가 스크립트에 실제로 있는지');
check('missCols 계산', /var missCols = \[\]/.test(src), true);
check('note 에 경고 삽입', /열 못 찾음: ' \+ missCols\.join/.test(src), true);
check('0 으로 들어간다는 경고 문구', src.includes('그 값은 0 으로 들어갑니다'), true);

console.log('');
console.log(`${fail === 0 ? '✅ 전부 통과' : '❌ 실패 ' + fail + '건'} (${pass}/${pass+fail})`);
process.exitCode = fail ? 1 : 0;

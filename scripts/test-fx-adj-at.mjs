#!/usr/bin/env node
/**
 * test-fx-adj-at.mjs — 날짜별 외화 환산조정(fxAdjAt) 검증.
 *
 * 왜: 이 함수를 틀리면 **모든 과거 잔액이 조용히 어긋난다.** 차트는 틀려도 그럴듯한 선을
 * 그리므로 눈으로 안 잡힌다. 2026-08-23 도입 전에는 오늘자 상수를 전 구간에 얹어
 * 1~6월이 통째로 약 1.26억 낮게 그려지고 있었다(클로브 실제 일별잔액 236일 대조로 발견).
 *
 * 어떻게: index.html 에서 buildFxRamp_ · fxAdjAt · fxAdjTail 을 그대로 잘라내 격리 실행한다.
 *
 * 실행: node scripts/test-fx-adj-at.mjs
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
/* FX_CONV_MIDS 는 함수 밖 상수라 따로 뽑는다 — 여기 값이 바뀌면 램프가 달라지므로 테스트가
   그 변화를 잡아야 한다. */
const midsLine = html.match(/const FX_CONV_MIDS = \[[^\]]*\];/);
if (!midsLine) throw new Error('FX_CONV_MIDS 를 못 찾았다');

const make = (cfData, fxAdjustBase, FX_ADJ) => new Function(`
  let _fxRamp = [], _fxRampCut = '';
  const cfData = ${JSON.stringify(cfData)};
  const fxAdjustBase = ${JSON.stringify(fxAdjustBase)};
  let FX_ADJ = ${FX_ADJ};
  ${midsLine[0]}
  ${grab('buildFxRamp_')}
  ${grab('fxAdjAt')}
  ${grab('fxAdjTail')}
  buildFxRamp_();
  return { fxAdjAt, fxAdjTail, ramp: () => _fxRamp, cut: () => _fxRampCut };
`)();

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  if (got === want) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}\n     기대 ${want}\n     실제 ${got}`); }
};

const BASE = { pre_krw: 114390049, through: '2026-06-30' };
/* 실제 데이터 축약: 6/30 이후 환전 행(계좌간이체·외환차손)만 램프에 들어간다.
   7/9 환전 -745,945,000 ×2 + 외환차손 -9,005,000 ×2 = 1,509,900,000
   7/13 계좌간이체 ±37,677,500 = 75,355,000  → 합 1,585,255,000 */
const ROWS = [
  { date:'2026-05-15', fx_usd:true, mid_cat:'계좌간이체', in:0, out:44822817 },   // cut 이전 — 램프 제외
  { date:'2026-07-02', fx_usd:true, mid_cat:'매입대금',   in:0, out:77486840 },   // 환전 아님 — 제외
  { date:'2026-07-06', fx_usd:true, mid_cat:'해외',       in:5912371015, out:0 }, // 입금 — 제외
  { date:'2026-07-09', fx_usd:true, mid_cat:'계좌간이체', in:0, out:745945000 },
  { date:'2026-07-09', fx_usd:true, mid_cat:'계좌간이체', in:0, out:745945000 },
  { date:'2026-07-09', fx_usd:true, mid_cat:'외환차손',   in:0, out:9005000 },
  { date:'2026-07-09', fx_usd:true, mid_cat:'외환차손',   in:0, out:9005000 },
  { date:'2026-07-13', fx_usd:true, mid_cat:'계좌간이체', in:37677500, out:0 },
  { date:'2026-07-13', fx_usd:true, mid_cat:'계좌간이체', in:0, out:37677500 },
  { date:'2026-07-16', fx_usd:true, mid_cat:'해외',       in:26790956, out:0 },   // 입금 — 제외
  { date:'2026-07-20', fx_usd:false, mid_cat:'계좌간이체', in:0, out:999999999 },  // fx_usd 아님 — 제외
];
const FXADJ = -125836060;
const F = make(ROWS, BASE, FXADJ);

console.log('\n[1] 램프는 through 이후 환전 행만 담는다');
eq('cut = 2026-06-30', F.cut(), '2026-06-30');
eq('램프 날짜 2개(7/09·7/13)', F.ramp().map(x=>x.d).join(','), '2026-07-09,2026-07-13');

console.log('\n[2] through 이전은 0 — 과거에 오늘자 조정을 얹지 않는다');
eq('2026-01-01', F.fxAdjAt('2026-01-01'), 0);
eq('2026-05-15 (환전이 있어도 cut 이전)', F.fxAdjAt('2026-05-15'), 0);
eq('2026-06-30 (경계 = cut 당일 포함해서 0)', F.fxAdjAt('2026-06-30'), 0);

console.log('\n[3] 환전 아닌 fx 거래는 램프를 올리지 않는다');
eq('2026-07-02 매입대금', F.fxAdjAt('2026-07-02'), 0);
eq('2026-07-06 USD 입금 59억', F.fxAdjAt('2026-07-06'), 0);
eq('2026-07-08 (환전 직전)', F.fxAdjAt('2026-07-08'), 0);

console.log('\n[4] 환전일에 비중만큼 붙는다');
const w709 = 1509900000 / 1585255000;
eq('2026-07-09 = FX_ADJ × 95.2%', F.fxAdjAt('2026-07-09'), Math.round(FXADJ * w709));
eq('2026-07-10 (거래 없는 날은 앞값 유지)', F.fxAdjAt('2026-07-10'), Math.round(FXADJ * w709));
eq('2026-07-13 = 전액', F.fxAdjAt('2026-07-13'), FXADJ);
eq('2026-08-23 = 전액', F.fxAdjAt('2026-08-23'), FXADJ);

console.log('\n[5] fxAdjTail = FX_ADJ − fxAdjAt');
eq('2026-01-01 tail = 전액', F.fxAdjTail('2026-01-01'), FXADJ);
eq('2026-08-23 tail = 0', F.fxAdjTail('2026-08-23'), 0);

console.log('\n[6] 안전장치 — 램프를 못 만들면 상수로 되돌아간다');
const noThrough = make(ROWS, { pre_krw: 1 }, FXADJ);
eq('through 없음 → 과거도 상수', noThrough.fxAdjAt('2026-01-01'), FXADJ);
const noConv = make(ROWS.filter(r => r.mid_cat !== '계좌간이체' && r.mid_cat !== '외환차손'), BASE, FXADJ);
eq('환전 행 없음 → 과거도 상수', noConv.fxAdjAt('2026-01-01'), FXADJ);
eq('환전 행 없음 → tail 0', noConv.fxAdjTail('2026-01-01'), 0);

console.log('\n[7] FX_ADJ 가 0 이면 어느 날짜든 0');
const zero = make(ROWS, BASE, 0);
eq('2026-01-01', zero.fxAdjAt('2026-01-01'), 0);
eq('2026-08-23', zero.fxAdjAt('2026-08-23'), 0);

console.log(`\n${fail ? `✗ ${fail}건 실패 (${pass}/${pass+fail})` : `✅ 전부 통과 (${pass}/${pass})`}`);
process.exitCode = fail ? 1 : 0;

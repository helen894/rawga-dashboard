#!/usr/bin/env node
/**
 * test-weekly-email-parity.mjs — 주간 메일의 '일별 현금 잔액 궤적' 이 미리보기와 실제 발송에서
 * 같은 숫자를 내는지 대조한다.
 *
 * 왜: 이 프로젝트의 주간 메일 HTML 은 **두 벌로 관리된다** — 미리보기는 index.html 의
 * buildWeeklyReportHTML, 실제 발송은 supabase/functions/send-weekly-report. 한쪽만 고치면
 * "미리보기에서 본 것과 다른 메일이 나가는" 사고가 난다(과거에 실제로 겪은 함정).
 * 궤적 계산이 양쪽에 사본으로 들어갔으니 그 둘이 갈라지는지 자동으로 잡는다.
 *
 * 어떻게: index.html 에서 computeWeeklyCashSeries 를 그대로 잘라내고, Edge 는 esbuild 로
 * 타입만 벗겨 같은 함수를 뽑아, 같은 입력에 같은 출력이 나오는지 비교한다.
 *
 * ⚠⚠ 2026-09-19: 이 테스트가 **궤적만 보고 '현금 기준' 은 안 봐서** 사고를 놓쳤다.
 *   settings.cf_start 도입 때 대시보드(initCashEff)만 고치고 Edge 를 안 따라가, 메일의
 *   현금이 화면보다 정확히 328,588,261원 낮게 나갔다. 차주 예상기말현금이 실제 +2.9억인데
 *   메일엔 -3,472만(적자)으로 보였다. 궤적 숫자는 멀쩡했으므로 이 테스트는 통과했다.
 *   → 그래서 **현금 기준 산출(initCashEff vs computeCashBasisServer)** 대조를 추가했다.
 *   계산 기준이 양쪽에 사본으로 존재하는 한, 값이 아니라 **기준** 을 대조해야 한다.
 *
 * 실행: node scripts/test-weekly-email-parity.mjs
 * (esbuild 를 npx 로 내려받는다 — 오프라인이면 건너뛴다)
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const tsSrc = readFileSync(path.join(ROOT, 'supabase/functions/send-weekly-report/index.ts'), 'utf8');

/* grab() 은 'function NAME(' 다음의 첫 { 를 본체로 본다. TS 시그니처에 객체 타입이 있으면
   (weeklySummary: { summary: string; ... }, 반환형 : { html: string; ... }) 거기서 잘린다 —
   buildWeeklyReportHTML 을 뽑다가 269자만 나와 검사가 헛돌았다(2026-09-19).
   파라미터 괄호를 먼저 닫고, 반환형 주석이 있으면 그것까지 건너뛴 뒤의 { 를 본체로 본다. */
function grabBody(src, name){
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('없음: ' + name);
  let j = src.indexOf('(', i), d = 0;
  for (; j < src.length; j++){
    if (src[j] === '(') d++;
    else if (src[j] === ')') { d--; if (d === 0) { j++; break; } }
  }
  while (j < src.length && /\s/.test(src[j])) j++;
  if (src[j] === ':') {                       // 반환형 주석 건너뛰기
    j++;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] === '{') {                     // 객체 반환형 — 짝을 맞춰 넘긴다
      let k = 0;
      for (; j < src.length; j++){
        if (src[j] === '{') k++;
        else if (src[j] === '}') { k--; if (k === 0) { j++; break; } }
      }
    } else {                                   // 단순 타입 — 다음 { 까지
      while (j < src.length && src[j] !== '{') j++;
    }
  }
  while (j < src.length && src[j] !== '{') j++;
  let d2 = 0;
  for (let k = j; k < src.length; k++){
    if (src[k] === '{') d2++;
    else if (src[k] === '}') { d2--; if (d2 === 0) return src.slice(i, k + 1); }
  }
  throw new Error('불균형: ' + name);
}

function grab(src, name){
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('없음: ' + name);
  let d = 0, started = false;
  for (let j = src.indexOf('{', i); j < src.length; j++){
    if (src[j] === '{') { d++; started = true; }
    else if (src[j] === '}') { d--; if (started && d === 0) return src.slice(i, j+1); }
  }
  throw new Error('불균형: ' + name);
}

/* Edge 는 TS — esbuild 로 타입만 벗긴다. 파일 전체를 변환하면 Deno.serve 가 섞이므로
   필요한 두 함수만 잘라 변환한다(addDays 는 양쪽 공통이라 index.html 것을 쓴다). */
let edgeJs;
try {
  const dir = mkdtempSync(path.join(tmpdir(), 'wkparity-'));
  const f = path.join(dir, 'edge.ts');
  writeFileSync(f, [grab(tsSrc, 'computeWeeklyCashSeries'), grab(tsSrc, 'buildWeeklyTrajBlockHTML'),
                    grab(tsSrc, 'buildNextWeekPlanHTML'), grab(tsSrc, 'escapeHtml')].join('\n'), 'utf8');
  // 파일 확장자로 ts 를 알아본다 — --loader 는 stdin 전용 플래그라 파일 입력엔 못 쓴다
  edgeJs = execFileSync('npx', ['--yes', 'esbuild@0.24.0', '--format=esm', f],
                        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' });
} catch (e) {
  console.log('⚠ esbuild 실행 실패 — 아래 사유를 확인하세요. 오프라인이면 수동 대조가 필요합니다.');
  console.log('   ' + String((e && e.message) || e).slice(0, 300));
  process.exit(2);
}

const addDaysSrc = grab(html, 'addDays');
const addDaysJs = new Function(`${addDaysSrc}\nreturn addDays;`)();
const appFn  = new Function(`${addDaysSrc}\n${grab(html, 'computeWeeklyCashSeries')}\nreturn computeWeeklyCashSeries;`)();
const edgeFn = new Function(`${addDaysSrc}\n${edgeJs}\nreturn computeWeeklyCashSeries;`)();

/* HTML 블록까지 대조한다 — 숫자가 같아도 그리는 코드가 갈라지면 메일 모양이 달라진다.
   미리보기판은 html`` 태그드 템플릿(raw 객체 반환)이라 __html 을 꺼내 문자열로 맞춘다. */
const FMT = new Function(`${grab(html, 'fmt')}\nreturn fmt;`)();
const APP_DEPS = ['escapeHtml', 'raw', '_htmlFragment', 'html', 'fmt'].map(n => grab(html, n)).join('\n');
const appBlock = new Function('TODAY', `
  const todayKST = () => TODAY;
  ${APP_DEPS}
  ${addDaysSrc}
  ${grab(html, 'computeWeeklyCashSeries')}
  ${grab(html, 'buildWeeklyTrajBlockHTML')}
  return (ws, rows, init, floor, C, hz) => {
    const r = buildWeeklyTrajBlockHTML(ws, rows, init, floor, C, hz);
    return (r && r.__html) ? r.__html : String(r);
  };`);
const edgeBlock = new Function('fmt', `
  ${addDaysSrc}
  ${edgeJs}
  return {
    traj: (ws, rows, init, floor, C, hz, today, fxNow, fxBefore) =>
      String(buildWeeklyTrajBlockHTML(ws, rows, init, floor, C, hz, today, fxNow, fxBefore)),
    nw:   (a, b, rows, init, floor, C, today) =>
      String(buildNextWeekPlanHTML(a, b, rows, init, floor, C, today)),
  };`);
/* 차주 블록도 두 벌이다 — 같이 대조한다 */
const appNw = new Function('TODAY', `
  const todayKST = () => TODAY;
  ${APP_DEPS}
  ${addDaysSrc}
  ${grab(html, 'buildNextWeekPlanHTML')}
  return (a, b, rows, init, floor, C, today) => {
    const r = buildNextWeekPlanHTML(a, b, rows, init, floor, C, today);
    return (r && r.__html) ? r.__html : String(r);
  };`);
const C_MAIL = { green:'#2A7F57', red:'#C24A38', red2:'#F7E4DE', amber:'#9E6A15', blue:'#314840',
  text:'#1B2B30', t2:'#55655D', t3:'#94A296', bg:'#F2F5F1', bg3:'#E9EFE7', card:'#ffffff', border:'#DDE6DA' };

/* 시나리오 — 과거/현재/미래 주차 · 연체 · 구간 밖 예정을 모두 섞는다 */
const ROWS = [
  { date:'2026-05-20', status:'실제 입금', in: 250, out: 0 },
  { date:'2026-06-02', status:'실제 입금', in: 500, out: 0 },
  { date:'2026-06-02', status:'지출 예정', in: 0,   out: 700 },   // 연체
  { date:'2026-06-05', status:'지출 예정', in: 0,   out: 200 },
  { date:'2026-06-10', status:'지출 예정', in: 0,   out: 400 },
  { date:'2026-06-30', status:'입금 예정', in: 900, out: 0 },
  { date:'2026-08-01', status:'지출 예정', in: 0,   out: 111 },   // 구간 밖
];
const CASES = [
  ['과거 주차', '2026-05-04'],
  ['현재 주차', '2026-06-01'],
  ['미래 주차', '2026-06-15'],
  ['먼 미래',   '2026-07-13'],
];
const TODAY = '2026-06-03', INIT = 1000, FX = 0, H = 56;
const H_DAYS = H;   // 지평 일수 = 열 개수

let pass = 0, fail = 0;
console.log('');
for (const [label, wStart] of CASES) {
  /* ⚠ fxAdjBefore 를 **실제 값으로** 태운다. 종전엔 생략해 호출해서(=fxAdj 로 대체) 양쪽이
     같아 보였고, 그래서 Edge 에 fxAdj/fxAdjBefore 가 아예 없다는 걸 못 잡았다(2026-09-19). */
  const FXB = Math.round(FX * 0.37);
  const a = appFn(wStart, ROWS, INIT, FX, TODAY, H, FXB);
  /* Edge 판은 fxAdj 인자가 없다 — initCash 에 이미 얹혀 오기 때문. 같은 기준으로 넘긴다. */
  const b = edgeFn(wStart, ROWS, INIT, FX, TODAY, H, FXB);   // 시그니처 통일(②-c)
  /* HTML 블록 비교 — 공백만 다른 건 무시(들여쓰기 관습이 두 파일에서 다르다) */
  const norm = (x) => String(x).replace(/\s+/g, ' ').trim();
  const ah = norm(appBlock(TODAY)(wStart, ROWS, INIT + FX, 1500000000, C_MAIL, H, FX, FXB));
  const E = edgeBlock(FMT);
  const bh = norm(E.traj(wStart, ROWS, INIT + FX, 1500000000, C_MAIL, H, TODAY, FX, FXB));
  const hOk = ah === bh;
  console.log(`  ${hOk ? '✅' : '❌'} ${label} — 궤적 HTML 일치 (${ah.length} bytes)`);
  if (!hOk) {
    let k = 0; while (k < Math.min(ah.length, bh.length) && ah[k] === bh[k]) k++;
    console.log(`       ${k} 번째 문자부터 다름`);
    console.log(`       미리보기: …${ah.slice(Math.max(0, k - 40), k + 60)}`);
    console.log(`       Edge    : …${bh.slice(Math.max(0, k - 40), k + 60)}`);
  }
  hOk ? pass++ : fail++;

  /* 차주 예정 블록 — nwStart/nwEnd 는 선택 주차의 다음 주 */
  const nwS = addDaysJs(wStart, 7), nwE = addDaysJs(wStart, 13);
  const an = norm(appNw(TODAY)(nwS, nwE, ROWS, INIT + FX, 1500000000, C_MAIL, TODAY));
  const bn = norm(E.nw(nwS, nwE, ROWS, INIT + FX, 1500000000, C_MAIL, TODAY));
  const nOk = an === bn;
  console.log(`  ${nOk ? '✅' : '❌'} ${label} — 차주 예정 HTML 일치 (${an.length} bytes)`);
  if (!nOk) {
    let k = 0; while (k < Math.min(an.length, bn.length) && an[k] === bn[k]) k++;
    console.log(`       ${k} 번째 문자부터 다름`);
    console.log(`       미리보기: …${an.slice(Math.max(0, k - 40), k + 60)}`);
    console.log(`       Edge    : …${bn.slice(Math.max(0, k - 40), k + 60)}`);
  }
  nOk ? pass++ : fail++;

  /* ── 구조 검사 ─────────────────────────────────────────────────────────
     ⚠⚠ 2026-08-21: 메일에서 차트가 통째로 안 보였다. 중첩 table 에 width 가 없어
       열 폭이 0 으로 접힌 것인데, 그때 검증이 **높이와 색만 재고 폭을 안 봐서** 통과했다.
       같은 부류가 다시 나면 여기서 잡는다 — 브라우저 없이 마크업만 보고 판정한다. */
  const raw = appBlock(TODAY)(wStart, ROWS, INIT + FX, 1500000000, C_MAIL, H, FX, FXB);
  /* valign 은 그림 방식에 따라 top/bottom 이 바뀐다(열 차트 → 선 차트). 거기 매달리지 말고
     '폭과 높이를 둘 다 명시한 열 셀' 인지만 본다 — 폭 누락이 잡고 싶은 결함이다. */
  const colTds = raw.match(/<td width="[\d.]+%" valign="\w+" height="\d+"/g) || [];
  const segs   = raw.match(/<div style="height:(\d+)px;background:#[0-9A-Fa-f]{6}/g) || [];
  const zeroH  = segs.filter(m => /height:0px/.test(m)).length;
  /* 열 셀(height 속성이 붙은 td) 안에 table 이 있으면 폭 없는 셀에 의존하는 것 —
     바깥 차트 컨테이너의 table 은 정상이므로 height 속성으로 열 셀만 골라 본다. */
  const nestedTable = /<td[^>]*height="\d+"[^>]*>\s*<table/.test(raw);
  const checks = [
    [`열 ${H_DAYS}개가 폭을 명시함`, colTds.length, H_DAYS],
    ['색칠 구간이 있음', segs.length > 0, true],
    ['높이 0 인 색칠 구간 없음', zeroH, 0],
    ['색칠을 중첩 table 에 의존하지 않음', nestedTable, false],
  ];
  for (const [label, got, want] of checks) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : ` — 기대 ${want}, 실제 ${got}`}`);
    ok ? pass++ : fail++;
  }

  for (const key of ['dates', 'actVals', 'projVals']) {
    const ok = JSON.stringify(a[key]) === JSON.stringify(b[key]);
    console.log(`  ${ok ? '✅' : '❌'} ${label} — ${key} 일치`);
    if (!ok) {
      const ai = a[key], bi = b[key];
      const at = ai.findIndex((v, i) => JSON.stringify(v) !== JSON.stringify(bi[i]));
      console.log(`       첫 불일치 index ${at}: 미리보기 ${JSON.stringify(ai[at])} vs Edge ${JSON.stringify(bi[at])}`);
    }
    ok ? pass++ : fail++;
  }
}

/* ═══ 현금 기준 산출 대조 ═══════════════════════════════════════════════
   대시보드 initCashEff() + computeFxAdj()  ↔  Edge computeCashBasisServer()
   같은 입력에 같은 initCash 가 나와야 한다. 위 ⚠⚠ 참고 — 이게 없어 사고를 놓쳤다. */
console.log('\n[현금 기준] initCashEff+computeFxAdj  vs  computeCashBasisServer');
{
  const edgeBasisJs = (() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'basis-'));
    const f = path.join(dir, 'b.ts');
    writeFileSync(f, grab(tsSrc, 'computeCashBasisServer'), 'utf8');
    return execFileSync('npx', ['--yes', 'esbuild@0.24.0', '--format=esm', f],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' });
  })();
  const edgeBasis = new Function(`${edgeBasisJs}\nreturn computeCashBasisServer;`)();

  /* 대시보드 쪽은 전역(CF_START·INIT_CASH·cfData·bankSnapshot·fxAdjustBase·FX_ADJ)에
     의존하므로 shim 으로 주입한다. 사본을 만들지 않고 index.html 본문을 그대로 쓴다. */
  /* computeFxAdj 가 buildFxRamp_ 를 부르고, 그게 FX_CONV_MIDS 를 쓴다 — 상수도 원본에서 읽는다
     (테스트에 베껴 두면 원본이 바뀔 때 조용히 갈린다). */
  const FX_CONV_MIDS = JSON.parse(
    (html.match(/const FX_CONV_MIDS\s*=\s*(\[[^\]]*\])/) || [])[1]
      ?.replace(/'/g, '"') ?? '[]');
  const appBasis = (cfRows, settings, snap, fxBase) => {
    const ctx = new Function('S', `
      let CF_START = S.cf_start, INIT_CASH = S.init_cash, FX_ADJ = 0;
      let cfData = S.cfData, bankSnapshot = S.snap, fxAdjustBase = S.fxBase;
      let _fxRamp = [], _fxRampCut = '';
      ${grab(html, 'initCashEff')}
      ${grab(html, 'computeFxAdj')}
      ${grab(html, 'buildFxRamp_')}
      const FX_CONV_MIDS = ${JSON.stringify(FX_CONV_MIDS)};
      computeFxAdj();
      return { initCash: initCashEff() + FX_ADJ, fxAdj: FX_ADJ, eff: initCashEff() };`);
    return ctx({ cf_start: String(settings.cf_start || '').slice(0, 10),
                 init_cash: Number(settings.init_cash || 0),
                 cfData: cfRows, snap, fxBase });
  };

  /* cf_start 앞뒤에 거래를 두고, 외화 행도 섞는다 — 보정과 환산손익을 동시에 태운다. */
  const R = (date, status, amt, extra = {}) => ({
    date, status, in: status.includes('입금') ? amt : 0, out: status.includes('지출') ? amt : 0, ...extra });
  const CASES = [
    ['cf_start 없음 (종전 동작)', { init_cash: 100000000 },
      [R('2025-11-05', '실제 입금', 5000000), R('2026-02-10', '실제 지출', 3000000)]],
    ['cf_start 이전 거래가 순증', { init_cash: 148963934, cf_start: '2026-01-01' },
      [R('2025-10-24', '실제 입금', 80000000), R('2025-12-31', '실제 지출', 20000000),
       R('2026-03-01', '실제 지출', 7000000)]],
    ['cf_start 이전 거래가 순감 (실제 상황)', { init_cash: 148963934, cf_start: '2026-01-01' },
      [R('2025-11-01', '실제 지출', 400000000), R('2025-12-20', '실제 입금', 71411739),
       R('2026-05-05', '실제 입금', 12000000)]],
    ['cf_start 경계 — 당일은 포함 안 함', { init_cash: 50000000, cf_start: '2026-01-01' },
      [R('2025-12-31', '실제 지출', 1000000), R('2026-01-01', '실제 지출', 2000000)]],
    ['외화 행이 섞임 (환산손익 동시)', { init_cash: 148963934, cf_start: '2026-01-01' },
      [R('2025-12-01', '실제 입금', 30000000, { fx_usd: true }),
       R('2026-07-06', '실제 입금', 5912371015, { fx_usd: true }),
       R('2026-07-13', '실제 지출', 4280191128, { fx_usd: true })]],
    ['예정 행은 무시해야 함', { init_cash: 100000000, cf_start: '2026-01-01' },
      [R('2025-12-10', '지출 예정', 9000000), R('2025-12-11', '실제 지출', 1000000)]],
  ];
  const SNAP = { fxKrw: 65636224 }, FXB = { pre_krw: 114935167 };
  for (const [label, settings, rows] of CASES) {
    const a = appBasis(rows, settings, SNAP, FXB);
    const b = edgeBasis(rows, settings, SNAP, FXB);
    const ok = a.initCash === b.initCash && a.fxAdj === b.fxAdj;
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) {
      console.log(`       미리보기 initCash ${a.initCash.toLocaleString()} / fxAdj ${a.fxAdj.toLocaleString()}`);
      console.log(`       Edge      initCash ${b.initCash.toLocaleString()} / fxAdj ${b.fxAdj.toLocaleString()}`);
    }
    ok ? pass++ : fail++;
  }
  /* 회귀 방어 — 보정 자체가 어느 한쪽에서 사라지는 걸 막는다.
     위 케이스는 '두 구현이 같은가' 만 보므로, **둘 다 틀리면** 통과해 버린다. */
  const guard = [
    ['index.html 에 cf_start 보정이 있다', /CF_START[\s\S]{0,400}INIT_CASH\s*-\s*pre/.test(html)],
    ['Edge 에 cf_start 보정이 있다', /cfStart[\s\S]{0,600}initCashRaw\s*-\s*preCfStart/.test(tsSrc)],
    ['Edge 의 현금 기준이 이름 있는 함수다', /function computeCashBasisServer\(/.test(tsSrc)],
    /* ②-b 기준일 — 양쪽 다 min(wEnd, 오늘). 한쪽만 wEnd 로 되돌리면 기준일이 갈린다. */
    ['앱: dashboardKpiDate = min(wEnd, 오늘)',
      /dashboardKpiDate\s*=\s*wEnd\s*<\s*_todayStr\s*\?\s*wEnd\s*:\s*_todayStr/.test(html)],
    ['Edge: dashboardKpiDate = min(wEnd, 오늘)',
      /dashboardKpiDate\s*=\s*wEnd\s*<\s*_todayStr\s*\?\s*wEnd\s*:\s*_todayStr/.test(tsSrc)],
    /* ②-a 예정 범위 — 하한(>= nwStart)이 있으면 예정일 지난 미처리 건이 빠진다.
       calcKPIs 는 상한만 둔다. 메일 두 벌도 같아야 한다.
       ⚠ 검사 범위를 buildWeeklyReportHTML 안으로 좁힌다 — 대시보드의 '차주 입출금 예정'
         카드(index.html 8312행)는 구간 표시가 목적이라 하한이 정상이다. 파일 전체를 훑으면
         그게 잡혀 거짓 실패가 난다.
       ⚠ 처음엔 'nwIn 첫 등장부터 900자' 창으로 봤는데 주석이 길어지며 창 밖으로 밀려
         회귀를 못 잡았다. 창을 쓰지 말고 **해당 줄만 정확히 뽑아** 본다. */
    ...(() => {
      /* nwIn/nwOut 에 더하는 줄만 뽑는다 — 선언(let nwIn = 0)은 += 가 없어 안 걸린다 */
      const nwLines = (src) => (src.match(/^.*nw(?:In|Out)\s*\+=.*$/gm) || []).join('\n');
      const appWk  = grabBody(html,  'buildWeeklyReportHTML');
      const edgeWk = grabBody(tsSrc, 'buildWeeklyReportHTML');
      const appNw  = nwLines(appWk);
      const edgeNw = nwLines(edgeWk);
      return [
        ['앱: 차주예상 줄을 찾았다',   appNw.length  > 0],
        ['Edge: 차주예상 줄을 찾았다', edgeNw.length > 0],
        ['앱: 차주예상 예정에 하한이 없다',   !/nwStart/.test(appNw)],
        ['Edge: 차주예상 예정에 하한이 없다', !/nwStart/.test(edgeNw)],
        ['앱: 차주예상이 실제 거래를 안 센다',   !/실제/.test(appNw)],
        ['Edge: 차주예상이 실제 거래를 안 센다', !/실제/.test(edgeNw)],
        /* 매출채권 잔액 — remTotal 은 **전체 합산(음수 포함)** 이어야 한다.
           remAll(양수만)로 계산하면 과회수가 빠져 화면과 갈린다.
           2026-09-19 실제 사고: 실제 발송만 양수만이라 메일 15,397,503,716 vs
           화면 15,164,740,921 (과회수 19건 -232,762,794). 미리보기는 전체 합산이어서
           미리보기로는 발견되지 않았다 — 두 벌 문제의 전형이다. */
        ['앱: remTotal 이 전체 합산',   /remTotal\s*=\s*arView\.reduce/.test(appWk)],
        ['Edge: remTotal 이 전체 합산', /remTotal\s*=\s*arView\.reduce/.test(edgeWk)],
      ];
    })(),
  ];
  for (const [label, got] of guard) {
    console.log(`  ${got ? '✅' : '❌'} ${label}`);
    got ? pass++ : fail++;
  }
}

/* ═══ 환산조정 램프 대조 ═══════════════════════════════════════════════
   앱 buildFxRamp_()+fxAdjAt()  ↔  Edge makeFxAdjAt()
   ②-c 로 Edge 에 새로 옮긴 것이다. 배분 규칙이 미묘하게 달라도 궤적 숫자는 그럴듯해 보이므로
   램프 자체를 날짜별로 대조한다. */
console.log('\n[환산조정 램프] buildFxRamp_+fxAdjAt  vs  makeFxAdjAt');
{
  const edgeMakeJs = (() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ramp-'));
    const f = path.join(dir, 'r.ts');
    writeFileSync(f, [
      (tsSrc.match(/const FX_CONV_MIDS_SERVER[^;]*;/) || [''])[0],
      grab(tsSrc, 'makeFxAdjAt'),
    ].join('\n'), 'utf8');
    return execFileSync('npx', ['--yes', 'esbuild@0.24.0', '--format=esm', f],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' });
  })();
  const edgeMake = new Function(`${edgeMakeJs}\nreturn makeFxAdjAt;`)();

  const FX_CONV_MIDS_SRC = (html.match(/const FX_CONV_MIDS\s*=\s*\[[^\]]*\];/) || [''])[0];
  const appMake = (rows, fxBase, fxAdj) => new Function('S', `
    let _fxRamp = [], _fxRampCut = '';
    let cfData = S.rows, fxAdjustBase = S.fxBase, FX_ADJ = S.fxAdj;
    ${FX_CONV_MIDS_SRC}
    ${grab(html, 'buildFxRamp_')}
    ${grab(html, 'fxAdjAt')}
    buildFxRamp_();
    return (d) => fxAdjAt(d);`)({ rows, fxBase, fxAdj });

  const F = (date, amt, mid, fx = true) => ({ date, status: amt > 0 ? '실제 입금' : '실제 지출',
    in: amt > 0 ? amt : 0, out: amt < 0 ? -amt : 0, mid_cat: mid, ...(fx ? { fx_usd: true } : {}) });
  const FXADJ = -132380573;
  const RAMP_CASES = [
    ['through 없음 — 램프 미형성(상수)', { pre_krw: 1 },
      [F('2026-07-09', -1509900000, '계좌간이체')]],
    ['환전 2건 — 비중 배분', { through: '2026-06-30' },
      [F('2026-07-09', -1509900000, '계좌간이체'), F('2026-07-13', -37677500, '계좌간이체')]],
    ['환전 아닌 fx 행은 램프에 안 들어감', { through: '2026-06-30' },
      [F('2026-07-06', 5912371015, '해외'), F('2026-07-09', -1509900000, '계좌간이체')]],
    ['외환차손도 환전으로 셈', { through: '2026-06-30' },
      [F('2026-07-09', -9005000, '외환차손'), F('2026-07-13', -37677500, '계좌간이체')]],
    ['cut 이전 행은 무시', { through: '2026-06-30' },
      [F('2026-05-01', -100000000, '계좌간이체'), F('2026-07-09', -1509900000, '계좌간이체')]],
    ['환전이 하나도 없으면 상수', { through: '2026-06-30' },
      [F('2026-07-06', 5912371015, '해외')]],
  ];
  const PROBE = ['2026-06-29', '2026-06-30', '2026-07-01', '2026-07-09', '2026-07-12',
                 '2026-07-13', '2026-09-19'];
  for (const [label, fxBase, rows] of RAMP_CASES) {
    const A = appMake(rows, fxBase, FXADJ), B = edgeMake(rows, fxBase, FXADJ);
    const av = PROBE.map(d => A(d)), bv = PROBE.map(d => B(d));
    const ok = JSON.stringify(av) === JSON.stringify(bv);
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) {
      const i = av.findIndex((v, k) => v !== bv[k]);
      console.log(`       ${PROBE[i]} — 앱 ${av[i]?.toLocaleString()} vs Edge ${bv[i]?.toLocaleString()}`);
      console.log(`       앱   ${JSON.stringify(av)}`);
      console.log(`       Edge ${JSON.stringify(bv)}`);
    }
    ok ? pass++ : fail++;
  }
}

console.log('');
console.log(`${fail === 0 ? '✅ 두 사본이 같은 숫자를 냅니다' : '❌ 사본이 갈라졌습니다 — ' + fail + '건'} (${pass}/${pass+fail})`);
process.exitCode = fail ? 1 : 0;

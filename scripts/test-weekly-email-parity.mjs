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
    traj: (ws, rows, init, floor, C, hz, today) =>
      String(buildWeeklyTrajBlockHTML(ws, rows, init, floor, C, hz, today)),
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
  const a = appFn(wStart, ROWS, INIT, FX, TODAY, H);
  /* Edge 판은 fxAdj 인자가 없다 — initCash 에 이미 얹혀 오기 때문. 같은 기준으로 넘긴다. */
  const b = edgeFn(wStart, ROWS, INIT + FX, TODAY, H);
  /* HTML 블록 비교 — 공백만 다른 건 무시(들여쓰기 관습이 두 파일에서 다르다) */
  const norm = (x) => String(x).replace(/\s+/g, ' ').trim();
  const ah = norm(appBlock(TODAY)(wStart, ROWS, INIT + FX, 1500000000, C_MAIL, H));
  const E = edgeBlock(FMT);
  const bh = norm(E.traj(wStart, ROWS, INIT + FX, 1500000000, C_MAIL, H, TODAY));
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
  const raw = appBlock(TODAY)(wStart, ROWS, INIT + FX, 1500000000, C_MAIL, H);
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
console.log('');
console.log(`${fail === 0 ? '✅ 두 사본이 같은 숫자를 냅니다' : '❌ 사본이 갈라졌습니다 — ' + fail + '건'} (${pass}/${pass+fail})`);
process.exitCode = fail ? 1 : 0;

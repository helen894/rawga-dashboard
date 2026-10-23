/* plan_skip (예정 자동생성 '건너뛴 달') 검증.
   ① index.html 인라인 스크립트 전체 문법
   ② 헬퍼 로직 — 기록/판정/같은 달 잔존/지난 달 정리
   ③ 생성기가 실제로 isPlanSkipped 를 호출하는지(연결 확인) */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP  = mkdtempSync(path.join(tmpdir(), 'planskip-'));
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
  if (cond) { pass++; console.log('  OK    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  → ' + extra : '')); }
};

/* ── ① 인라인 스크립트 문법 ───────────────────────────────── */
const blocks = [];
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m;
while ((m = re.exec(html)) !== null) {
  if (/\bsrc\s*=/i.test(m[1])) continue;                 // 외부 스크립트는 건너뜀
  if (/type\s*=\s*["'](?!text\/javascript|module)/i.test(m[1])) continue;  // 템플릿류 제외
  blocks.push(m[2]);
}
let syntaxBad = 0;
blocks.forEach((src, i) => {
  const f = path.join(TMP, `_inline_${i}.js`);
  writeFileSync(f, src, 'utf8');
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { syntaxBad++; console.log('  FAIL  인라인 스크립트 #' + i + '\n' + String(e.stderr || e).slice(0, 600)); }
});
ok(`인라인 스크립트 ${blocks.length}개 문법`, syntaxBad === 0);

/* ── ② 헬퍼 로직 ─────────────────────────────────────────── */
function grab(name) {
  const i = html.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('없음: ' + name);
  let d = 0, st = false;
  for (let j = html.indexOf('{', i); j < html.length; j++) {
    if (html[j] === '{') { d++; st = true; }
    else if (html[j] === '}') { d--; if (st && d === 0) return html.slice(i, j + 1); }
  }
}
const env = new Function(`
  let planSkip = [];
  let cfData = [];
  let _supa = null;
  const localStorage = { _v: {}, getItem(k){ return this._v[k] ?? null; }, setItem(k,v){ this._v[k]=v; } };
  let TODAY = '2026-10-23';
  const todayKST = () => TODAY;
  const showToast = () => {};
  const planSkipKey = (src, date) => (src && date) ? src + '|' + String(date).slice(0,7) : '';
  ${grab('planSkipSource')}
  ${grab('isPlanSkipped')}
  ${grab('prunePlanSkip')}
  ${grab('notePlanSkips')}
  async function savePlanSkip(){ localStorage.setItem('plan_skip', JSON.stringify(planSkip)); return { error: null }; }
  return {
    get skip(){ return planSkip; }, set skip(v){ planSkip = v; },
    set rows(v){ cfData = v; },
    set today(v){ TODAY = v; },
    planSkipSource, isPlanSkipped, prunePlanSkip, notePlanSkips,
    ls: () => localStorage.getItem('plan_skip'),
  };`)();

const cardRow = { _id:'a', date:'2026-10-23', desc:'비씨카드 대금(추정)', card_bill_id:'card_비씨', status:'지출 예정' };
const loanRow = { _id:'b', date:'2026-11-05', desc:'대출이자(추정)', loan_id:'1002123', status:'지출 예정' };

ok('출처 추출 — 카드', env.planSkipSource(cardRow) === 'card_비씨', env.planSkipSource(cardRow));
ok('출처 추출 — 대출', env.planSkipSource(loanRow) === 'loan_1002123', env.planSkipSource(loanRow));
ok('출처 추출 — 일반 행은 빈값', env.planSkipSource({ date:'2026-10-23', desc:'비씨카드출금' }) === '');

// 삭제 후 그 달에 남은 행이 없으면 기록한다
env.skip = []; env.rows = [];
ok('삭제 기록 1건', env.notePlanSkips([cardRow]) === 1);
ok('키 형식', env.skip[0] === 'card_비씨|2026-10', env.skip[0]);
ok('그 달은 건너뜀 판정', env.isPlanSkipped('card_비씨', '2026-10-23') === true);
ok('다음 달은 영향 없음', env.isPlanSkipped('card_비씨', '2026-11-23') === false);
ok('다른 카드사는 영향 없음', env.isPlanSkipped('card_국민', '2026-10-23') === false);
ok('로컬 저장됨', JSON.parse(env.ls()).length === 1);

// 같은 달에 같은 출처 행이 남아 있으면 기록하지 않는다(날짜만 옮긴 경우)
env.skip = [];
env.rows = [{ _id:'c', date:'2026-10-25', card_bill_id:'card_비씨' }];
ok('같은 달에 행이 남아 있으면 기록 안 함', env.notePlanSkips([cardRow]) === 0 && env.skip.length === 0);

// 중복 기록 방지
env.skip = []; env.rows = [];
env.notePlanSkips([cardRow]);
ok('중복 기록 방지', env.notePlanSkips([cardRow]) === 0 && env.skip.length === 1);

// 지난 달 정리 — 이번 달·미래 달은 남긴다
env.skip = ['card_비씨|2026-09', 'card_비씨|2026-10', 'card_국민|2026-11', '형식이상'];
const pruned = env.prunePlanSkip();
ok('지난 달만 정리', pruned === 1 && env.skip.join(',') === 'card_비씨|2026-10,card_국민|2026-11,형식이상',
   env.skip.join(','));

// 대출도 같은 경로
env.skip = []; env.rows = [];
env.notePlanSkips([loanRow]);
ok('대출 기록·판정', env.isPlanSkipped('loan_1002123', '2026-11-05') === true && env.skip[0] === 'loan_1002123|2026-11');

/* ── ③ 생성기 연결 ───────────────────────────────────────── */
ok('카드 생성기가 isPlanSkipped 호출', /if \(isPlanSkipped\(cardKey, date\)\) continue;/.test(html));
ok('대출 생성기가 isPlanSkipped 호출', /if \(isPlanSkipped\('loan_' \+ acct, date\)\) continue;/.test(html));
ok('단건 삭제가 notePlanSkips 호출', /if \(notePlanSkips\(\[row\]\)\)/.test(html));
ok('일괄 삭제가 notePlanSkips 호출', /const _planSkipped = notePlanSkips\(_deleted\);/.test(html));
ok('서버 로드에 plan_skip 있음', /row\.key === 'plan_skip'/.test(html));
ok('UI 박스 2개', /id="loan-skip-box"/.test(html) && /id="card-skip-box"/.test(html));

console.log('');
console.log(fail ? `실패 ${fail}건 / 통과 ${pass}건` : `전부 통과 (${pass}건)`);
process.exit(fail ? 1 : 0);

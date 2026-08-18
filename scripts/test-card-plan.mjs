#!/usr/bin/env node
/**
 * test-card-plan.mjs — 법인카드 대금 예정(generateCardPlanned) 회귀 테스트.
 *
 * 왜: 이 함수는 **기존 예정 행의 금액을 덮어쓴다**. 일할 환산은 날마다 정확해지므로
 * 한 번 만들고 굳히면 의미가 없어서 그렇게 했는데, 덮어쓰기는 사람이 손으로 고친 금액을
 * 날려버릴 수 있다. 보호 조건(상태·card_est_amt)이 조용히 깨지는 게 진짜 위험이라
 * 사람 기억 대신 이 테스트가 잡는다.
 *
 * 어떻게: index.html 은 단일 파일이라 import 가 안 된다. 필요한 함수 소스를 이름으로
 * 잘라내(중괄호 균형) new Function 으로 격리 실행한다. 즉 **배포되는 코드 그대로**를
 * 검사한다 — 복붙본이 아니다. 함수 이름이 바뀌면 여기서 '없음: 이름' 으로 터진다.
 *
 * 실행:
 *   node scripts/test-card-plan.mjs      # 실패하면 exit 1
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* 이름으로 함수/상수 소스를 잘라낸다 (중괄호 균형) */
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
const NAMES = ['cardVisibleTail','cardMatchIssuer','cardApprovalByMonth','cardApprovalUpTo',
               'cardIngestWatermarkDay','loanShiftToBizDay','normalizeCFRow','normalizeCFAmount',
               'normalizeCFStatus','normalizeCFDate','excelDateToStr','generateCardPlanned'];
const consts = html.match(/const CARD_PLAN_ISSUERS[\s\S]*?const CARD_PRORATE_MIN_DAYS = \d+;/)[0];

let TODAY = '2026-08-18';
const prelude = `
  let cfData=[], cardData=[], corpCardTxData=[], _cardLoaded=true, _cfIdCounter=1000;
  let saves=0, toasts=[];
  const todayKST = () => TODAY;
  const getBigCat = () => '고정비';
  const saveData = () => { saves++; };
  const showToast = (m) => toasts.push(m);
`;
const src = prelude + consts + '\n' + NAMES.map(grab).join('\n') + `
  ;globalThis.__api = {
    set today(v){ TODAY = v; },
    set cf(v){ cfData = v; }, get cf(){ return cfData; },
    set cards(v){ cardData = v; }, set tx(v){ corpCardTxData = v; },
    run: (t) => generateCardPlanned(t),
    get saves(){ return saves; }, resetSaves(){ saves = 0; },
  };
`;
new Function('TODAY', src)(TODAY);
const api = globalThis.__api;

/* ── 고정 시나리오: 국민 1장, 결제 15일 ───────────────────────────── */
const CARDS = [{ issuer:'국민', cardNo:'4265-8697-2583-0814', payDay:15, status:'활성' }];
/* 승인액: 5·6·7월 각 300만(완결) + 8월 1~16일 매일 10만 */
function mkTx(){
  const t = [];
  for (const m of ['05','06','07'])
    t.push({ card_no:'************0814', use_date:`2026-${m}-10`, billing_amount:3000000 });
  for (let d = 1; d <= 16; d++)
    t.push({ card_no:'************0814', use_date:`2026-08-${String(d).padStart(2,'0')}`, billing_amount:100000 });
  return t;
}
const EXPECT_PRORATE = Math.round(1600000 * 31 / 16);   // 8월 16일까지 160만 → 310만
const AVG = 3000000;

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '  ✅' : '  ❌'} ${label}${ok ? '' : `\n       기대 ${JSON.stringify(want)}\n       실제 ${JSON.stringify(got)}`}`);
  ok ? pass++ : fail++;
};
const setup = (rows, today='2026-08-18') => {
  api.today = today; api.cards = CARDS; api.tx = mkTx(); api.cf = rows; api.resetSaves();
};
const cardRow = (o) => ({ _id:'x_'+(o.date||'2026-09-15'), date:o.date||'2026-09-15',
  desc:'국민카드 대금(추정)', in:0, out:o.out,
  amount:-o.out, type:'지출', status:o.status||'지출 예정', card_bill_id:'card_국민',
  card_basis:o.basis||'최근 3개월 평균', ...(o.est!==undefined?{card_est_amt:o.est}:{}) });
/* 10/15(=9월 사용분, 미래월이라 평균 고정)도 같이 깔아 둔다. 안 그러면 그 행이 새로 생성되면서
   saves 가 1 이 되어 '갱신 때문에 저장됐는지' 를 가릴 수 없다. */
const withNext = (row) => [row, cardRow({ date:'2026-10-15', out:AVG, est:AVG })];
const find = () => api.cf.find(r => r.card_bill_id==='card_국민' && r.date==='2026-09-15');

console.log(`\n[1] 신규 생성 — 8월 진행 중(16일 적재) → 일할 환산 ${EXPECT_PRORATE.toLocaleString()}`);
setup([]); api.run(false);
check('금액', find()?.out, EXPECT_PRORATE);
check('근거', find()?.card_basis, '2026-08 일할환산(16일)');
check('card_est_amt 기록', find()?.card_est_amt, EXPECT_PRORATE);

console.log('\n[2] 기존 행 갱신 — 우리가 만든 값 그대로면 새 값으로 덮는다');
setup(withNext(cardRow({ out:AVG, est:AVG }))); api.run(false);
check('금액 갱신', find()?.out, EXPECT_PRORATE);
check('amount 동기화', find()?.amount, -EXPECT_PRORATE);
check('저장 호출', api.saves, 1);

console.log('\n[3] 사람이 금액을 고친 행 — 건드리지 않는다');
setup(withNext(cardRow({ out:5555555, est:AVG }))); api.run(false);
check('금액 유지', find()?.out, 5555555);
check('저장 안 함', api.saves, 0);

console.log('\n[4] 실제 거래로 바뀐 행 — 건드리지 않는다');
setup(withNext(cardRow({ out:AVG, est:AVG, status:'실제 지출' }))); api.run(false);
check('금액 유지', find()?.out, AVG);
check('중복 생성 없음', api.cf.filter(r=>r.date==='2026-09-15'&&r.card_bill_id==='card_국민').length, 1);
check('저장 안 함', api.saves, 0);

console.log('\n[5] 구 행(card_est_amt 없음) — 현재 금액을 생성값으로 보고 갱신한다');
setup(withNext(cardRow({ out:AVG }))); api.run(false);
check('금액 갱신', find()?.out, EXPECT_PRORATE);
check('card_est_amt 채움', find()?.card_est_amt, EXPECT_PRORATE);

console.log('\n[6] 게이트 — 8월 5일이면 아직 3개월 평균');
setup([], '2026-08-05'); api.run(false);
const r6 = api.cf.find(r => r.card_bill_id==='card_국민' && r.date==='2026-09-15');
check('평균 사용', r6?.out, AVG);
check('근거', r6?.card_basis, '최근 3개월 평균');

console.log('\n[7] 멱등성 — 같은 날 두 번 돌려도 변화 없음');
setup([]); api.run(false); const first = find()?.out; api.resetSaves(); api.run(false);
check('금액 동일', find()?.out, first);
check('두 번째엔 저장 안 함', api.saves, 0);
check('행 1개', api.cf.filter(r=>r.date==='2026-09-15'&&r.card_bill_id==='card_국민').length, 1);

console.log('\n[8] 사용월 완결 — 9월 1일이면 8월 실적(160만) 확정');
setup([], '2026-09-01'); api.run(false);
const r8 = api.cf.find(r => r.card_bill_id==='card_국민' && r.date==='2026-09-15');
check('실적 사용', r8?.out, 1600000);
check('근거', r8?.card_basis, '2026-08 승인액');

console.log(`\n${fail === 0 ? '✅ 전부 통과' : '❌ 실패 ' + fail + '건'} (${pass}/${pass+fail})`);
process.exitCode = fail ? 1 : 0;

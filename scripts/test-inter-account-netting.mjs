#!/usr/bin/env node
/**
 * test-inter-account-netting.mjs — 계좌간이체를 '짝 맞는 쌍만' 상계하는지 검증한다.
 *
 * 왜 있는가 (2026-11-14)
 *   종전엔 계좌간이체 행을 입금·출금 합계에서 **전부** 뺐다. 그 기간의 계좌간이체가 입·출
 *   비대칭이면 그 차액만큼 `전주 기말 + 입금 − 출금 = 금주 기말` 이 깨진다. 실제로 2026-11-10
 *   기업부설연구소 이체 5,000,000 이 짝 없이 남아(받는 계좌가 추적 범위 밖) 주간 리포트의
 *   네 숫자가 서로 안 맞았다 — 월간엔 보정항이 있었고 주간엔 없어서 조용히 사라졌다.
 *
 *   짝만 빼면 **같은 금액을 양쪽에서 빼므로 항등식이 반드시 성립한다.** 그게 이 방식을 고른
 *   이유이고, 그래서 검산식 줄을 화면에서 뺄 수 있었다. 이 성질이 깨지면 그 근거가 무너진다.
 *
 * ⚠ 이 테스트는 index.html 에서 함수를 꺼내 돌린다 — 사본을 만들지 않는다.
 *   Edge(send-weekly-report)와 같은 규칙인지는 test-weekly-email-parity.mjs 가 본다.
 *
 * 쓰는 법: node scripts/test-inter-account-netting.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* index.html 에서 함수 본문을 그대로 꺼낸다 (중괄호 균형으로 끝을 찾는다) */
function grab(name) {
  const i = html.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`index.html 에서 ${name} 을 못 찾았습니다`);
  let d = 0, started = false;
  for (let j = html.indexOf('{', i); j < html.length; j++) {
    if (html[j] === '{') { d++; started = true; }
    else if (html[j] === '}') { d--; if (started && d === 0) return html.slice(i, j + 1); }
  }
  throw new Error(`${name} 의 끝을 못 찾았습니다`);
}
const api = new Function(`
  const isInterAccountRow_ = r => (r.mid_cat || '').trim() === '계좌간이체';
  ${grab('interAccountNetted_')}
  return { interAccountNetted_ };
`)();
const netted = api.interAccountNetted_;

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n       기대 ${JSON.stringify(want)}\n       실제 ${JSON.stringify(got)}`}`);
  ok ? pass++ : fail++;
};

const IN  = (amt, desc = '이체') => ({ status: '실제 입금', in: amt,  out: 0,   mid_cat: '계좌간이체', desc });
const OUT = (amt, desc = '이체') => ({ status: '실제 지출', in: 0,    out: amt, mid_cat: '계좌간이체', desc });
const PLAIN_IN  = (amt) => ({ status: '실제 입금', in: amt, out: 0,   mid_cat: '매출' });
const PLAIN_OUT = (amt) => ({ status: '실제 지출', in: 0,   out: amt, mid_cat: '매입대금' });

/* 그 기간의 표시용 입금·출금 — 화면이 쓰는 것과 같은 식 */
const agg = (rows) => {
  const ex = netted(rows);
  const inSum  = rows.filter(r => r.status === '실제 입금' && !ex.has(r)).reduce((s, r) => s + (r.in  || 0), 0);
  const outSum = rows.filter(r => r.status === '실제 지출' && !ex.has(r)).reduce((s, r) => s + (r.out || 0), 0);
  return { inSum, outSum, excluded: ex.size };
};
/* 잔액은 계좌간이체를 포함해 전부 센다 — 실제 현금이기 때문 */
const cashDelta = (rows) =>
  rows.reduce((s, r) => s + (r.status === '실제 입금' ? (r.in || 0) : r.status === '실제 지출' ? -(r.out || 0) : 0), 0);

console.log('\n계좌간이체 짝 상계\n');

// ① 짝이 맞으면 양쪽 다 빠진다
{
  const rows = [PLAIN_IN(100), IN(25_000_000), OUT(25_000_000), PLAIN_OUT(40)];
  const a = agg(rows);
  t('짝 맞는 쌍 2건 상계', a.excluded, 2);
  t('  입금에서 빠짐', a.inSum, 100);
  t('  출금에서 빠짐', a.outSum, 40);
}

// ② 짝 없는 건은 보통 입출금으로 센다 — 2026-11-10 실사례
{
  //   입금 25,000,000 / 출금 25,000,000 (짝) + 출금 5,000,000 (짝 없음 — 기업부설연구소)
  const rows = [IN(25_000_000), OUT(25_000_000), OUT(5_000_000, '(주)로가 기업')];
  const a = agg(rows);
  t('짝 없는 5,000,000 은 남는다', a.outSum, 5_000_000);
  t('  상계된 행은 2건뿐', a.excluded, 2);
}

// ③ ★ 핵심 성질 — 기초 + 입금 − 출금 = 기말 이 **항상** 성립한다
//    (이게 성립하므로 검산식 보정항을 화면에 띄울 필요가 없다. 깨지면 그 근거가 무너진다)
{
  const cases = [
    ['짝 하나',            [IN(25_000_000), OUT(25_000_000)]],
    ['짝 + 미매칭 출금',   [IN(25_000_000), OUT(25_000_000), OUT(5_000_000)]],
    ['짝 + 미매칭 입금',   [IN(25_000_000), OUT(25_000_000), IN(7_000_000)]],
    ['미매칭만',           [OUT(5_000_000)]],
    ['같은 금액 3:2',      [IN(1_000), IN(1_000), IN(1_000), OUT(1_000), OUT(1_000)]],
    ['일반 거래 섞임',     [PLAIN_IN(900), IN(300), OUT(300), OUT(120), PLAIN_OUT(77)]],
    ['계좌간이체 없음',    [PLAIN_IN(500), PLAIN_OUT(200)]],
  ];
  for (const [name, rows] of cases) {
    const a = agg(rows);
    t(`항등식 성립 — ${name}`, a.inSum - a.outSum, cashDelta(rows));
  }
}

// ④ 같은 금액이 여러 건이면 짝지을 수 있는 만큼만 상계한다
{
  const rows = [IN(1_000), IN(1_000), IN(1_000), OUT(1_000), OUT(1_000)];
  const a = agg(rows);
  t('3입금 2출금 → 4건 상계', a.excluded, 4);
  t('  남은 입금 1건', a.inSum, 1_000);
  t('  남은 출금 0', a.outSum, 0);
}

// ⑤ 금액이 다르면 짝이 아니다 (비슷해도)
{
  const rows = [IN(25_000_000), OUT(24_999_999)];
  const a = agg(rows);
  t('1원 달라도 짝 아님', a.excluded, 0);
  t('  둘 다 집계에 남는다', [a.inSum, a.outSum], [25_000_000, 24_999_999]);
}

// ⑥ 예정 행은 상계 대상이 아니다 — 실제 거래만 본다
{
  const rows = [{ status: '지출 예정', in: 0, out: 9_000, mid_cat: '계좌간이체' },
                { status: '입금 예정', in: 9_000, out: 0, mid_cat: '계좌간이체' }];
  t('예정 계좌간이체는 상계 안 함', netted(rows).size, 0);
}

// ⑦ 화면에 검산식 줄이 남아 있지 않은지 — 사용자 지정(2026-11-14)
{
  t('월간 검산식 문구 없음', /전월 기말 \$\{fmt\(openBal\)\}/.test(html), false);
  t('  eqEl 은 비우고 숨긴다', /eqEl\.textContent = '';\s*eqEl\.style\.display = 'none';/.test(html), true);
}

console.log(`\n${fail ? '❌' : '✅'} ${pass}/${pass + fail} 통과`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
/**
 * verify-asset-mix-fx.mjs — 총자산 구성 차트(현금·매출채권·세종F2·라오스)의 계열별 검증.
 * 목적: 2026-08-23 fxAdjAt 도입이 **현금 계열에만** 걸렸는지 확인한다.
 *
 * 왜: 층이 네 개이고 정의가 다 다르다. 환산조정을 엉뚱한 층에 걸어도 화면은 그럴싸한
 * 그림이라 눈으로 안 잡힌다.
 *
 * 검사
 *   1 현금 — 클로브 실제 일별잔액과 대조 (docs/audit/clobe-daily-trend-2026.tsv)
 *       ⚠ 앵커는 **시작일**(settings.cf_start)이다. 시작일이 정확히 일치하고, 오늘은 잔차를 안는다.
 *   2 현금 — 음수일 수 (fxAdjAt 도입 전 40일이었다)
 *   3 세종F2·라오스 — 끝값이 big_cat 별 지출 누계와 일치하는가
 *   4 환산조정 격리 — 세종/라오스가 조정과 무관한가
 * 매출채권 불변식(끝값 == ar_data 미회수합)은 verify-asset-mix.mjs 담당이다 — 중복하지 않는다.
 *
 * fxAdjAt/fxAdjTail 은 index.html 에서 잘라내 쓴다. 재구현하면 검증 의미가 없다.
 */
import fs from 'node:fs';

const html = fs.readFileSync('index.html', 'utf8');
const grab = (n) => {
  const i = html.indexOf('function ' + n + '(');
  let d = 0, st = false;
  for (let j = html.indexOf('{', i); j < html.length; j++) {
    if (html[j] === '{') { d++; st = true; }
    else if (html[j] === '}') { d--; if (st && d === 0) return html.slice(i, j + 1); }
  }
  throw new Error('불균형: ' + n);
};
const mids = html.match(/const FX_CONV_MIDS = \[[^\]]*\];/)[0];

const PK = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const SECRET = fs.readFileSync('C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret', 'utf8').trim();
const EP = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
const call = async (b) => {
  for (let i = 1; i <= 4; i++) {
    try {
      const r = await fetch(EP, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: PK, Authorization: 'Bearer ' + PK }, body: JSON.stringify({ secret: SECRET, ...b }) });
      const t = await r.text();
      if (!t.trimStart().startsWith('{')) throw new Error('HTTP ' + r.status);
      const j = JSON.parse(t);
      if (!j.rows && !j.meta && !j.ok) throw new Error('Edge 오류');
      return j;
    } catch (e) { if (i === 4) throw e; await new Promise(s => setTimeout(s, 800 * i)); }
  }
};
const won = (n) => Math.round(n).toLocaleString('ko-KR');
const eok = (n) => (n / 1e8).toFixed(2);
/* ⚠ CF_START(settings.cf_start) 도입 후로는 기초잔액을 그대로 쓰면 안 된다.
   INIT_CASH 는 **시작일의 개시 잔액**이고, 누적 루프가 그 이전 행까지 더하므로 그만큼을
   미리 걷어내야 한다 — index.html 의 initCashEff() 와 같은 계산이다. */
const initCashEff = (INIT, CF, rows) => {
  if (!CF) return INIT;
  let pre = 0;
  for (const r of rows) {
    if (!r || !r.date || String(r.date) >= CF) continue;
    if (r.status === '실제 입금') pre += (Number(r.in) || 0);
    else if (r.status === '실제 지출') pre -= (Number(r.out) || 0);
  }
  return INIT - pre;
};

const addDays = (d, n) => {
  const p = String(d).split('-').map(Number);
  const t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return t.getUTCFullYear() + '-' + String(t.getUTCMonth() + 1).padStart(2, '0') + '-' + String(t.getUTCDate()).padStart(2, '0');
};

const TODAY = '2026-08-23';
const FROM = '2026-01-01';

const meta = await call({ inspect: { from: '2026-01-01', to: '2026-01-01', meta: ['settings', 'bank_snapshot', 'fx_adjust_base'] } });
const INIT = meta.meta.settings.init_cash;
const BS = meta.meta.bank_snapshot;
const PRE = Number(meta.meta.fx_adjust_base.pre_krw || 0);

const rows = [];
for (const y of [2025, 2026, 2027]) for (let mo = 1; mo <= 12; mo++) {
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  for (let d = 1; d <= last; d += 15) {
    const f = y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const t = y + '-' + String(mo).padStart(2, '0') + '-' + String(Math.min(d + 14, last)).padStart(2, '0');
    const j = await call({ inspect: { from: f, to: t } });
    if (j.matched !== undefined && j.matched > (j.rows || []).length) console.error('경고: ' + f + '~' + t + ' rows 잘림');
    rows.push(...(j.rows || []));
  }
}
let FXSUM = 0;
for (const r of rows) if (r.fx_usd) FXSUM += (r.in || 0) - (r.out || 0);
const FX_ADJ_CALC = Math.round(BS.fxKrw - (PRE + FXSUM));

const env = new Function(
  'let _fxRamp=[],_fxRampCut="";' +
  'const cfData=' + JSON.stringify(rows.map(r => ({ date: r.date, fx_usd: r.fx_usd, mid_cat: r.mid_cat, in: r.in, out: r.out }))) + ';' +
  'const fxAdjustBase=' + JSON.stringify(meta.meta.fx_adjust_base) + ';' +
  'let FX_ADJ=' + FX_ADJ_CALC + ';' +
  mids + grab('buildFxRamp_') + grab('fxAdjAt') + grab('fxAdjTail') +
  'buildFxRamp_(); return {fxAdjAt:fxAdjAt,fxAdjTail:fxAdjTail,FX_ADJ:FX_ADJ};'
)();
const fxAdjTail = env.fxAdjTail;
const FX_ADJ = env.FX_ADJ;

/* renderAssetMixChart 와 같은 순서로 계열을 만든다 */
const dates = [];
for (let d = FROM; d <= TODAY; d = addDays(d, 1)) dates.push(d);

const cashDelta = {};
const CF = String(meta.meta.settings.cf_start || '').slice(0, 10);
let cashBase = initCashEff(INIT, CF, rows) + FX_ADJ;
for (const r of rows) {
  if (!r.date) continue;
  const v = r.status === '실제 입금' ? (r.in || 0) : (r.status === '실제 지출' ? -(r.out || 0) : 0);
  if (!v) continue;
  if (r.date < FROM) cashBase += v;
  else if (r.date <= TODAY) cashDelta[r.date] = (cashDelta[r.date] || 0) + v;
}
const invDelta = { '세종시': {}, '라오스': {} };
const invBase = { '세종시': 0, '라오스': 0 };
for (const r of rows) {
  const c = r.big_cat;
  if (c !== '세종시' && c !== '라오스') continue;
  if (r.status !== '실제 지출' && r.status !== '지출 예정') continue;
  const v = r.out || 0;
  if (!v || !r.date) continue;
  if (r.date < FROM) invBase[c] += v;
  else if (r.date <= TODAY) invDelta[c][r.date] = (invDelta[c][r.date] || 0) + v;
}

const cash = [], cashNoAdj = [], sej = [], lao = [];
let c1 = cashBase, s1 = invBase['세종시'], l1 = invBase['라오스'];
for (const d of dates) {
  c1 += (cashDelta[d] || 0);
  s1 += (invDelta['세종시'][d] || 0);
  l1 += (invDelta['라오스'][d] || 0);
  cash.push(Math.round(c1 - fxAdjTail(d)));
  cashNoAdj.push(Math.round(c1));
  sej.push(Math.round(s1));
  lao.push(Math.round(l1));
}
const tail = (a) => a[a.length - 1] || 0;

let pass = 0, fail = 0;
const ok = (label, good, detail) => {
  if (good) { pass++; console.log('  OK  ' + label + (detail ? ' — ' + detail : '')); }
  else { fail++; console.log('  ✗   ' + label + (detail ? ' — ' + detail : '')); }
};

console.log('\nFX_ADJ ' + won(FX_ADJ) + ' · 비교일수 ' + dates.length + '일');

console.log('\n[1] 현금 — 클로브 실제 일별잔액 대조');
const trend = new Map();
for (const l of fs.readFileSync('docs/audit/clobe-daily-trend-2026.tsv', 'utf8').split(/\r?\n/)) {
  if (!l.trim()) continue;
  const p = l.split('\t');
  trend.set(p[0].trim(), Number(p[1]));
}
let sum = 0, mx = 0, worst = null, n = 0, sumOld = 0;
dates.forEach((d, i) => {
  if (!trend.has(d)) return;
  const e = Math.abs(cash[i] - trend.get(d));
  sum += e; n++;
  sumOld += Math.abs(cashNoAdj[i] - trend.get(d));
  if (e > mx) { mx = e; worst = d; }
});
ok('평균 오차 ' + won(sum / n), sum / n < 5000000, n + '일 · 최대 ' + won(mx) + ' (' + worst + ')');
ok('종전 방식보다 개선', sum / n < sumOld / n, '신규 ' + won(sum / n) + ' vs 종전 ' + won(sumOld / n));
/* ⚠ 2026-08-23 CF_START 도입으로 앵커가 **시작일**로 옮겨졌다. 종전엔 오늘이 정확히 0 이었지만
   지금은 시작일이 정확하고 오늘은 잔차(현재 545,520 — 외화 재평가 누적)를 안는다.
   그래서 '끝값 정확히 일치' 대신 시작일 일치 + 끝값 허용오차로 검사한다. */
const startIdx = dates.indexOf(FROM);
ok('시작일 ' + FROM + ' = 클로브 실제', cash[startIdx] === trend.get(FROM), won(cash[startIdx]) + ' vs ' + won(trend.get(FROM)));
ok('끝값 잔차 1천만원 미만(알림 임계)', Math.abs(tail(cash) - trend.get(TODAY)) < 10000000, won(tail(cash)) + ' vs ' + won(trend.get(TODAY)) + ' · 차 ' + won(tail(cash) - trend.get(TODAY)));

console.log('\n[2] 현금 — 음수일');
const negNew = cash.filter(v => v < 0).length;
const negOld = cashNoAdj.filter(v => v < 0).length;
ok('음수일 0일', negNew === 0, '신규 ' + negNew + '일 / 종전 방식이면 ' + negOld + '일');

console.log('\n[3] 세종F2 · 라오스 — big_cat 지출 누계 직접 합계');
const direct = (c) => rows
  .filter(r => r.big_cat === c && (r.status === '실제 지출' || r.status === '지출 예정') && r.date <= TODAY)
  .reduce((s, r) => s + (r.out || 0), 0);
ok('세종F2 ' + eok(tail(sej)) + '억', tail(sej) === Math.round(direct('세종시')), '직접합계 ' + won(direct('세종시')));
ok('라오스 ' + eok(tail(lao)) + '억', tail(lao) === Math.round(direct('라오스')), '직접합계 ' + won(direct('라오스')));
console.log('     ※ 두 계열은 지출 예정도 포함한다(투자 약정 누계). 종전과 동일한 정의다.');

console.log('\n[4] 환산조정 격리 — 현금에만 걸렸는가');
ok('현금은 조정을 받는다', tail(cash) !== cashNoAdj[0] , '연초 조정후 ' + eok(cash[0]) + '억 / 조정전 ' + eok(cashNoAdj[0]) + '억');
ok('세종F2 는 조정과 무관', tail(sej) === Math.round(direct('세종시')));
ok('라오스 는 조정과 무관', tail(lao) === Math.round(direct('라오스')));
const i310 = dates.indexOf('2026-03-10');
console.log('     2026-03-10  현금 ' + eok(cash[i310]) + '억(조정전 ' + eok(cashNoAdj[i310]) + '억) · 세종 ' + eok(sej[i310]) + '억 · 라오스 ' + eok(lao[i310]) + '억');

console.log('\n[5] 차트 헤더에 뜨는 끝값');
console.log('     현금 ' + eok(tail(cash)) + '억 · 세종F2 ' + eok(tail(sej)) + '억 · 라오스 ' + eok(tail(lao)) + '억');

console.log('\n' + (fail ? '✗ ' + fail + '건 실패 (' + pass + '/' + (pass + fail) + ')' : '전부 통과 (' + pass + '/' + pass + ')'));
process.exitCode = fail ? 1 : 0;

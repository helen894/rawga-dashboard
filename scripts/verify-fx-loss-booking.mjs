/* 7월 외화 미기표 외환차손 — 실현일별 정확 금액 산출 + 기표 효과 측정.
   기표는 잔액을 바꾸지 않는다: fx_usd 태깅 출금을 넣으면 Σ(실제)가 그만큼 줄고
   FX_ADJ = fxKrw − (pre_krw + Σfx) 가 같은 만큼 올라가 상쇄된다. 바뀌는 건 **과거 구간의
   램프 모양**과 손익(외환차손) 뿐이다. 그래서 대조가 개선되는지 반드시 측정한다. */
import fs from 'node:fs';

const html = fs.readFileSync('index.html', 'utf8');
const grab = (n) => {
  const i = html.indexOf('function ' + n + '(');
  let d = 0, st = false;
  for (let j = html.indexOf('{', i); j < html.length; j++) {
    if (html[j] === '{') { d++; st = true; }
    else if (html[j] === '}') { d--; if (st && d === 0) return html.slice(i, j + 1); }
  }
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
      if (!j.rows && !j.meta && !j.ok) throw new Error('Edge');
      return j;
    } catch (e) { if (i === 4) throw e; await new Promise(s => setTimeout(s, 800 * i)); }
  }
};
const won = (n) => Math.round(n).toLocaleString('ko-KR');

/* ── 1. 실현 손실 계산 (이동평균 원가법) ───────────────────────────── */
const IN_USD = 3839950, IN_KRW = 5912371015;
const bookRate = IN_KRW / IN_USD;
console.log('7/6 입금 장부환율 ' + bookRate.toFixed(4) + '\n');

let poolUsd = IN_USD, poolKrw = IN_KRW;      // 외화 재고 (USD, 장부 KRW)
const events = [];

/* 7/9 환전 USD 1,000,000 → 실수령 1,491,890,000 (이미 외환차손 18,010,000 기표됨) */
{
  const usd = 1000000, actual = 1491890000, alreadyBooked = 18010000;
  const released = poolKrw * (usd / poolUsd);
  const loss = released - actual;
  events.push({ date: '2026-07-09', usd, released, actual, loss, alreadyBooked, unbooked: loss - alreadyBooked });
  poolUsd -= usd; poolKrw -= released;
}
/* 7/13 RAWGA INC 입금 USD 25,000 → 37,677,500 (원가 편입) */
poolUsd += 25000; poolKrw += 37677500;
/* 7/13 기업전용송금 USD 2,840,018 → 4,280,191,128 */
{
  const usd = 2840018, actual = 4280191128;
  const released = poolKrw * (usd / poolUsd);
  const loss = released - actual;
  events.push({ date: '2026-07-13', usd, released, actual, loss, alreadyBooked: 0, unbooked: loss });
  poolUsd -= usd; poolKrw -= released;
}
console.log('날짜         USD          장부원가 방출        실수령            실현손실       기기표        미기표');
for (const e of events)
  console.log(`${e.date}  ${String(e.usd).padStart(9)}  ${won(e.released).padStart(16)}  ${won(e.actual).padStart(16)}  ${won(e.loss).padStart(13)}  ${won(e.alreadyBooked).padStart(11)}  ${won(e.unbooked).padStart(13)}`);
const unbookedTotal = events.reduce((s, e) => s + e.unbooked, 0);
console.log(`\n잔여 재고  USD ${Math.round(poolUsd)} · 장부 ${won(poolKrw)} (원가환율 ${(poolKrw / poolUsd).toFixed(2)})`);
console.log(`미기표 합계 ${won(unbookedTotal)}`);
console.log(`앞서 보고한 금액 85,380,527 과의 차 ${won(unbookedTotal - 85380527)}`);
console.log(`  ↳ 차이 원인: 85,380,527 은 잔여 USD 24,932 를 임의 환율 1,480 로 평가해 상계한 값이다.`);
console.log(`     실현 기준(이동평균)으로 계산하면 위 금액이 정확하다.\n`);

/* ── 2. 기표 효과 측정 ─────────────────────────────────────────────── */
const meta = await call({ inspect: { from: '2026-01-01', to: '2026-01-01', meta: ['settings', 'bank_snapshot', 'fx_adjust_base'] } });
const INIT = meta.meta.settings.init_cash, BS = meta.meta.bank_snapshot, PRE = Number(meta.meta.fx_adjust_base.pre_krw || 0);
const rows = [];
for (const y of [2025, 2026, 2027]) for (let mo = 1; mo <= 12; mo++) {
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  for (let d = 1; d <= last; d += 15) {
    const j = await call({ inspect: { from: y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0'), to: y + '-' + String(mo).padStart(2, '0') + '-' + String(Math.min(d + 14, last)).padStart(2, '0') } });
    rows.push(...(j.rows || []));
  }
}
const trend = new Map();
for (const l of fs.readFileSync('docs/audit/clobe-daily-trend-2026.tsv', 'utf8').split(/\r?\n/)) {
  if (!l.trim()) continue; const p = l.split('\t'); trend.set(p[0].trim(), Number(p[1]));
}
const addDays = (d, n) => { const p = String(d).split('-').map(Number); const t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return t.getUTCFullYear() + '-' + String(t.getUTCMonth() + 1).padStart(2, '0') + '-' + String(t.getUTCDate()).padStart(2, '0'); };

const measure = (extra) => {
  const all = rows.concat(extra);
  let fxsum = 0; for (const r of all) if (r.fx_usd) fxsum += (r.in || 0) - (r.out || 0);
  const FX = Math.round(BS.fxKrw - (PRE + fxsum));
  const env = new Function(
    'let _fxRamp=[],_fxRampCut="";' +
    'const cfData=' + JSON.stringify(all.map(r => ({ date: r.date, fx_usd: r.fx_usd, mid_cat: r.mid_cat, in: r.in, out: r.out }))) + ';' +
    'const fxAdjustBase=' + JSON.stringify(meta.meta.fx_adjust_base) + ';' +
    'let FX_ADJ=' + FX + ';' + mids + grab('buildFxRamp_') + grab('fxAdjAt') + grab('fxAdjTail') +
    'buildFxRamp_(); return {fxAdjTail:fxAdjTail,FX_ADJ:FX_ADJ};')();
  const real = all.filter(r => r.status === '실제 입금' || r.status === '실제 지출');
  const flow = new Map();
  for (const r of real) { const a = r.status === '실제 입금' ? r.in : -r.out; flow.set(r.date, (flow.get(r.date) || 0) + a); }
  const dates = [...trend.keys()].sort();
  let run = INIT + FX;
  for (const r of real) if (r.date < dates[0]) run += r.status === '실제 입금' ? r.in : -r.out;
  let sum = 0, mx = 0, worst = null, end = 0;
  for (const d of dates) { run += (flow.get(d) || 0); const v = run - env.fxAdjTail(d);
    const e = Math.abs(v - trend.get(d)); sum += e; if (e > mx) { mx = e; worst = d; } end = v; }
  return { FX, mean: sum / dates.length, max: mx, worst, end };
};
const before = measure([]);
const extra = events.filter(e => e.unbooked > 0).map(e => ({
  date: e.date, status: '실제 지출', in: 0, out: Math.round(e.unbooked),
  big_cat: '영업외비용', mid_cat: '외환차손', fx_usd: true, desc: '외환차손(미기표분)',
}));
const after = measure(extra);
/* 시나리오 3 — 기존 환전 스프레드(-9,005,000 x2)를 없앤 경우.
   환전 두 다리가 이미 실현환율로 상쇄돼 있으니, 그 위에 얹힌 스프레드가 이중계상인지 본다.
   제거는 '반대 부호 행 추가'로 시뮬레이션한다(원본을 안 건드린다). */
const undoSpread = rows.filter(r => r.mid_cat === '외환차손' && r.date === '2026-07-09')
  .map(r => ({ date: r.date, status: '실제 입금', in: r.out || 0, out: 0,
               big_cat: r.big_cat, mid_cat: r.mid_cat, fx_usd: true, desc: 'undo' }));
const noSpread = measure(undoSpread);
console.log('모델            FX_ADJ              평균오차        최대오차            끝점');
console.log(`기표 전   ${won(before.FX).padStart(16)}  ${won(before.mean).padStart(13)}  ${won(before.max).padStart(13)}  ${won(before.end).padStart(15)}`);
console.log(`기표 후   ${won(after.FX).padStart(16)}  ${won(after.mean).padStart(13)}  ${won(after.max).padStart(13)}  ${won(after.end).padStart(15)}`);
console.log(`\n끝점 변화 ${won(after.end - before.end)} (0 이어야 한다 — 잔액은 안 바뀐다)`);
console.log(`기존스프레드제거 ${won(noSpread.FX).padStart(11)}  ${won(noSpread.mean).padStart(13)}  ${won(noSpread.max).padStart(13)}  ${won(noSpread.end).padStart(15)}`);
console.log(`  ↳ 제거 대상 ${undoSpread.length}건 · 합 ${won(undoSpread.reduce((s,r)=>s+r.in,0))}`);
console.log('');
console.log(after.mean < before.mean ? '기표: 개선' : '기표: 악화 — 하면 과거 구간이 어긋난다');
console.log(noSpread.mean < before.mean ? '스프레드 제거: 개선 — 이중계상이었을 가능성' : '스프레드 제거: 악화 — 이중계상 아니다');

#!/usr/bin/env node
/**
 * test-weekly-summary-draft.mjs — 주간 요약 자동 생성 초안 검증 + 실데이터 미리보기.
 *
 * 왜: 2026-10-23 에 최근 13주 수기 요약을 읽어 보니, 자동 생성의 매출채권 2문장이
 * 13주 중 12주에서 지워져 있었다. 건수·비율만 말해 보고에 쓸 수 없었기 때문이다.
 * 그래서 거래처·금액·예정일 문장으로 바꾸고 주요 입출금·차주 예정·월말 잔고를 더했다.
 * **문장이 늘어난 만큼, 빈 데이터에서 깨지거나 이상한 문구가 나오지 않는지가 중요하다** —
 * 초안이 이상하면 사람은 또 통째로 지우고 직접 쓴다.
 *
 * 무엇을: ① index.html 에서 생성기를 소스째 꺼내 경계값으로 돌린다(데이터 없음·음수·
 * 안전선 저촉 등) ② --live 를 주면 실제 cf_data/ar_data 로 이번 주 초안을 뽑아 보여준다.
 *
 * 실행: node scripts/test-weekly-summary-draft.mjs [--live]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function grab(name) {
  const i = html.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('없음: ' + name);
  let d = 0, st = false;
  for (let j = html.indexOf('{', i); j < html.length; j++) {
    if (html[j] === '{') { d++; st = true; }
    else if (html[j] === '}') { d--; if (st && d === 0) return html.slice(i, j + 1); }
  }
  throw new Error('불균형: ' + name);
}
const line = (re) => { const m = html.match(re); if (!m) throw new Error('없음: ' + re); return m[0]; };

const build = new Function(`
  ${grab('fmt')}
  ${line(/const WK_SUMMARY_DIVIDER = [^;]+;/)}
  ${grab('wkAbbr')}
  ${grab('wkAmt')}
  ${line(/const wkMD = [^;]+;/)}
  ${grab('wkTopByDesc')}
  ${grab('buildDefaultWeeklySummaryText')}
  return { build: buildDefaultWeeklySummaryText, wkTopByDesc, wkAbbr, DIV: WK_SUMMARY_DIVIDER };`)();

let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
  if (cond) { pass++; console.log('  OK    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '\n        → ' + extra : '')); }
};

/* ── ① 축약 표기 ─────────────────────────────────────────── */
ok('축약 1억 이상', build.wkAbbr(450000000) === '4.5억', build.wkAbbr(450000000));
ok('축약 10억 이상은 소수점 없이', build.wkAbbr(1500000000) === '15억', build.wkAbbr(1500000000));
ok('축약 음수', build.wkAbbr(-35810945) === '-36백만', build.wkAbbr(-35810945));
ok('축약 1천만 미만은 생략', build.wkAbbr(3300000) === null, String(build.wkAbbr(3300000)));

/* ── ② 거래처 합산 ──────────────────────────────────────── */
const top = build.wkTopByDesc([
  { desc: '화경', out: 50000000 }, { desc: '화경', out: 41216274 },
  { desc: '해외송금', out: 66467068 }, { desc: '소액', out: 1000 },
], 'out', 2);
ok('같은 거래처는 합산 후 정렬', JSON.stringify(top) === JSON.stringify([['화경', 91216274], ['해외송금', 66467068]]), JSON.stringify(top));

/* ── ③ 빈 데이터에서 깨지지 않는다 ───────────────────────── */
const bare = build.build({ wStart: '2026-10-19', wEnd: '2026-10-25', wIn: 0, wOut: 0, wNet: 0 });
ok('재료가 하나도 없어도 생성됨', typeof bare === 'string' && bare.includes('이번 주(2026-10-19'));
ok('빈 데이터면 선택 문장은 안 나온다',
   !bare.includes('주요 출금') && !bare.includes('차주(') && !bare.includes('매출채권 미회수') && !bare.includes('월말('));
ok('구분선은 항상 있다', bare.trim().endsWith(build.DIV));
ok('undefined/NaN 문구 없음', !/undefined|NaN|null/.test(bare), bare);

/* ── ④ 안전선 두 갈래 ───────────────────────────────────── */
const base = { wStart: '2026-10-19', wEnd: '2026-10-25', wIn: 1, wOut: 1, wNet: 0,
               monthEndDate: '2026-10-31', monthEndCash: 1200000000, lowDate: '2026-11-14',
               lowCash: 900000000, floorLine: 1500000000 };
const below = build.build({ ...base, floorBelow: 12 });
const above = build.build({ ...base, floorBelow: 0 });
ok('안전선 저촉 시 일수를 말한다', below.includes('밑도는 날이 8주 중 12일'), below.split('\n').find(l => l.startsWith('월말')));
ok('저촉 없으면 유지한다고 말한다', above.includes('내내 안전선'), above.split('\n').find(l => l.startsWith('월말')));
ok('안전선 미설정이면 잔고만', build.build({ ...base, floorLine: 0, floorBelow: 0 }).includes('월말(10/31) 예상 잔고는'));

/* ── ⑤ 채권 문장이 거래처·금액·예정일을 담는다 ──────────── */
const arTxt = build.build({
  ...base, floorBelow: 0, arRemTotal: 14498131625,
  arDueSoon: [{ partner: '세진식품', rem: 50000000, due_date: '2026-10-26' },
              { partner: '핀다', rem: 430000000, due_date: '2026-10-30' }],
  arLateAmt: 4482822048, arLateN: 41, arNoneAmt: 1602026555, arNoneN: 29,
}).split('\n').find(l => l.startsWith('매출채권'));
ok('채권: 날짜+거래처+금액', /10\/26 세진식품 50,000,000원\(50백만\)/.test(arTxt), arTxt);
ok('채권: 여러 건이면 건수 표기', /천대표 .*3건/.test(build.build({
  ...base, floorBelow: 0, arRemTotal: 1,
  arDueSoon: [{ partner: '천대표', rem: 119500000, due_date: '2026-10-26', n: 3 }],
}).split('\n').find(l => l.startsWith('매출채권'))));
ok('채권: 경과·미정 금액', /예정일 경과 .*41건.*예정일 미정 .*29건/.test(arTxt), arTxt);
ok('채권: 건수만 말하던 옛 문장 제거', !/신규 \d+건, 회수 \d+건/.test(arTxt) && !/위험 등급 채권 비중/.test(arTxt), arTxt);
ok('4주 내 없으면 그렇다고 말한다',
   build.build({ ...base, floorBelow: 0, arRemTotal: 100, arDueSoon: [] }).includes('4주 내 회수 예정은 없습니다'));

console.log('');
console.log(fail ? `실패 ${fail}건 / 통과 ${pass}건` : `전부 통과 (${pass}건)`);

/* ── 실데이터 미리보기 (--live) ──────────────────────────── */
if (process.argv.includes('--live')) {
  const PK = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
  const secret = readFileSync('C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret', 'utf8').trim();
  const EP = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
  const post = b => fetch(EP, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: PK, Authorization: `Bearer ${PK}` }, body: JSON.stringify({ secret, ...b }) }).then(r => r.json());

  const env = new Function(`
    ${grab('addDays')}
    ${grab('getWeekRange')}
    ${grab('monthEnd')}
    ${line(/const isInterAccount_ = [^;]+;/)}
    return { addDays, getWeekRange, monthEnd, inter: isInterAccount_ };`)();

  const REF = process.argv[process.argv.indexOf('--live') + 1] || new Date().toISOString().slice(0, 10);
  const { wStart, wEnd, nwStart, nwEnd } = env.getWeekRange(REF);
  const [wk, nw, arRes] = await Promise.all([
    post({ inspect: { from: wStart, to: wEnd } }),
    post({ inspect: { from: nwStart, to: nwEnd } }),
    post({ inspect: { from: wStart, to: wStart, ar: true } }),
  ]);
  const wCF = (wk.rows || []).filter(r => !env.inter(r));
  const nwCF = (nw.rows || []).filter(r => !env.inter(r));
  const wIn = wCF.filter(r => r.status === '실제 입금').reduce((s, r) => s + (r.in || 0), 0);
  const wOut = wCF.filter(r => r.status === '실제 지출').reduce((s, r) => s + (r.out || 0), 0);

  const map = {};
  wCF.forEach(r => {
    const k = r.big_cat || '미분류';
    if (r.status === '실제 입금') map[k] = (map[k] || 0) + (r.in || 0);
    else if (r.status === '실제 지출') map[k] = (map[k] || 0) - (r.out || 0);
  });
  const all = Object.entries(map).filter(([, v]) => v !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const minor = all.filter(([, v]) => Math.abs(v) < 1e6);
  const items = all.filter(([, v]) => Math.abs(v) >= 1e6);
  const minorSum = minor.reduce((s, [, v]) => s + v, 0);
  if (minorSum !== 0) items.push([`기타(100만 미만) ${minor.length}개`, minorSum]);

  const arOpen = (arRes.ar || []).map(a => ({ partner: a.partner, due_date: a.due_date,
    rem: Number(a.remaining ?? ((a.expected || 0) - (a.collected || 0))) || 0 })).filter(a => a.rem > 0);
  const ar4w = env.addDays(wEnd, 28);
  const sum = arr => arr.reduce((t, a) => t + a.rem, 0);
  const late = arOpen.filter(a => a.due_date && a.due_date <= wEnd);
  const none = arOpen.filter(a => !a.due_date);

  const ctx = {
    wStart, wEnd, wIn, wOut, wNet: wIn - wOut, bigCatNetItems: items,
    topOut: build.wkTopByDesc(wCF.filter(r => r.status === '실제 지출'), 'out', 3),
    topIn: build.wkTopByDesc(wCF.filter(r => r.status === '실제 입금'), 'in', 3),
    nwStart, nwEnd,
    nwPlanIn: nwCF.filter(r => r.status === '입금 예정').reduce((s, r) => s + (r.in || 0), 0),
    nwPlanOut: nwCF.filter(r => r.status === '지출 예정').reduce((s, r) => s + (r.out || 0), 0),
    nwBig: nwCF.filter(r => r.status === '입금 예정' || r.status === '지출 예정')
      .map(r => ({ date: r.date, desc: String(r.desc || '').trim() || '(적요 없음)', amt: (r.in || 0) - (r.out || 0) }))
      .filter(r => Math.abs(r.amt) >= 1e7).sort((a, b) => Math.abs(b.amt) - Math.abs(a.amt)).slice(0, 4)
      .sort((a, b) => a.date.localeCompare(b.date)),
    arRemTotal: sum(arOpen),
    arDueSoon: (() => {
      const m = new Map();
      for (const a of arOpen) {
        if (!a.due_date || a.due_date <= wEnd || a.due_date > ar4w) continue;
        const e = m.get(a.partner) || { partner: a.partner, rem: 0, due_date: a.due_date, n: 0 };
        e.rem += a.rem; e.n++;
        if (a.due_date < e.due_date) e.due_date = a.due_date;
        m.set(a.partner, e);
      }
      return [...m.values()].sort((x, y) => y.rem - x.rem).slice(0, 5);
    })(),
    arLateAmt: sum(late), arLateN: late.length, arNoneAmt: sum(none), arNoneN: none.length,
    // 잔고 궤적은 initCashEff()/FX_ADJ 가 필요해 화면에서만 채워진다 — 여기서는 생략된다
  };
  console.log('\n═══ 실데이터 초안 (' + wStart + ' ~ ' + wEnd + ') ═══');
  console.log('※ 월말 잔고/안전선 줄은 화면에서만 나온다(기초현금·환산조정이 필요)\n');
  console.log(build.build(ctx));
}
/* process.exit() 로 끊으면 --live 의 fetch 핸들이 정리되기 전에 죽어
   Windows 에서 libuv assertion 이 찍힌다 — 실패처럼 보여서 혼란스럽다. */
process.exitCode = fail ? 1 : 0;

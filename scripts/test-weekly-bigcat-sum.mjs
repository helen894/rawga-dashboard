/* 주간 요약 두 문장의 순현금이 항상 같은지 검증한다.
     1줄: "입금 A, 출금 B 로 순현금은 N"          (wNet)
     2줄: "대분류별 순현금은 X · Y · …"           (bigCatNetItems 합)
   2026-09-18 대표님 지적 — 상위 4개만 넣던 .slice(0,4) 때문에 그 주 7,861,979 이 어긋났다.

   ⚠ 계산식을 여기에 다시 적지 않는다. index.html 에서 **소스 그대로 뽑아** 돌린다.
      (베껴 적으면 본체가 바뀌어도 테스트는 계속 통과한다)
   실행: node scripts/test-weekly-bigcat-sum.mjs */
import fs from 'node:fs';

const html = fs.readFileSync('index.html', 'utf8');
const cut = (from, to, label) => {
  const i = html.indexOf(from);
  if (i < 0) throw new Error('소스에서 못 찾음: ' + label);
  const j = html.indexOf(to, i);
  if (j < 0) throw new Error('끝을 못 찾음: ' + label);
  return html.slice(i, j + to.length);
};
const srcTotals = cut('  const wIn   = wCF.filter(', '  const wNet  = wIn - wOut;', '주간 합계');
const srcBigCat = cut('  const BIGCAT_MIN_WON =', 'bigCatNetItems.push([`그 외 ${bigCatMinor.length}개`, bigCatMinorSum]);', '대분류 집계');
if (/slice\(0,\s*\d+\)/.test(srcBigCat)) throw new Error('대분류 집계에 개수 제한(slice)이 남아 있다');

/* 두 블록을 한 스코프에서 실행 — 본체(renderWeeklyReport)와 같은 조건 */
const run = new Function('wCF', 'isInterAccount_', `
  const isInterAccount = isInterAccount_;
  ${srcTotals}
  ${srcBigCat}
  return { wIn, wOut, wNet, items: bigCatNetItems };`);
const isInter = r => (r.mid_cat || '').trim() === '계좌간이체';

let pass = 0, fail = 0;
const t = (name, ok, detail) => { ok ? pass++ : fail++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok || !detail ? '' : '\n       ' + detail}`); };
const won = n => Math.round(n).toLocaleString('ko-KR');
const check = (label, rows) => {
  const r = run(rows, isInter);
  const sum = r.items.reduce((s, [, v]) => s + v, 0);
  t(`${label} · 항목 ${String(r.items.length).padStart(2)}개 · 순현금 ${won(r.wNet).padStart(14)}`,
    sum === r.wNet, `항목합 ${won(sum)} ≠ wNet ${won(r.wNet)} (차 ${won(sum - r.wNet)})`);
  return r;
};

/* ── ① 합성 케이스 — 경계 조건 ───────────────────────────────── */
const row = (o) => ({ date: '2026-09-14', status: o.i ? '실제 입금' : '실제 지출', in: o.i || 0, out: o.o || 0, big_cat: o.c, mid_cat: o.m });
console.log('── 합성 케이스 ──');
const cases = {
  '대분류 없는 행 포함':      [row({ i: 5000000, c: '매출' }), row({ o: 3000000, c: undefined }), row({ o: 900000, c: '' })],
  '전부 100만원 미만':        [row({ i: 400000, c: '매출' }), row({ o: 300000, c: '판매관리비' })],
  '소액이 정확히 상쇄(합 0)': [row({ i: 500000, c: '매출' }), row({ o: 500000, c: '판매관리비' }), row({ o: 9000000, c: '세종시' })],
  '임계 정확히 100만원':      [row({ i: 1000000, c: '매출' }), row({ o: 999999, c: '판매관리비' })],
  '계좌간이체만':             [row({ i: 9000000, c: '자금이동', m: '계좌간이체' }), row({ o: 9000000, c: '자금이동', m: '계좌간이체' })],
  '빈 주':                    [],
};
for (const [label, rows] of Object.entries(cases)) check(label.padEnd(22), rows);
const noCat = run(cases['대분류 없는 행 포함'], isInter);
t('대분류 없는 행이 「미분류」로 살아남음', noCat.items.some(([k]) => k === '미분류'), JSON.stringify(noCat.items));
const minor = run(cases['전부 100만원 미만'], isInter);
t('소액만 있으면 「그 외 N개」 한 항으로', minor.items.length === 1 && minor.items[0][0] === '그 외 2개', JSON.stringify(minor.items));
const zero = run(cases['소액이 정확히 상쇄(합 0)'], isInter);
t('소액 합이 0이면 「그 외」 생략', !zero.items.some(([k]) => k.startsWith('그 외')), JSON.stringify(zero.items));
const edge = run(cases['임계 정확히 100만원'], isInter);
t('정확히 100만원은 개별 표시', edge.items.some(([k]) => k === '매출'), JSON.stringify(edge.items));

/* ── ② 실데이터 — 2026년 전 주차 ─────────────────────────────── */
const PK = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const SECRET = fs.readFileSync('C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret', 'utf8').trim();
const EP = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
const call = async (b) => {
  for (let i = 1; i <= 4; i++) {
    try {
      const r = await fetch(EP, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: PK, Authorization: 'Bearer ' + PK }, body: JSON.stringify({ secret: SECRET, ...b }) });
      const t2 = await r.text();
      if (!t2.trimStart().startsWith('{')) throw new Error('HTTP ' + r.status);
      return JSON.parse(t2);
    } catch (e) { if (i === 4) throw e; await new Promise(s => setTimeout(s, 800 * i)); }
  }
};
/* toISOString 금지(KST 자정이 UTC 전날 15시) — UTC 기준 산술로만 날짜를 만든다 */
const addDays = (d, n) => { const p = String(d).split('-').map(Number);
  const t2 = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return `${t2.getUTCFullYear()}-${String(t2.getUTCMonth() + 1).padStart(2, '0')}-${String(t2.getUTCDate()).padStart(2, '0')}`; };

const rows = [];
for (let mo = 1; mo <= 9; mo++) {
  const dd = new Date(Date.UTC(2026, mo, 0)).getUTCDate();
  const p = x => `2026-${String(mo).padStart(2, '0')}-${String(x).padStart(2, '0')}`;
  rows.push(...((await call({ inspect: { from: p(1), to: p(dd) } })).rows || []));
}
const uniq = new Map(); for (const r of rows) uniq.set(r._id, r);
const cfData = [...uniq.values()];

console.log('\n── 실데이터 (대시보드 주차 기준, 2026-09-14 주를 기준점으로 역산) ──');
const weeks = [];
for (let w = '2026-09-14'; w >= '2026-01-05'; w = addDays(w, -7)) weeks.unshift(w);
for (const wStart of weeks) {
  const wEnd = addDays(wStart, 6);
  const wCF = cfData.filter(r => r.date >= wStart && r.date <= wEnd);
  if (!wCF.length) continue;
  check(`${wStart}~${wEnd.slice(5)}`, wCF);
}

/* ── ③ 대표님이 지적한 그 주를 명시적으로 ──────────────────── */
const target = cfData.filter(r => r.date >= '2026-09-14' && r.date <= '2026-09-20');
const R = run(target, isInter);
console.log('\n── 2026-09-14 ~ 09-20 (지적된 주) ──');
console.log(`1줄: 입금 ${won(R.wIn)} · 출금 ${won(R.wOut)} · 순현금 ${won(R.wNet)}`);
console.log(`2줄: ${R.items.map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${won(v)}원`).join(' · ')}`);
t('지적된 주 두 줄 일치', R.items.reduce((s, [, v]) => s + v, 0) === R.wNet);

console.log(`\n${pass}/${pass + fail} 통과`);
process.exit(fail ? 1 : 0);

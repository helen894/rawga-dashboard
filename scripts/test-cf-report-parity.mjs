/* 입출금 내역 탭의 '리포팅 기준' 둘째 줄 == 리포팅 월간 리포트의 입금/출금 인지 검증.
   두 화면의 필터식을 index.html 에서 **소스 그대로 뽑아** 같은 데이터에 돌린다.
   (숫자를 여기에 다시 적으면 동어반복이므로 그렇게 하지 않는다.)
   실행: node scripts/test-cf-report-parity.mjs */
import fs from 'node:fs';

const html = fs.readFileSync('index.html', 'utf8');
const pick = (marker, endMarker) => {
  const i = html.indexOf(marker);
  if (i < 0) throw new Error('소스에서 못 찾음: ' + marker);
  const j = html.indexOf(endMarker, i);
  if (j < 0) throw new Error('끝을 못 찾음: ' + endMarker);
  return html.slice(i, j);
};

/* ── 리포팅 월간 리포트 쪽 (renderMonthlyReport) ── */
const srcInter  = pick('const isInterAccount_ =', ';\n') + ';';
const srcMnrpt  = pick('const actualInRows = cfData', 'const prevOutRows');
/* ── 입출금 내역 탭 쪽 (renderCFTable 둘째 줄) ── */
const srcCftab  = pick('const _inter = r =>', 'const interNet');
if (!/rptIn/.test(srcCftab) || !/rptOut/.test(srcCftab)) throw new Error('입출금탭 rptIn/rptOut 추출 실패');

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

const rows = [];
for (let m = 1; m <= 8; m++) {
  const dd = new Date(Date.UTC(2026, m, 0)).getUTCDate();
  for (let d = 1; d <= dd; d += 10) {
    const to = Math.min(d + 9, dd);
    const p = (x) => `2026-${String(m).padStart(2, '0')}-${String(x).padStart(2, '0')}`;
    rows.push(...((await call({ inspect: { from: p(d), to: p(to) } })).rows || []));
  }
}
const uniq = new Map(); for (const r of rows) uniq.set(r._id, r);
const cfAll = [...uniq.values()];

/* 월간 리포트 경로 — mStart~mEnd 로 자체 필터 */
const runMnrpt = new Function('cfData', 'mStart', 'mEnd',
  srcInter + srcMnrpt + `
  return { inS: actualInRows.reduce((s,r)=>s+(r.in||0),0),
           outS: actualOutRows.reduce((s,r)=>s+(r.out||0),0) };`);
/* 입출금 탭 경로 — cfFiltered(기간 필터 결과)를 받는다 */
const runCftab = new Function('cfFiltered', srcCftab + `
  return { inS: rptIn, outS: rptOut };`);

let pass = 0, fail = 0;
console.log('월       월간리포트 입금        입출금탭 입금       │ 월간리포트 출금        입출금탭 출금       │ 판정');
for (let m = 1; m <= 8; m++) {
  const k = `2026-${String(m).padStart(2, '0')}`;
  const mStart = `${k}-01`, mEnd = `${k}-${String(new Date(Date.UTC(2026, m, 0)).getUTCDate()).padStart(2, '0')}`;
  const A = runMnrpt(cfAll, mStart, mEnd);
  const B = runCftab(cfAll.filter(r => r.date >= mStart && r.date <= mEnd));
  const ok = A.inS === B.inS && A.outS === B.outS;
  ok ? pass++ : fail++;
  console.log(`${k}  ${won(A.inS).padStart(18)}  ${won(B.inS).padStart(18)} │ ${won(A.outS).padStart(18)}  ${won(B.outS).padStart(18)} │ ${ok ? 'OK' : '불일치 (입금차 ' + won(B.inS - A.inS) + ' / 출금차 ' + won(B.outS - A.outS) + ')'}`);
}
console.log(`\n${pass}/${pass + fail} 일치`);
process.exit(fail ? 1 : 0);

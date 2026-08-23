/* 대시보드 일별 현금잔액 vs 클로브 실제 일별 잔액 대조.
   클로브쪽 데이터: docs/audit/clobe-daily-trend-2026.tsv
     get_account_balance_trend(inquiryWeeks=34).checkingTrends 를 옮겨 적은 것.
     ⚠ 이름은 checking 이지만 외화 KRW 환산까지 포함한 총현금이다 —
       8/21 값 708,575,602 가 bank_snapshot.totalCash(예금 642,939,378 + 외화 65,636,224)와 같다.

   비교 방식: **레벨이 아니라 일별 증감**을 본다.
     FX_ADJ 가 날짜 없는 상수로 전 구간에 얹히기 때문에(index.html 5155 의 의도된 절충)
     레벨 차이는 항상 약 -1.26억이 깔린다. 증감으로 보면 그 상수가 상쇄돼,
     **특정 날짜에만 튀는 차이 = 그 날의 실제 데이터 문제**가 드러난다.

   실행: node scripts/verify-daily-balance-vs-clobe.mjs [--tol 1000000] [--show-all] */
import fs from 'node:fs';
const argv=process.argv.slice(2);
const opt=(k,d)=>{const i=argv.indexOf(k);return i<0?d:argv[i+1];};
const TOL=Number(opt('--tol','1000000'));      // 이 금액 이하 차이는 환율 변동으로 보고 넘긴다
const SHOWALL=argv.includes('--show-all');
const TR='docs/audit/clobe-daily-trend-2026.tsv';
const PK='sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const SECRET=fs.readFileSync('C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret','utf8').trim();
const EP='https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
const call=async(b)=>{for(let i=1;i<=4;i++){try{
  const r=await fetch(EP,{method:'POST',headers:{'Content-Type':'application/json',apikey:PK,Authorization:`Bearer ${PK}`},body:JSON.stringify({secret:SECRET,...b})});
  const t=await r.text(); if(!t.trimStart().startsWith('{')) throw new Error(`HTTP ${r.status}`);
  const j=JSON.parse(t); if(!j.rows && !j.meta && !j.ok) throw new Error('Edge 오류'); return j;
}catch(e){ if(i===4) throw e; await new Promise(s=>setTimeout(s,800*i)); }}};
const won=(n)=>Math.round(n).toLocaleString('ko-KR');
const eok=(n)=>(n/1e8).toFixed(2);

const trend=new Map();
for(const l of fs.readFileSync(TR,'utf8').split(/\r?\n/)){
  if(!l.trim()) continue; const [d,v]=l.split('\t'); trend.set(d.trim(), Number(v));
}
const m=await call({inspect:{from:'2026-01-01',to:'2026-01-01',meta:['settings','bank_snapshot','fx_adjust_base']}});
const INIT=m.meta.settings.init_cash, BS=m.meta.bank_snapshot, PRE=Number(m.meta.fx_adjust_base.pre_krw||0);
const rows=[];
for(const y of [2025,2026,2027]) for(let mo=1;mo<=12;mo++){
  const last=new Date(Date.UTC(y,mo,0)).getUTCDate();
  for(let d=1;d<=last;d+=15){
    const j=await call({inspect:{from:`${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`,to:`${y}-${String(mo).padStart(2,'0')}-${String(Math.min(d+14,last)).padStart(2,'0')}`}});
    rows.push(...(j.rows||[]));
  }
}
let FXSUM=0; for(const r of rows) if(r.fx_usd) FXSUM+=(r.in||0)-(r.out||0);
const FXADJ=Math.round(BS.fxKrw-(PRE+FXSUM));
const real=rows.filter(r=>r.status==='실제 입금'||r.status==='실제 지출');
/* 일별 순flow */
const flow=new Map();
for(const r of real){ const a=r.status==='실제 입금'?r.in:-r.out; flow.set(r.date,(flow.get(r.date)||0)+a); }
/* 대시보드 일별 잔액 */
const dates=[...trend.keys()].sort();
let run=INIT+FXADJ;
const dash=new Map();
{ /* 첫 날짜 이전 거래를 기초에 눌러 담는다 */
  const first=dates[0];
  for(const r of real) if(r.date<first) run+= r.status==='실제 입금'?r.in:-r.out;
  for(const d of dates){ run+=(flow.get(d)||0); dash.set(d,run); }
}
console.log(`INIT_CASH ${won(INIT)} · FX_ADJ ${won(FXADJ)} · 비교일수 ${dates.length}일`);
console.log(`허용오차 ${won(TOL)} (외화 환율 일변동)\n`);
const bad=[];
let prevDiff=null;
for(const d of dates){
  const diff=dash.get(d)-trend.get(d);
  if(prevDiff!==null){
    const move=diff-prevDiff;
    if(Math.abs(move)>TOL) bad.push({d,move,diff,flow:flow.get(d)||0});
    if(SHOWALL) console.log(`${d}  대시보드 ${won(dash.get(d)).padStart(15)}  클로브 ${won(trend.get(d)).padStart(15)}  차 ${won(diff).padStart(13)}  전일比 ${won(move).padStart(13)}`);
  }
  prevDiff=diff;
}
console.log(`\n=== 전일 대비 차이가 ${won(TOL)} 넘게 움직인 날 : ${bad.length}일 ===`);
for(const b of bad) console.log(`  ${b.d}  움직임 ${won(b.move).padStart(15)} (${eok(b.move)}억)  · 그날 cf 순flow ${won(b.flow)}  · 누적차 ${won(b.diff)}`);
const first=dates[0], lastD=dates[dates.length-1];
console.log(`\n레벨 차이: ${first} ${won(dash.get(first)-trend.get(first))}  →  ${lastD} ${won(dash.get(lastD)-trend.get(lastD))}`);

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


const trend=new Map();
for(const l of fs.readFileSync(TR,'utf8').split(/\r?\n/)){
  if(!l.trim()) continue; const [d,v]=l.split('\t'); trend.set(d.trim(), Number(v));
}
const m=await call({inspect:{from:'2026-01-01',to:'2026-01-01',meta:['settings','bank_snapshot','fx_adjust_base']}});
const CF=String(m.meta.settings.cf_start||'').slice(0,10);
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
/* 대시보드의 fxAdjAt(date) 와 같은 램프를 여기서도 만든다 — 화면 기준으로 대조하기 위해.
   index.html 의 buildFxRamp_ 와 규칙이 같아야 한다(through 이후 · 환전 성격만 · |금액| 비중).
   --const 를 주면 종전 상수 방식으로 대조해 개선폭을 볼 수 있다. */
const CONST_MODE=argv.includes('--const');
const FX_CONV_MIDS=['계좌간이체','외환차손'];
const CUT=String(m.meta.fx_adjust_base.through||'').slice(0,10);
const conv=rows.filter(r=>r.fx_usd && String(r.date)>CUT && FX_CONV_MIDS.includes(r.mid_cat||''))
  .map(r=>({d:String(r.date).slice(0,10),a:Math.abs((r.in||0)-(r.out||0))}))
  .filter(x=>x.a>0).sort((p,q)=>p.d.localeCompare(q.d));
const convTot=conv.reduce((s,x)=>s+x.a,0);
const rampArr=[]; { let acc=0; const bd=new Map(); for(const x of conv){acc+=x.a; bd.set(x.d,acc/convTot);} for(const [d,w] of bd) rampArr.push({d,w}); }
const fxAdjAt=(d)=>{
  if(CONST_MODE || !CUT || !convTot) return FXADJ;
  if(d<=CUT) return 0;
  let w=0; for(const x of rampArr){ if(x.d<=d) w=x.w; else break; }
  return Math.round(FXADJ*w);
};
const real=rows.filter(r=>r.status==='실제 입금'||r.status==='실제 지출');
/* 일별 순flow */
const flow=new Map();
for(const r of real){ const a=r.status==='실제 입금'?r.in:-r.out; flow.set(r.date,(flow.get(r.date)||0)+a); }
/* 대시보드 일별 잔액 */
const dates=[...trend.keys()].sort();
let run=initCashEff(INIT, CF, real);
const dash=new Map();
{ /* 첫 날짜 이전 거래를 기초에 눌러 담는다. 환산조정은 날짜별로 emit 시점에 얹는다. */
  const first=dates[0];
  for(const r of real) if(r.date<first) run+= r.status==='실제 입금'?r.in:-r.out;
  for(const d of dates){ run+=(flow.get(d)||0); dash.set(d,run+fxAdjAt(d)); }
}
console.log(`INIT_CASH ${won(INIT)} · FX_ADJ ${won(FXADJ)} · 비교일수 ${dates.length}일 · 모드 ${CONST_MODE?'상수(종전)':'fxAdjAt 램프'}`);
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
/* 모델 품질 지표 — 상수 방식과 비교할 때 이게 핵심이다. */
{
  let sum=0,mx=0,worst=null;
  for(const d of dates){ const e=Math.abs(dash.get(d)-trend.get(d)); sum+=e; if(e>mx){mx=e;worst=d;} }
  console.log(`|차이| 평균 ${won(sum/dates.length)} · 최대 ${won(mx)} (${worst})`);
}

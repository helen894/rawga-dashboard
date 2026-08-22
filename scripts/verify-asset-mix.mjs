#!/usr/bin/env node
/**
 * verify-asset-mix.mjs — 대시보드 '총자산 구성 · 일별' 차트를 화면 밖에서 재현·대조한다.
 *
 * 왜 필요한가:
 *   이 차트는 층이 네 개(현금·매출채권·세종F2·라오스)이고 각 층의 정의가 다르다.
 *   화면에서는 마지막 값만 보이므로, 계산이 틀려도 "그럴싸한 그림" 이 나와 버린다.
 *   특히 매출채권은 회수일이 빈 46.4억을 3단으로 추정해 넣기 때문에 검산이 필수다.
 *
 * 무엇을 검사하는가:
 *   ① 불변식 — 마지막날 채권 잔액 == ar_data 미회수 합계 (차 0 이어야 한다)
 *   ② 구간 중립성 — 시작일을 바꿔도 마지막 값이 같아야 한다(base + Σdelta 경계 처리 검사).
 *      2026-08-22 에 구간을 '최근365일' → '연초~오늘' 로 바꿀 때 이걸로 확인했다.
 *   ③ 라이브 실측치 대조 — 배포본에서 눈으로 읽은 값과 맞는지
 *
 * 함정 (실제로 밟았다):
 *   · Edge inspect 는 cf 를 `rows` 로, AR 을 `ar` 로 준다. `rows||ar` 로 읽으면 cf 가 AR 로
 *     들어와 채권이 0 으로 나온다 — 처음에 이렇게 틀렸다.
 *   · `rows` 는 500건에서 잘리는데 `matched` 는 전체를 알려준다. 그래서 구간을 재귀로 쪼갠다.
 *   · 현금의 **절대값은 여기서 못 만든다** — INIT_CASH + FX_ADJ 가 필요하고, FX_ADJ 는 cf 행의
 *     fx_usd 플래그가 있어야 계산되는데 Edge inspect 가 그 필드를 잘라낸다. 그래서 현금은
 *     base=0 상대값으로만 비교한다(상수는 두 구간에 똑같이 더해지므로 ②에는 영향 없음).
 *
 * 쓰는 법: node scripts/verify-asset-mix.mjs
 *   TODAY 를 바꾸려면 아래 상수를 고친다(과거 시점 재현용).
 */

import { readFileSync } from 'node:fs';
const PK='sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const secret=readFileSync('C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret','utf8').trim();
const EP='https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
const post=async b=>{for(let i=1;i<=3;i++){try{
  const r=await fetch(EP,{method:'POST',headers:{'Content-Type':'application/json',apikey:PK,Authorization:`Bearer ${PK}`},body:JSON.stringify({secret,...b})});
  const t=await r.text(); if(!t.trim().startsWith('{'))throw new Error(`HTTP ${r.status}`); return JSON.parse(t);
}catch(e){if(i===3)throw e; await new Promise(s=>setTimeout(s,600*i));}}};
const addDays=(d,n)=>{const[y,m,dd]=d.split('-').map(Number);const t=new Date(Date.UTC(y,m-1,dd+n));return `${t.getUTCFullYear()}-${String(t.getUTCMonth()+1).padStart(2,'0')}-${String(t.getUTCDate()).padStart(2,'0')}`;};
const TODAY='2026-08-22';

/* cf_data 전량 — 반기 단위로 받되 500건에 걸리면 월로 쪼갠다 */
const seen=new Map(); let ar=null;
const grab=async(from,to,depth=0)=>{
  const r=await post({inspect:{from,to,...(ar?{}:{ar:true})}});
  if(!ar && Array.isArray(r.ar)) ar=r.ar;
  if(r.matched>500 && depth<4){                       // 잘렸다 → 반으로 쪼갠다
    const mid=addDays(from,Math.floor((Date.UTC(...to.split('-').map((v,i)=>i==1?v-1:+v))-Date.UTC(...from.split('-').map((v,i)=>i==1?v-1:+v)))/86400000/2));
    await grab(from,mid,depth+1); await grab(addDays(mid,1),to,depth+1); return;
  }
  for(const x of (r.rows||[])) seen.set(x._id||`${x.date}|${x.desc}|${x.in}|${x.out}`,x);
  if(r.matched>500) console.log(`  ⚠ ${from}~${to} 여전히 ${r.matched}건 (500만 받음)`);
};
for(const [f,t] of [['2020-01-01','2025-06-30'],['2025-07-01','2025-12-31'],['2026-01-01','2026-06-30'],['2026-07-01','2027-12-31']]) await grab(f,t);
const cfData=[...seen.values()];
console.log(`cf_data ${cfData.length}건 (${cfData.map(r=>r.date).filter(Boolean).sort()[0]} ~ ${cfData.map(r=>r.date).filter(Boolean).sort().pop()}) · ar_data ${ar.length}건`);

const AR_LAG_DAYS=9, AR_FALLBACK_DAYS=30;
function arDailyDelta(arRows,cfRows,today){
  const isD=v=>/^\d{4}-\d{2}-\d{2}$/.test(String(v||''));
  const norm=p=>String(p||'').replace(/\(.*?\)/g,'').replace(/\s+/g,'');
  const delta={},byRule={actual:0,fifo:0,due:0,fallback:0};
  const bump=(d,v)=>{if(d)delta[d]=(delta[d]||0)+v;};
  const deps=(cfRows||[]).filter(r=>r.status==='실제 입금'&&(r.in||0)>0)
    .map(r=>({date:r.date,left:r.in||0,t:norm((r.mid_cat||'')+(r.desc||''))}))
    .sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  const pool={}; const poolFor=p=>(pool[p]=pool[p]||deps.filter(d=>d.t.includes(norm(p))));
  const rows=(arRows||[]).slice().sort((a,b)=>String(a.start).localeCompare(String(b.start)));
  for(const x of rows){
    const exp=Number(x.expected)||0,col=Number(x.collected)||0;
    if(isD(x.start)&&exp)bump(x.start,exp);
    if(col<=0)continue;
    if(isD(x.collect_date)){bump(x.collect_date,-col);byRule.actual+=col;continue;}
    let left=col;
    for(const d of poolFor(x.partner)){
      if(left<=0)break; if(d.left<=0)continue;
      if(isD(x.start)&&d.date<x.start)continue;
      const take=Math.min(left,d.left); d.left-=take; left-=take;
      bump(d.date,-take); byRule.fifo+=take;
    }
    if(left>0){ let d,rule;
      if(isD(x.due_date)&&x.due_date<=today){d=addDays(x.due_date,AR_LAG_DAYS);rule='due';}
      else{d=isD(x.start)?addDays(x.start,AR_FALLBACK_DAYS):today;rule='fallback';}
      if(d>today)d=today; bump(d,-left); byRule[rule]+=left; }
  }
  return {delta,byRule};
}
function build(from,cashConst=0){
  const dates=[]; for(let d=from;d<=TODAY;d=addDays(d,1))dates.push(d);
  const cashDelta={}; let cashBase=cashConst;
  for(const r of cfData){ if(!r.date)continue;
    const v=r.status==='실제 입금'?(r.in||0):(r.status==='실제 지출'?-(r.out||0):0);
    if(!v)continue;
    if(r.date<from)cashBase+=v; else if(r.date<=TODAY)cashDelta[r.date]=(cashDelta[r.date]||0)+v; }
  const invDelta={'세종시':{},'라오스':{}}, invBase={'세종시':0,'라오스':0};
  for(const r of cfData){ const c=r.big_cat;
    if(c!=='세종시'&&c!=='라오스')continue;
    if(r.status!=='실제 지출'&&r.status!=='지출 예정')continue;
    const v=r.out||0; if(!v||!r.date)continue;
    if(r.date<from)invBase[c]+=v; else if(r.date<=TODAY)invDelta[c][r.date]=(invDelta[c][r.date]||0)+v; }
  const {delta:arDelta,byRule}=arDailyDelta(ar,cfData,TODAY);
  let arBase=0; for(const d of Object.keys(arDelta))if(d<from)arBase+=arDelta[d];
  let c1=cashBase,a1=arBase,s1=invBase['세종시'],l1=invBase['라오스'];
  let neg=[], last={};
  for(const d of dates){
    c1+=(cashDelta[d]||0); a1+=(arDelta[d]||0);
    s1+=(invDelta['세종시'][d]||0); l1+=(invDelta['라오스'][d]||0);
    if(c1<0) neg.push([d,Math.round(c1)]);
    last={cash:Math.max(0,Math.round(c1)),ar:Math.max(0,Math.round(a1)),sej:Math.round(s1),lao:Math.round(l1)};
  }
  return {n:dates.length,from,...last,neg,byRule,rawCash:Math.round(c1)};
}
const eok=v=>(v/1e8).toFixed(1);
const A=build(addDays(TODAY,-364)), B=build('2026-01-01');
console.log('\n구간(현금은 base=0 상대값)         일수    현금Δ     채권      세종     라오스');
for(const r of [A,B]) console.log(`${r.from} ~ ${TODAY}          ${String(r.n).padStart(3)}  ${eok(r.rawCash).padStart(8)} ${eok(r.ar).padStart(8)}억 ${eok(r.sej).padStart(8)}억 ${eok(r.lao).padStart(7)}억`);
const same=['ar','sej','lao'].every(k=>A[k]===B[k]) && A.rawCash===B.rawCash;
console.log(same?'\n✅ 마지막 값 4종 동일 — 구간 변경이 값을 바꾸지 않는다':'\n❌ 불일치');
for(const k of ['rawCash','ar','sej','lao']) if(A[k]!==B[k]) console.log(`   ${k}: ${A[k].toLocaleString()} vs ${B[k].toLocaleString()}`);

/* 라이브 검증치(2026-08-21 배포본 실측)와 대조 — 현금은 INIT_CASH+FX_ADJ 상수가 빠져 있어 제외 */
const LIVE={ar:149.7,sej:70.4,lao:12.0};
console.log('\n라이브 실측치 대조 (2026-08-21):');
for(const [k,v] of Object.entries(LIVE)){
  const mine=Number(eok(B[k])); const ok=Math.abs(mine-v)<=0.15;
  console.log(`  ${k.padEnd(5)} 재현 ${mine}억 vs 실측 ${v}억  ${ok?'✅':'❌ 차 '+(mine-v).toFixed(1)+'억'}`);
}
const rTot=B.byRule; const est=rTot.fifo+rTot.due+rTot.fallback;
console.log(`\n채권 회수일 추정: 실제 ${eok(rTot.actual)}억 · FIFO ${eok(rTot.fifo)}억 · 예정+9 ${eok(rTot.due)}억 · 발생+30 ${eok(rTot.fallback)}억 (추정합 ${eok(est)}억)`);
const arRemain=ar.reduce((s,r)=>s+(r.remaining!=null?r.remaining:(r.expected||0)-(r.collected||0)),0);
console.log(`불변식 — 마지막날 채권 ${B.ar.toLocaleString()} vs ar_data 미회수합 ${Math.round(arRemain).toLocaleString()}  차 ${(B.ar-Math.round(arRemain)).toLocaleString()}`);
console.log(`\n현금 음수일(base=0 상대값이라 실제 음수 여부는 아님): 연초구간 ${B.neg.length}일`);

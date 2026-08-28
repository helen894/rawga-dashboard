#!/usr/bin/env node
/**
 * analyze-recurring-feasibility.mjs — 과거 입출금에서 반복 패턴을 추론할 수 있는지 백테스트한다.
 *
 * 질문(2026-08-24): 클로브처럼 과거 데이터로 반복 입출금을 자동 추론할 수 있나?
 *
 * 방법: 특정 시점(CUT)까지로 규칙을 뽑아 그 이후를 예측하고 실제와 대조한다.
 *   규칙 = (정규화 적요 + 중분류 + 입출 방향) 그룹이 3개월 이상 등장하고,
 *          최근 3개월 중 2개월 이상에 나타나는 것. 일자·금액 안정성으로 A/B/C 등급.
 *
 * 2026-08-24 실측 결론 — **전체 자금 예측용으로는 못 쓴다.**
 *   · 규칙 45개 중 8월에 실제 발생 11개(24%)
 *   · 8월 실제 174건 54.44억 중 규칙이 설명 16건 5.38억 = 건수 9% · 금액 10%
 *   · **일자는 정확**(오차 중앙값 0일·최대 3일) / **금액은 부정확**(A 0% · B 27.5% · C 131%)
 *   · 원인은 구조적: 8월 금액의 71%가 인오가닉(건별 딜)이라 반복이 아예 없다.
 *     반면 판매관리비 42% · 금융비용 33% 는 규칙으로 잡힌다(고정비는 된다).
 *
 * 그래서 쓸 수 있는 방향은 '예정 자동 생성' 이 아니라
 *   ① 반복거래 등록 후보 추천(사람이 승인) ② 고정비만 자동 ③ **누락 알림**
 *   ③ 이 가장 강하다 — 일자 정확도만 쓰고 금액은 안 쓰는 용법이기 때문이다.
 *
 * ⚠ 헛짚은 금액이 10.43억이었다. 이걸 그대로 예정 행으로 만들면 잔액 궤적이 크게 틀어진다.
 * ⚠ 수기 등록된 반복거래는 0건이다 — 반복 거래 탭 기능은 있는데 아무도 안 쓰고 있다.
 *
 * 데이터가 쌓이면 다시 돌려 볼 것. CUT/TEST_TO 상수를 바꾸면 다른 구간을 검증한다.
 */

/* 반복 입출금을 과거 데이터에서 추론할 수 있는가 — 백테스트로 확인한다.
   7월까지로 규칙을 뽑아 8월을 예측하고, 실제 8월과 대조한다. */
import { readFileSync } from 'node:fs';
const PK='sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const secret=readFileSync('C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret','utf8').trim();
const EP='https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
const post=async b=>{for(let i=1;i<=3;i++){try{
  const r=await fetch(EP,{method:'POST',headers:{'Content-Type':'application/json',apikey:PK,Authorization:`Bearer ${PK}`},body:JSON.stringify({secret,...b})});
  const t=await r.text(); if(!t.trim().startsWith('{'))throw new Error('x'); return JSON.parse(t);
}catch(e){if(i===3)throw e; await new Promise(s=>setTimeout(s,700*i));}}};
const addDays=(d,n)=>{const[y,m,dd]=d.split('-').map(Number);const t=new Date(Date.UTC(y,m-1,dd+n));return `${t.getUTCFullYear()}-${String(t.getUTCMonth()+1).padStart(2,'0')}-${String(t.getUTCDate()).padStart(2,'0')}`;};
const won=v=>Math.round(v).toLocaleString('ko-KR'), eok=v=>(v/1e8).toFixed(2);
const seen=new Map(); let meta=null;
const grab=async(f,t,d0=0)=>{ const r=await post({inspect:{from:f,to:t,...(meta?{}:{meta:['recur_data']})}});
  if(!meta&&r.meta) meta=r.meta;
  if(r.matched>500&&d0<7){ const days=(Date.parse(t)-Date.parse(f))/86400000, mid=addDays(f,Math.floor(days/2));
    await grab(f,mid,d0+1); await grab(addDays(mid,1),t,d0+1); return; }
  for(const x of (r.rows||[])) seen.set(x._id,x); };
for(const [f,t] of [['2020-01-01','2025-12-31'],['2026-01-01','2026-06-30'],['2026-07-01','2027-12-31']]) await grab(f,t);
const cf=[...seen.values()].filter(r=>r.status==='실제 입금'||r.status==='실제 지출');
const rec=meta?.recur_data||[];
console.log(`cf_data 실거래 ${cf.length}건 (${cf.map(r=>r.date).sort()[0]} ~ ${cf.map(r=>r.date).sort().pop()})`);
console.log(`수기 등록된 반복거래: ${Array.isArray(rec)?rec.length:0}건\n`);

/* ── 적요 정규화 ── 은행 접두어·숫자·공백을 털어낸다 */
const BANK=/^(기업|신한|국민|하나|농협|우리|KB|IBK|SC|씨티|카카오|토스)/;
const norm=t=>{let s=String(t||'').replace(/[\s\u3000]+/g,'');
  for(let i=0;i<2;i++) s=s.replace(BANK,'');
  return s.replace(/[0-9０-９]+/g,'').replace(/\(.*?\)/g,'').slice(0,18);};
const key=r=>`${norm(r.desc)}|${r.mid_cat||''}|${(r.in||0)>0?'IN':'OUT'}`;
const med=a=>{const s=[...a].sort((x,y)=>x-y);return s.length?s[Math.floor(s.length/2)]:0;};
const mad=(a,m)=>med(a.map(v=>Math.abs(v-m)));

/* ── 규칙 추출 ── */
function learn(rows, upto){
  const g={};
  for(const r of rows){ if(!r.date||r.date>upto)continue; (g[key(r)]=g[key(r)]||[]).push(r); }
  const rules=[];
  for(const [k,list] of Object.entries(g)){
    if(list.length<3) continue;
    const months=[...new Set(list.map(r=>r.date.slice(0,7)))].sort();
    if(months.length<3) continue;
    /* 연속성 — 마지막 3개월 중 최소 2개월에 등장해야 '살아 있는' 반복으로 본다 */
    const lastM=[0,1,2].map(i=>{const[y,m]=upto.split('-').map(Number);let mm=m-i,yy=y;while(mm<1){mm+=12;yy--;}
      return `${yy}-${String(mm).padStart(2,'0')}`;});
    const alive=lastM.filter(m=>months.includes(m)).length;
    if(alive<2) continue;
    const days=list.map(r=>Number(r.date.slice(8,10)));
    const amts=list.map(r=>(r.in||0)+(r.out||0));
    const dM=med(days), dMad=mad(days,dM);
    const aM=med(amts), aMad=mad(amts,aM);
    const cv=aM? aMad/aM : 1;
    rules.push({k, n:list.length, months:months.length, alive, day:dM, dayMad:dMad,
      amt:aM, amtCv:cv, dir:k.endsWith('|IN')?'IN':'OUT',
      mid:k.split('|')[1], name:k.split('|')[0],
      /* 등급: 일자·금액 모두 안정 / 일자만 안정 / 느슨 */
      grade: (dMad<=2&&cv<=0.10)?'A' : (dMad<=3&&cv<=0.35)?'B' : (dMad<=5)?'C':'D'});
  }
  return rules.sort((a,b)=>b.amt-a.amt);
}
const CUT='2026-07-31', TEST_TO='2026-08-24';
const rules=learn(cf,CUT).filter(r=>r.grade!=='D');
console.log('=== 7월까지로 뽑은 반복 규칙 ===');
const byG={A:[],B:[],C:[]}; for(const r of rules) byG[r.grade].push(r);
for(const g of ['A','B','C']){
  const t=byG[g].reduce((s,r)=>s+r.amt,0);
  console.log(`  ${g}등급 ${String(byG[g].length).padStart(3)}건 · 월 ${eok(t).padStart(7)}억  ${g==='A'?'일자±2일·금액±10%':g==='B'?'일자±3일·금액±35%':'일자±5일(금액 변동)'}`);
}
console.log('\n  상위 12개:');
console.log('  등급 일자 금액(중앙값)        건수 월수 방향 분류        적요');
for(const r of rules.slice(0,12))
  console.log(`   ${r.grade}  ${String(r.day).padStart(2)}일 ${won(r.amt).padStart(14)} ${String(r.n).padStart(4)} ${String(r.months).padStart(3)} ${r.dir==='IN'?'입금':'출금'} ${(r.mid||'-').slice(0,8).padEnd(9)} ${r.name.slice(0,16)}`);

/* ── 백테스트: 8월 예측 vs 실제 ── */
const act=cf.filter(r=>r.date>CUT&&r.date<=TEST_TO);
const actByKey={}; for(const r of act) (actByKey[key(r)]=actByKey[key(r)]||[]).push(r);
let hit=0,hitAmt=0,miss=0,missAmt=0,dayErr=[],amtErrPct=[];
const TOL=4;   // 일자 허용 ±4일
for(const r of rules){
  const a=actByKey[r.k];
  if(!a||!a.length){ miss++; missAmt+=r.amt; continue; }
  const near=a.find(x=>Math.abs(Number(x.date.slice(8,10))-r.day)<=TOL);
  if(!near){ miss++; missAmt+=r.amt; continue; }
  hit++; hitAmt+=r.amt;
  dayErr.push(Math.abs(Number(near.date.slice(8,10))-r.day));
  const real=(near.in||0)+(near.out||0);
  if(real) amtErrPct.push(Math.abs(real-r.amt)/real*100);
}
const predKeys=new Set(rules.map(r=>r.k));
const unpred=act.filter(r=>!predKeys.has(key(r)));
const actTot=act.reduce((s,r)=>s+(r.in||0)+(r.out||0),0);
const coveredTot=act.filter(r=>predKeys.has(key(r))).reduce((s,r)=>s+(r.in||0)+(r.out||0),0);
console.log(`\n=== 백테스트 (${CUT} 까지 학습 → 8/1~8/24 예측) ===`);
console.log(`규칙 ${rules.length}개 중 실제로 발생: ${hit}개 (${(hit/rules.length*100).toFixed(0)}%) · 안 발생 ${miss}개`);
console.log(`  적중분 월금액 합 ${eok(hitAmt)}억 · 헛짚은 금액 ${eok(missAmt)}억`);
if(dayErr.length) console.log(`  일자 오차 중앙값 ${med(dayErr)}일 · 최대 ${Math.max(...dayErr)}일`);
if(amtErrPct.length) console.log(`  금액 오차 중앙값 ${med(amtErrPct).toFixed(1)}% · 평균 ${(amtErrPct.reduce((a,b)=>a+b,0)/amtErrPct.length).toFixed(1)}%`);
console.log(`\n8월 실제 거래 ${act.length}건 ${eok(actTot)}억 중`);
console.log(`  규칙이 설명하는 것 ${act.length-unpred.length}건 ${eok(coveredTot)}억 (건수 ${((act.length-unpred.length)/act.length*100).toFixed(0)}% · 금액 ${(coveredTot/actTot*100).toFixed(0)}%)`);
console.log(`  규칙에 없던 것    ${unpred.length}건 ${eok(actTot-coveredTot)}억`);
console.log('\n  규칙에 없던 큰 건 상위 6개 (예측 불가능한 성격):');
for(const r of unpred.sort((a,b)=>((b.in||0)+(b.out||0))-((a.in||0)+(a.out||0))).slice(0,6))
  console.log(`    ${r.date} ${won((r.in||0)-(r.out||0)).padStart(16)} ${(r.big_cat||'-').padEnd(7)} ${String(r.desc||'').slice(0,24)}`);

/* ── 어느 분류가 예측 가능한가 ── */
console.log('\n=== 등급별 적중률 ===');
for(const g of ['A','B','C']){
  const rs=byG[g]; let h=0,ae=[];
  for(const r of rs){ const a=actByKey[r.k];
    if(a&&a.find(x=>Math.abs(Number(x.date.slice(8,10))-r.day)<=TOL)){h++;
      const near=a.find(x=>Math.abs(Number(x.date.slice(8,10))-r.day)<=TOL);
      const real=(near.in||0)+(near.out||0); if(real)ae.push(Math.abs(real-r.amt)/real*100);} }
  console.log(`  ${g}등급 ${String(rs.length).padStart(3)}개 → 적중 ${String(h).padStart(2)}개 (${rs.length?(h/rs.length*100).toFixed(0):0}%)` +
    (ae.length?` · 금액오차 중앙 ${med(ae).toFixed(1)}%`:''));
}
console.log('\n=== 대분류별: 8월 실제 vs 규칙이 잡은 것 ===');
const cats={};
for(const r of act){ const c=r.big_cat||'(미분류)'; const v=(r.in||0)+(r.out||0);
  const k=cats[c]=cats[c]||{n:0,amt:0,cn:0,camt:0};
  k.n++; k.amt+=v; if(predKeys.has(key(r))){k.cn++;k.camt+=v;} }
console.log('  대분류        건수  금액      규칙적용   금액커버');
for(const [c,v] of Object.entries(cats).sort((a,b)=>b[1].amt-a[1].amt))
  console.log(`  ${(c+'          ').slice(0,12)} ${String(v.n).padStart(4)} ${eok(v.amt).padStart(7)}억 ${String(v.cn).padStart(6)}건 ${(v.amt?v.camt/v.amt*100:0).toFixed(0).padStart(7)}%`);

console.log('\n=== 중분류별 안정성 (전체 기간, 3개월 이상 등장) ===');
const g2={};
for(const r of cf){ const m=r.mid_cat||''; if(!m)continue;
  const k=g2[m]=g2[m]||{months:new Set(),amts:[],days:[],n:0};
  k.months.add(r.date.slice(0,7)); k.amts.push((r.in||0)+(r.out||0)); k.days.push(Number(r.date.slice(8,10))); k.n++; }
const stab=Object.entries(g2).filter(([,v])=>v.months.size>=3&&v.n>=4).map(([m,v])=>{
  const aM=med(v.amts), dM=med(v.days);
  return {m, n:v.n, mo:v.months.size, cv:aM?mad(v.amts,aM)/aM:1, dmad:mad(v.days,dM), amt:aM};
}).sort((a,b)=>a.cv-b.cv);
console.log('  중분류          건수 월수 금액변동 일자흔들림 월중앙금액');
for(const s of stab.slice(0,10))
  console.log(`  ${(s.m+'              ').slice(0,15)} ${String(s.n).padStart(4)} ${String(s.mo).padStart(4)} ${(s.cv*100).toFixed(0).padStart(7)}% ${String(s.dmad).padStart(8)}일 ${won(s.amt).padStart(13)}`);
console.log('  … 변동 큰 쪽:');
for(const s of stab.slice(-4))
  console.log(`  ${(s.m+'              ').slice(0,15)} ${String(s.n).padStart(4)} ${String(s.mo).padStart(4)} ${(s.cv*100).toFixed(0).padStart(7)}% ${String(s.dmad).padStart(8)}일 ${won(s.amt).padStart(13)}`);

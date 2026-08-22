#!/usr/bin/env node
/**
 * verify-fx-spread-split.mjs — 2026-07-09 환전 스프레드 분할이 유지되고 있는지 검증한다.
 *
 * 무엇을 했나 (2026-08-22):
 *   7/9 환전에서 외화계좌 출금 754,950,000 과 원화계좌 입금 745,945,000 의 차이
 *   9,005,000 × 2건 = 18,010,000 은 은행에 실제로 낸 환전 스프레드(1.19%)인데
 *   '자금이동' 한 행에 섞여 비용으로 안 잡혔다. Edge 의 split 액션으로 두 행을
 *   `자금이동/계좌간이체 745,945,000` + `영업외비용/외환차손 9,005,000` 으로 쪼갰다.
 *
 * 왜 검증이 필요한가: 재적재(push)가 clobe_id 로 찾은 행의 금액을 갱신하지 않는다는
 *   전제 위에 서 있다. 그 전제가 깨지면 분할이 조용히 되돌아간다.
 *
 * 검사하는 불변식 4개:
 *   ① cf_data 행수 1,599 — 분할로 2행 늘어난 상태가 유지되는가
 *   ② 실제 입출금 누계 270,388,360 — 분할은 금액을 보존해야 한다(현금 총액 불변)
 *   ③ fx_usd 표시 행 순증 76,422,317 — 떼낸 행도 fx_usd 를 물려받아야 한다
 *   ④ 역산 FX_ADJ -125,767,193 — 분할은 환산손익을 바꾸지 않는다
 *   추가: 7/9 자금이동 순액 0, 외환차손 합계 18,010,000
 *
 * ⚠ 이 분할은 FX_ADJ 를 고치지 않는다. FX_ADJ -1.26억은 7월 KB 외화계좌를 통과한
 *   USD 3.84M 의 입·출 환율 차이(1,539.7 vs 1,507.1)에서 나오고, 근본 해결은
 *   외화를 USD 원금으로 관리하는 것뿐이다. 여기서 고친 건 분류다.
 *
 * 쓰는 법: node scripts/verify-fx-spread-split.mjs
 */

/* 분할 후 불변식 검증 — 현금 총액·환산손익 장부·자금이동 균형 */
import { readFileSync } from 'node:fs';
const PK='sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const secret=readFileSync('C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret','utf8').trim();
const EP='https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
const post=async b=>{for(let i=1;i<=3;i++){try{
  const r=await fetch(EP,{method:'POST',headers:{'Content-Type':'application/json',apikey:PK,Authorization:`Bearer ${PK}`},body:JSON.stringify({secret,...b})});
  const t=await r.text(); if(!t.trim().startsWith('{'))throw new Error('x'); return JSON.parse(t);
}catch(e){if(i===3)throw e; await new Promise(s=>setTimeout(s,700*i));}}};
const addDays=(d,n)=>{const[y,m,dd]=d.split('-').map(Number);const t=new Date(Date.UTC(y,m-1,dd+n));return `${t.getUTCFullYear()}-${String(t.getUTCMonth()+1).padStart(2,'0')}-${String(t.getUTCDate()).padStart(2,'0')}`;};
const won=v=>Math.round(v).toLocaleString('ko-KR');
const seen=new Map(); let meta=null;
const grab=async(f,t,d0=0)=>{ const r=await post({inspect:{from:f,to:t,...(meta?{}:{meta:['settings','bank_snapshot','fx_adjust_base']})}});
  if(!meta&&r.meta) meta=r.meta;
  if(r.matched>500&&d0<6){ const days=(Date.parse(t)-Date.parse(f))/86400000, mid=addDays(f,Math.floor(days/2));
    await grab(f,mid,d0+1); await grab(addDays(mid,1),t,d0+1); return; }
  for(const x of (r.rows||[])) seen.set(x._id,x); };
for(const [f,t] of [['2020-01-01','2025-12-31'],['2026-01-01','2026-06-30'],['2026-07-01','2027-12-31']]) await grab(f,t);
const cf=[...seen.values()];
const TODAY='2026-08-22';
const exp={rows:1599, deltas:270388360, fxSum:76422317, fxAdj:-125767193};
let sum=0; for(const r of cf){ if(!r.date||r.date>TODAY)continue;
  if(r.status==='실제 입금') sum+=(r.in||0); else if(r.status==='실제 지출') sum-=(r.out||0); }
const fxSum=cf.filter(r=>r.fx_usd===true).reduce((s,r)=>s+((r.in||0)-(r.out||0)),0);
const INIT=Number(meta.settings?.init_cash)||0, snap=Number(meta.bank_snapshot?.totalCash)||0;
const fxAdj=snap-INIT-sum;
const chk=(name,got,want)=>console.log(`${got===want?'✅':'❌'} ${name.padEnd(26)} ${won(got).padStart(16)}  (기대 ${won(want)})`);
console.log('=== 불변식 ===');
chk('cf_data 행수', cf.length, exp.rows);
chk('실제 입출금 누계', Math.round(sum), exp.deltas);
chk('fx_usd 표시 행 순증', Math.round(fxSum), exp.fxSum);
chk('역산 FX_ADJ', Math.round(fxAdj), exp.fxAdj);

console.log('\n=== 2026-07-09 자금이동 균형 ===');
const d9=cf.filter(r=>r.date==='2026-07-09'&&r.big_cat==='자금이동');
const net9=d9.reduce((s,r)=>s+((r.in||0)-(r.out||0)),0);
for(const r of d9.sort((a,b)=>Math.abs((b.in||0)-(b.out||0))-Math.abs((a.in||0)-(a.out||0))))
  console.log(`  ${won((r.in||0)-(r.out||0)).padStart(16)} fx=${r.fx_usd?'✔':'✘'} ${(r.mid_cat||'-').padEnd(9)} ${String(r.desc||'').slice(0,16)}`);
console.log(`  ${net9===0?'✅':'❌'} 자금이동 순액 ${won(net9)} (기대 0)`);

console.log('\n=== 새로 잡힌 외환차손 ===');
const fx=cf.filter(r=>r.big_cat==='영업외비용'&&r.mid_cat==='외환차손');
for(const r of fx) console.log(`  ${r.date}  ${won(-(r.out||0)).padStart(14)}  fx=${r.fx_usd?'✔':'✘'}  ${String(r.desc||'').slice(0,44)}`);
const fxTot=fx.reduce((s,r)=>s+(r.out||0),0);
console.log(`  ${fxTot===18010000?'✅':'❌'} 합계 ${won(fxTot)} (기대 18,010,000)`);
console.log('\n=== 영업외비용 대분류 2026년 순액 ===');
const ob=cf.filter(r=>r.big_cat==='영업외비용'&&r.date>='2026-01-01'&&r.date<=TODAY&&(r.status==='실제 입금'||r.status==='실제 지출'));
console.log(`  ${won(ob.reduce((s,r)=>s+((r.in||0)-(r.out||0)),0))} (${ob.length}건)`);

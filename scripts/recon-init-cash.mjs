/* INIT_CASH · pre_krw 역산기.
   대시보드 계산식(renderCashChart / computeCFBalances)을 그대로 재현한다:
     balance(d) = INIT_CASH + FX_ADJ + Σ(실제 입금 in) − Σ(실제 지출 out),  date ≤ d
     FX_ADJ     = bankSnapshot.fxKrw − (fx_adjust_base.pre_krw + Σ(fx_usd 행의 in−out))
   ⚠ 범주 제외가 없다. 전 기간(cf_data 는 2025-10 ~ 2027-05)을 다 더해야 한다 —
     2026년만 더하면 314M 어긋난다(실측).
   ⚠ INIT_CASH 와 pre_krw 는 **서로 얽혀 있다.** pre_krw 를 낮추면 FX_ADJ 가 같은 만큼
     올라가 잔액도 올라간다. 그래서 둘을 따로 뽑은 값을 동시에 적용하면 그 차이만큼
     이중반영된다. 반드시 이 스크립트로 함께 계산할 것.
   실행: node scripts/recon-init-cash.mjs [--drop <_id>...] [--pre-krw <원>] [--at YYYY-MM-DD] */
import fs from 'node:fs';
const argv=process.argv.slice(2);
const opt=(k,d)=>{const i=argv.indexOf(k);return i<0?d:argv[i+1];};
const list=(k)=>{const i=argv.indexOf(k);if(i<0)return[];const o=[];for(let j=i+1;j<argv.length&&!argv[j].startsWith('--');j++)o.push(argv[j]);return o;};
const DROP=new Set(list('--drop')), AT=opt('--at','2026-08-21');
const PK='sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const SECRET=fs.readFileSync('C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret','utf8').trim();
const EP='https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
const call=async(b)=>{const r=await fetch(EP,{method:'POST',headers:{'Content-Type':'application/json',apikey:PK,Authorization:`Bearer ${PK}`},body:JSON.stringify({secret:SECRET,...b})});return JSON.parse(await r.text());};
const won=(n)=>Math.round(n).toLocaleString('ko-KR');

const m=await call({inspect:{from:'2026-01-01',to:'2026-01-01',meta:['settings','bank_snapshot','fx_adjust_base']}});
const INIT=m.meta.settings.init_cash, BS=m.meta.bank_snapshot;
const PRE_CUR=Number(m.meta.fx_adjust_base.pre_krw||0);
const PRE=Number(opt('--pre-krw',PRE_CUR));

const all=[];
for(const y of [2025,2026,2027]) for(let mo=1;mo<=12;mo++){
  const last=new Date(Date.UTC(y,mo,0)).getUTCDate();
  for(let d=1;d<=last;d+=15){
    const j=await call({inspect:{from:`${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`,to:`${y}-${String(mo).padStart(2,'0')}-${String(Math.min(d+14,last)).padStart(2,'0')}`}});
    if(j.matched>500) console.error(`⚠ 구간 ${j.matched}건 > 500 — rows 가 잘렸다. 구간을 더 쪼갤 것.`);
    all.push(...(j.rows||[]));
  }
}
const kept=all.filter(r=>!DROP.has(r._id));
console.log(`cf_data ${all.length}건 · 제외 ${all.length-kept.length}건 → ${kept.length}건`);
if(DROP.size) for(const r of all.filter(r=>DROP.has(r._id))) console.log(`  제외: ${r._id} ${r.date} ${won((r.in||0)-(r.out||0))} '${r.desc}'`);

let FXSUM=0; for(const r of kept) if(r.fx_usd) FXSUM+=(r.in||0)-(r.out||0);
const FXADJ=Math.round(BS.fxKrw-(PRE+FXSUM));
let S=0; for(const r of kept){ if(r.date>AT) continue; if(r.status==='실제 입금') S+=r.in; else if(r.status==='실제 지출') S-=r.out; }

console.log(`\npre_krw ${won(PRE)}${PRE!==PRE_CUR?` (현재 ${won(PRE_CUR)} 에서 변경 가정)`:''}`);
console.log(`Σ(fx_usd) ${won(FXSUM)}  →  FX_ADJ = ${won(BS.fxKrw)} − (${won(PRE)} + ${won(FXSUM)}) = ${won(FXADJ)}`);
console.log(`Σ(실거래 ≤ ${AT}) ${won(S)}`);
console.log(`\n은행 스냅샷 totalCash (${BS.asOf.slice(0,10)}) ${won(BS.totalCash)}`);
console.log(`현 init_cash ${won(INIT)} 로 계산한 ${AT} 잔액 = ${won(INIT+FXADJ+S)}  (차 ${won(INIT+FXADJ+S-BS.totalCash)})`);
console.log(`\n➡ 맞추려면 init_cash = ${won(BS.totalCash-S-FXADJ)}`);

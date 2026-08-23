/* 백필 무결성 검사 — API 재조회 없이 되는 것들.
   백필은 금액을 안 바꾸므로 합계 검증에 안 걸린다(틀려도 조용하다). 그래서 구조로 잡는다.

   검사 1  clobe_id 중복 없음 (서버가 거부하지만 3~6월 밖 행과의 충돌도 본다)
   검사 2  tx_at 의 날짜부분 == date 필드
   검사 3  신한 56019 계열 id 연속성 — 이 계좌는 id 가 시각순으로 1씩 증가하는
           단일 수열(129567626~129568281)이라, 오타가 나면 '구멍 + 범위밖 값'으로 드러난다.
   검사 4  id 순서와 tx_at 순서의 일치 (수열 계좌 한정) */
import fs from 'node:fs';
const PK='sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const SECRET=fs.readFileSync('C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret','utf8').trim();
const EP='https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
const call=async(b)=>{const r=await fetch(EP,{method:'POST',headers:{'Content-Type':'application/json',apikey:PK,Authorization:`Bearer ${PK}`},body:JSON.stringify({secret:SECRET,...b})});return JSON.parse(await r.text());};

const rows=[];
for(const m of ['01','02','03','04','05','06','07','08']){
  const last={'01':31,'02':28,'03':31,'04':30,'05':31,'06':30,'07':31,'08':31}[m];
  for(let d=1;d<=last;d+=10){
    const j=await call({inspect:{from:`2026-${m}-${String(d).padStart(2,'0')}`, to:`2026-${m}-${String(Math.min(d+9,last)).padStart(2,'0')}`}});
    rows.push(...(j.rows||[]));
  }
}
console.log(`전체 조회 ${rows.length}건 (2026-01-01 ~ 08-31)\n`);

// 1) 중복
const byId=new Map();
for(const r of rows) if(r.clobe_id){ if(!byId.has(r.clobe_id)) byId.set(r.clobe_id,[]); byId.get(r.clobe_id).push(r); }
const dup=[...byId.entries()].filter(([,v])=>v.length>1);
console.log(`검사1 clobe_id 중복 : ${dup.length?'✗ '+dup.length+'건':'✓ 없음'}`);
for(const [k,v] of dup.slice(0,10)) console.log(`   ${k} → ${v.map(x=>x._id+'@'+x.date).join(', ')}`);

// 2) tx_at 날짜 == date
const bad2=rows.filter(r=>r.tx_at && r.tx_at.slice(0,10)!==r.date);
console.log(`검사2 tx_at 날짜 불일치 : ${bad2.length?'✗ '+bad2.length+'건':'✓ 없음'}`);
for(const r of bad2.slice(0,10)) console.log(`   ${r._id} date=${r.date} tx_at=${r.tx_at} '${r.desc}'`);

// 3) 56019 수열 (129567xxx~129568xxx)
const seq=rows.filter(r=>/^1295(67|68)\d{3}$/.test(r.clobe_id||'')).map(r=>({n:Number(r.clobe_id),...r}))
              .sort((a,b)=>a.n-b.n);
const lo=seq[0]?.n, hi=seq[seq.length-1]?.n;
const have=new Set(seq.map(s=>s.n));
const gaps=[]; for(let n=lo;n<=hi;n++) if(!have.has(n)) gaps.push(n);
console.log(`검사3 신한 수열 : ${seq.length}건, 범위 ${lo}~${hi} (폭 ${hi-lo+1}), 구멍 ${gaps.length}건`);
if(gaps.length) console.log(`   구멍: ${gaps.slice(0,40).join(', ')}${gaps.length>40?' …':''}`);

// 4) id 순서 == tx_at 순서
let inv=0, firstInv=null;
for(let i=1;i<seq.length;i++){
  const a=seq[i-1], b=seq[i];
  if(a.tx_at && b.tx_at && a.tx_at > b.tx_at){ inv++; if(!firstInv) firstInv=[a,b]; }
}
console.log(`검사4 id순서 vs 시각순서 : ${inv?'✗ 역전 '+inv+'건':'✓ 일치'}`);
if(firstInv) console.log(`   예: ${firstInv[0].clobe_id}@${firstInv[0].tx_at} > ${firstInv[1].clobe_id}@${firstInv[1].tx_at}`);

/* 법인카드 대금 대분류를 '판매관리비' 로 통일한다 (2026-08-23 결정).
   3~6월 36건만 '카드대금' 이었고 나머지(1·2·7~10월)는 '판매관리비' 였다.

   왜 판매관리비인가 — 근거 4가지:
   1) 시스템의 정답이 이미 판매관리비다. cat_data.mid_to_big 에 '법인카드 대금 → 판매관리비'
      가 들어 있고, 카드대금은 **어떤 중분류의 매핑 대상도 아니다**(3~6월 36행에만 값으로
      박혀 있다 — xlsx 취합 때 파일의 대분류를 그대로 받은 흔적).
   2) 대시보드가 카드대금 예정행을 자동 생성할 때 getBigCat('법인카드 대금') 을 쓴다
      (index.html 의 카드 청구 추정 로직). 카드대금으로 정하면 **매달 새로 생기는 행이
      판매관리비로 되돌아가** 불일치가 스스로 재생산된다. 매핑까지 바꿔야 하는 일이 된다.
   3) 이중계상 위험이 없다. cf_data 는 은행 거래만 담고 카드 승인내역은 card_data(별도 탭)에
      있다. 결제행을 판매관리비에 넣어도 같은 돈이 두 번 잡히지 않는다.
   4) 이건 현금 대시보드다(발생기준 손익은 별도 대시보드). 현금이 나가는 시점에 기록하고,
      그 돈의 성격은 압도적으로 판관비다. 판매관리비가 '영업 현금유출 전체'가 되는 쪽이
      예측에 쓸모 있다 — 카드대금을 떼면 판관비가 약 14% 과소표시된다(3.91억/28.74억).

   카드 결제의 추적성은 대분류가 아니라 행의 card_bill_id·card_basis·card_est_amt 필드와
   법인카드 탭이 담당한다 — 별도 대분류가 없어도 감사 가능하다.

   실행: node scripts/normalize-card-bigcat.mjs [--apply] */
import fs from 'node:fs';
const APPLY = process.argv.includes('--apply');
const PK='sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const SECRET=fs.readFileSync('C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret','utf8').trim();
const EP='https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
const call=async(b)=>{for(let i=1;i<=4;i++){try{
  const r=await fetch(EP,{method:'POST',headers:{'Content-Type':'application/json',apikey:PK,Authorization:`Bearer ${PK}`},body:JSON.stringify({secret:SECRET,...b})});
  const t=await r.text(); if(!t.trimStart().startsWith('{')) throw new Error(`HTTP ${r.status}`); return JSON.parse(t);
}catch(e){ if(i===4) throw e; await new Promise(s=>setTimeout(s,700*i)); }}};
const won=(n)=>Math.round(n).toLocaleString('ko-KR');

const all=[];
for(const y of [2025,2026,2027]) for(let mo=1;mo<=12;mo++){
  const last=new Date(Date.UTC(y,mo,0)).getUTCDate();
  for(let d=1;d<=last;d+=15){
    const j=await call({inspect:{from:`${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`,to:`${y}-${String(mo).padStart(2,'0')}-${String(Math.min(d+14,last)).padStart(2,'0')}`}});
    all.push(...(j.rows||[]));
  }
}
/* 대상은 대분류가 '카드대금' 인 행 전부 — 중분류로 좁히지 않는다. 다른 중분류가 이 대분류를
   쓰고 있으면 그것도 보고에 드러나야 한다(그런 게 있으면 손대기 전에 멈춰야 하므로). */
const hit = all.filter((r) => r.big_cat === '카드대금').sort((a,b)=>a.date<b.date?-1:1);
const mids = new Map();
for (const r of hit) mids.set(r.mid_cat||'(빈값)', (mids.get(r.mid_cat||'(빈값)')||0)+1);

console.log(`=== 대분류 '카드대금' → '판매관리비' ===`);
console.log(`대상 ${hit.length}건 · 중분류 구성: ${[...mids.entries()].map(([k,v])=>`${k} ${v}건`).join(' · ')}`);
if (mids.size > 1) console.log(`⚠ 중분류가 여러 종류다 — 아래 목록을 확인하고 진행할 것.`);
let s=0; for (const r of hit) s += (r.in||0)-(r.out||0);
console.log(`합계 ${won(s)}`);
const byMonth = new Map();
for (const r of hit) byMonth.set(r.date.slice(0,7), (byMonth.get(r.date.slice(0,7))||0)+1);
console.log(`월별: ${[...byMonth.entries()].sort().map(([k,v])=>`${k} ${v}건`).join(' · ')}`);

if (!APPLY) {
  console.log(`\n[보고만] --apply 를 주면 ${hit.length}건의 big_cat 을 '판매관리비' 로 바꿉니다.`);
} else if (!hit.length) {
  console.log(`\n할 일 없음 (이미 통일됨).`);
} else {
  const CHUNK = 200;
  let updated = 0, nf = 0;
  for (let i = 0; i < hit.length; i += CHUNK) {
    const res = await call({ patch: hit.slice(i, i+CHUNK).map((r)=>({ _id:r._id, big_cat:'판매관리비' })) });
    updated += res.updated || 0; nf += (res.notFound||[]).length;
  }
  console.log(`\n적용 완료 — updated ${updated} · notFound ${nf}`);
}

/* 백필 사각지대 검사 — cf_data 의 clobe_id 가 실제로 클로브에 존재하고, 그 거래의
   날짜·금액이 cf_data 와 같은지 대조한다.

   왜 이게 필요했나
     백필은 금액을 안 바꾸므로 합계 검증에 안 걸린다. 그리고 push 의 중복판정은 들어온 행에
     clobe_id 가 있으면 **clobe_id 만** 본다(복합키 폴백 없음). 그래서 틀린 id 가 붙어 있으면
     그 기간을 재적재할 때 "없는 거래"로 판단해 **중복 행을 새로 만든다** — 2026-01-28 에
     실제로 났던 사고와 같은 종류다.

   왜 계열B 만인가
     신한 56019(계열A, id 1295xxxxx)는 시각순 +1 연속 수열이라 오타가 '중복(서버 거부)'이나
     '수열 구멍'으로 반드시 드러난다 — verify-clobeid-backfill.mjs 가 담당한다.
     그 밖 계좌(계열B)는 id 가 계좌별 배치순이라 구조로 못 잡는다. 이쪽만 API 대조가 필요하다.
     (계열B id 를 시각순으로 볼 수 있다고 가정한 1차 스크리닝은 오탐 41건을 냈다 — 폐기했다.
      전사 오타가 있을 수 없는 1~2월·7~8월에도 같은 역전이 나온 게 근거였다.)

   대조 데이터: docs/audit/clobe-famB-3to6.tsv  (id · 날짜 · 입금 · 출금)
     클로브 get_labeled_transactions 를 accountId 별로 조회해 만들었다. 계좌 단위로 받은
     이유는 날짜 구간으로 받으면 대부분이 이미 검증된 신한 행이라 payload 가 3배 든다.
     ⚠ 이 파일도 사람이 옮겨 적은 것이다. 다만 감사쪽 전사 오류는 "클로브에 없음" **오탐**으로
       나타나 스스로 드러난다 — 조용히 통과되지 않는다. 그래서 이 방향이 안전하다.

   실행: node scripts/verify-clobeid-exists.mjs [--from 2026-03-01] [--to 2026-06-30] */
import fs from 'node:fs';
const argv=process.argv.slice(2);
const opt=(k,d)=>{const i=argv.indexOf(k);return i<0?d:argv[i+1];};
const FROM=opt('--from','2026-03-01'), TO=opt('--to','2026-06-30');
const AUD='docs/audit/clobe-famB-3to6.tsv';
const PK='sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const SECRET=fs.readFileSync('C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret','utf8').trim();
const EP='https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
const call=async(b)=>{
  for(let i=1;i<=4;i++){
    try{
      const r=await fetch(EP,{method:'POST',headers:{'Content-Type':'application/json',apikey:PK,Authorization:`Bearer ${PK}`},body:JSON.stringify({secret:SECRET,...b})});
      const t=await r.text();
      if(!t.trimStart().startsWith('{')) throw new Error(`HTTP ${r.status} — 비JSON 응답`);
      return JSON.parse(t);
    }catch(e){ if(i===4) throw e; await new Promise(s=>setTimeout(s,800*i)); }
  }
};
const won=(n)=>Math.round(n).toLocaleString('ko-KR');
const aud=new Map();
for(const l of fs.readFileSync(AUD,'utf8').split(/\r?\n/)){
  if(!l.trim()) continue;
  const [id,date,inA,outA]=l.split('\t');
  aud.set(id.trim(),{date:date.trim(),amt:Math.round(Number(inA)-Number(outA))});
}
const rows=[];
for(const m of ['03','04','05','06']){
  const last={'03':31,'04':30,'05':31,'06':30}[m];
  for(let d=1;d<=last;d+=10){
    const f=`2026-${m}-${String(d).padStart(2,'0')}`, t=`2026-${m}-${String(Math.min(d+9,last)).padStart(2,'0')}`;
    if(t<FROM||f>TO) continue;
    const j=await call({inspect:{from:f,to:t}});
    rows.push(...(j.rows||[]));
  }
}
const famB=rows.filter(r=>r.clobe_id && !/^1295\d{5}$/.test(r.clobe_id));
const ok=[],miss=[],bad=[];
for(const r of famB){
  const a=aud.get(r.clobe_id);
  const amt=Math.round((r.in||0)-(r.out||0));
  if(!a) miss.push(r);
  else if(a.date!==r.date||a.amt!==amt) bad.push([r,a]);
  else ok.push(r);
}
console.log(`=== clobe_id 존재·일치 검사 (${FROM} ~ ${TO}) ===`);
console.log(`cf_data 계열B ${famB.length}건 · 감사파일 ${aud.size}건`);
console.log(`  ✅ 클로브에 존재하고 날짜·금액 일치 : ${ok.length}건`);
console.log(`  ✗ 날짜/금액 불일치                : ${bad.length}건`);
for(const [r,a] of bad) console.log(`     [${r.clobe_id}] cf ${r.date}/${won((r.in||0)-(r.out||0))} vs 클로브 ${a.date}/${won(a.amt)} '${r.desc}'`);
console.log(`  ✗ 감사파일에 없음(유령 후보)        : ${miss.length}건`);
for(const r of miss) console.log(`     ${r.date} ${won((r.in||0)-(r.out||0)).padStart(14)} [${r.clobe_id}] '${r.desc}'`);
/* 반대 방향 — 감사파일에 있는데 cf_data 가 안 쓰는 id. 분할·취소왕복이면 정상이다. */
const used=new Set(rows.filter(r=>r.clobe_id).map(r=>r.clobe_id));
const unused=[...aud.entries()].filter(([id])=>!used.has(id));
console.log(`\n감사파일에 있으나 cf_data 가 안 쓰는 id ${unused.length}건 (분할·취소왕복이면 정상):`);
for(const [id,v] of unused) console.log(`  ${id}  ${v.date}  ${won(v.amt).padStart(14)}`);
console.log(`\n${bad.length===0&&miss.length===0 ? '✅ 통과 — 틀린 clobe_id 없음.' : '✗ 위 항목을 조치할 것.'}`);

/* 백필 사각지대 1차 스크리닝 — API 재조회 없이 되는 부분.
   클로브 transactionId 는 두 계열로 나뉜다:
     A) 1295xxxxx  — 신한 기업자유예금(56019) 대량 재적재분. 시각순 +1 연속 수열.
     B) 그 밖(7~14천만대) — 클로브 전역 id. 계좌가 섞여 있지만 **시각순으로 증가**한다
        (1/9 74.7M → 6/30 111.2M → 8/21 142.6M, 대략 일 21만씩).
   따라서 (id 순서 ≠ tx_at 순서) 인 지점은 전사 오타 후보다.

   ⚠ 한계를 분명히 해둔다. 하루가 21만 id 폭이므로 **끝자리 몇 개를 잘못 쳐도 순서가
     안 깨진다.** 그런 오타는 대개 '존재하지 않는 id'(유령)가 되는데, 그건 클로브 API 를
     다시 조회해 id 집합을 대조해야만 잡힌다 — verify-clobeid-exists.mjs 담당.
   이 스크립트가 잡는 것: 자리수가 큰 오타(±10만 이상 ≈ 반나절 이상 어긋남).

   실행: node scripts/verify-clobeid-monotonic.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD] */
import fs from 'node:fs';
const argv=process.argv.slice(2);
const opt=(k,d)=>{const i=argv.indexOf(k);return i<0?d:argv[i+1];};
const FROM=opt('--from','2026-03-01'), TO=opt('--to','2026-06-30');
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

/* 전 기간을 읽는다 — 경계 바깥 행이 순서 판정의 기준점이 되기 때문이다. */
const all=[];
for(const y of [2025,2026,2027]) for(let mo=1;mo<=12;mo++){
  const last=new Date(Date.UTC(y,mo,0)).getUTCDate();
  for(let d=1;d<=last;d+=15){
    const j=await call({inspect:{from:`${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`,to:`${y}-${String(mo).padStart(2,'0')}-${String(Math.min(d+14,last)).padStart(2,'0')}`}});
    all.push(...(j.rows||[]));
  }
}
const withId = all.filter(r=>r.clobe_id && r.tx_at);
const famA = withId.filter(r=>/^1295\d{5}$/.test(r.clobe_id));
const famB = withId.filter(r=>!/^1295\d{5}$/.test(r.clobe_id));
console.log(`clobe_id+tx_at 있는 행 ${withId.length}건 — 계열A(신한 1295xxxxx) ${famA.length} · 계열B ${famB.length}`);
console.log(`(tx_at 없는 행 ${all.filter(r=>r.clobe_id&&!r.tx_at).length}건은 순서 판정 대상 아님)`);

const check=(name,rows)=>{
  const s=[...rows].sort((a,b)=>Number(a.clobe_id)-Number(b.clobe_id));
  const bad=[];
  for(let i=1;i<s.length;i++) if(s[i-1].tx_at > s[i].tx_at) bad.push([s[i-1],s[i]]);
  console.log(`\n[${name}] ${s.length}건 · 역전 ${bad.length}건`);
  for(const [a,b] of bad.slice(0,20))
    console.log(`  ⚠ ${a.clobe_id}@${a.tx_at} '${a.desc}' (${won((a.in||0)-(a.out||0))})`
              + `\n     > ${b.clobe_id}@${b.tx_at} '${b.desc}' (${won((b.in||0)-(b.out||0))})`);
  return bad.length;
};
let bad = check('계열A 신한', famA) + check('계열B 전역', famB);

/* 백필 구간(3~6월)만 따로 — 이 구간이 손으로 옮긴 부분이다 */
const inRange = famB.filter(r=>r.date>=FROM && r.date<=TO);
console.log(`\n── 백필 구간 ${FROM}~${TO} 계열B ${inRange.length}건의 id 범위 ──`);
const ids=inRange.map(r=>Number(r.clobe_id)).sort((a,b)=>a-b);
console.log(`  최소 ${ids[0]} · 최대 ${ids[ids.length-1]}`);
/* 날짜별 id 범위가 서로 겹치면 그것도 신호다(같은 날 안에서는 겹쳐도 정상) */
const byDate=new Map();
for(const r of inRange){ if(!byDate.has(r.date)) byDate.set(r.date,[]); byDate.get(r.date).push(Number(r.clobe_id)); }
const days=[...byDate.entries()].sort();
let overlap=0;
for(let i=1;i<days.length;i++){
  const prevMax=Math.max(...days[i-1][1]), curMin=Math.min(...days[i][1]);
  if(curMin < prevMax){ overlap++; console.log(`  ⚠ ${days[i-1][0]} 최대 ${prevMax} > ${days[i][0]} 최소 ${curMin}`); }
}
console.log(`  날짜 경계 id 역전 ${overlap}건`);
console.log(`\n${bad+overlap===0 ? '✅ 1차 스크리닝 통과 — 자리수 큰 오타는 없다.' : '✗ 위 항목을 확인할 것.'}`);
console.log(`   (끝자리 오타는 이 검사로 안 잡힌다 — verify-clobeid-exists.mjs 로 id 존재 여부를 봐야 한다)`);

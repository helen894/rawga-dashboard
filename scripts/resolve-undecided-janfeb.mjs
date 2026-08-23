/* 미결정 실거래 분류 확정 (2026-08-23).
   원칙은 그대로다 — 거래의 성격을 추론해 새 계정과목을 만들지 않고, 이미 있는 매핑 패턴만 적용한다.

   ① 1/9 ±9,682,063 '주식회사 로가'  → 자금이동/계좌간이체
      클로브 라벨이 '계좌간 입금'(129567253, 신한 140-013-243160) / '계좌간 출금'
      (74708997, 신한 140-015-053625) 이다. 자기 계좌 간 이동이고 cf_data 의 동일 사례
      (1/28·2/19 등) 전부 자금이동/계좌간이체다.

   ② 1/21 −100,000,000 '박우현'      → 자금거래/대여금 상환
      1/22 +100,000,000 '박우현'      → 자금거래/대여금 수취
      클로브 라벨: 1/21 '주주/임원/직원 차입금 상환', 1/22 '주주/임원/직원 차입금'.
      cf_data 의 정확한 선례가 있다 — 3/6 '장부식' −1,000,000·−50,000,000 (같은 클로브
      라벨 + 사람 이름 적요 + 출금) 이 자금거래/대여금 상환이고, 2/3~2/4 차입금 입금분은
      대여금 수취다. 이 데이터셋에서 지급/상환은 둘 다 출금이고 상환 = 빌린 걸 갚음이다.

   ③ 8/21 −45,100 'KT통신요금08'     → 판매관리비/통신비
      03~07월 'KT통신요금0N' 5건이 전부 같은 금액·같은 분류다. 자동분류에서 빠진 것.

   ⚠ 1/9 −5,742,860 '정자혜' 는 넣지 않는다. 클로브도 '계정 없는 출금'(미분류)이고,
     cf_data 에 다른 정자혜 행이 없고, 대표님이 지정한 원본 xlsx(로가_입출금 내역_26년
     상반기)에도 정자혜가 없다. 적용할 패턴이 존재하지 않아 확정하면 추론이 된다.

   실행: node scripts/resolve-undecided-janfeb.mjs [--apply] */
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

const PLAN = [
  { _id:'cf_mt4ehq27_qb3qe3s', mid:'계좌간이체',  big:'자금이동',   why:'클로브 계좌간 입금' },
  { _id:'cf_mt4ehq27_kn6m1sp', mid:'계좌간이체',  big:'자금이동',   why:'클로브 계좌간 출금' },
  { _id:'cf_mt4fgyhw_c3yqxag', mid:'대여금 상환', big:'자금거래',   why:'클로브 주주/임원 차입금 상환 · 3/6 장부식 선례' },
  { _id:'cf_mt4fgz0d_4ln267t', mid:'대여금 수취', big:'자금거래',   why:'클로브 주주/임원 차입금(입금) · 2/3~4 선례' },
  { _id:'cf_mt4c5nar_4t3eqfr', mid:'통신비',      big:'판매관리비', why:'KT통신요금 03~07월 5건과 동일' },
];

/* 대분류를 행에 직접 쓰지만, mid_to_big 에도 있어야 이후 새 행이 '기타'로 안 떨어진다. */
const mm = await call({ inspect:{ from:'2026-01-01', to:'2026-01-01', meta:['mid_to_big'] } });
const map = mm.meta.mid_to_big || {};
console.log('mid_to_big 확인:');
let mapMissing = false;
for (const mid of [...new Set(PLAN.map(p=>p.mid))]) {
  const v = map[mid];
  const p = PLAN.find(x=>x.mid===mid);
  const ok = v === p.big;
  if (!ok) mapMissing = true;
  console.log(`  ${ok?'✓':'✗'} ${mid} → ${v ?? '(없음)'}${ok?'':`  (기대 ${p.big})`}`);
}
if (mapMissing) console.log('  ⚠ 매핑이 없거나 다르다 — 그대로 두면 새 행이 기타로 떨어진다.');

/* 현재 상태 확인 — 이미 채워진 행은 건드리지 않는다 */
const cur = new Map();
for (const [f,t] of [['2026-01-09','2026-01-09'],['2026-01-21','2026-01-22'],['2026-08-21','2026-08-21']]) {
  const j = await call({ inspect:{ from:f, to:t } });
  for (const r of (j.rows||[])) cur.set(r._id, r);
}
const todo = [], done = [];
for (const p of PLAN) {
  const r = cur.get(p._id);
  if (!r) { console.log(`⚠ 행 없음: ${p._id}`); continue; }
  (String(r.mid_cat||'').trim() ? done : todo).push({ ...p, r });
}
console.log(`\n=== 미결정 분류 확정 ===`);
console.log(`대상 ${PLAN.length}건 · 이미 채워짐 ${done.length}건 · 채울 것 ${todo.length}건`);
for (const p of todo) console.log(`  ${p.r.date}  ${won((p.r.in||0)-(p.r.out||0)).padStart(14)}  → ${(p.big+'/'+p.mid).padEnd(20)} '${p.r.desc}'   ← ${p.why}`);
for (const p of done) console.log(`  (이미) ${p.r.date} '${p.r.desc}' = ${p.r.big_cat}/${p.r.mid_cat}`);

if (!APPLY) {
  console.log(`\n[보고만] --apply 를 주면 ${todo.length}건을 씁니다.`);
} else if (!todo.length) {
  console.log(`\n할 일 없음.`);
} else {
  const res = await call({ patch: todo.map(p=>({ _id:p._id, mid_cat:p.mid, big_cat:p.big })) });
  console.log(`\n적용 완료 — updated ${res.updated} · notFound ${(res.notFound||[]).length}`);
}

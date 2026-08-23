/* 2026-01-31 ~ 02-01 누락 5건 적재 + 2/27 스파크플러스 미결정 해소.
   근거: docs/janfeb-missing-0131-0201.md
   분류는 대표님 확정(2026-08-23): 스파크플러스 → 판매관리비/임차료, JHT → 인오가닉/JHT.

   ⚠ push 는 big_cat 을 항상 "" 로 넣는다(자동분류 추천 대상으로 남기려는 설계).
     그래서 적재 후 patch 로 big_cat 을 따로 채운다. 2단계인 게 정상이다.
   ⚠ desc 관례: 클로브 거래처명(businessEntityName) 있으면 그것, 없으면 적요.
     78158597 은 거래처명이 없어 적요 '신한주식회사　로가'(전각 공백) 그대로 — 2/19 동일건과 같다.
   실행: node scripts/janfeb-fix-0131-0201.mjs [--apply] */
import fs from 'node:fs';
const APPLY = process.argv.includes('--apply');
const PK='sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const SECRET=fs.readFileSync('C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret','utf8').trim();
const EP='https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
const call=async(b)=>{const r=await fetch(EP,{method:'POST',headers:{'Content-Type':'application/json',apikey:PK,Authorization:`Bearer ${PK}`},body:JSON.stringify({secret:SECRET,...b})});return JSON.parse(await r.text());};
const won=(n)=>Math.round(n).toLocaleString('ko-KR');

const PLAN = [
  { clobe_id:'129567392', date:'2026-01-31', in:378505,  out:0,        desc:'제이에이치티코스메틱', mid:'JHT',        big:'인오가닉',   tx_at:'2026-01-31T15:28:59' },
  { clobe_id:'129567393', date:'2026-02-01', in:0,       out:15328590, desc:'스파크플러스',        mid:'임차료',     big:'판매관리비', tx_at:'2026-02-01T19:33:24' },
  { clobe_id:'129567394', date:'2026-02-01', in:0,       out:4000000,  desc:'(주)로가제이에',      mid:'대여금 지급', big:'자금거래',   tx_at:'2026-02-01T19:35:00' },
  { clobe_id:'129567395', date:'2026-02-01', in:40000000,out:0,        desc:'주식회사로가',        mid:'계좌간이체',  big:'자금이동',   tx_at:'2026-02-01T19:43:32' },
  { clobe_id:'78158597',  date:'2026-02-01', in:0,       out:40000000, desc:'신한주식회사　로가',   mid:'계좌간이체',  big:'자금이동',   tx_at:'2026-02-01T19:43:32' },
];

/* 이미 들어가 있는지 확인 — 재실행 안전성을 눈으로 보고 싶어서 명시적으로 센다. */
const seen = new Set();
for (const [f,t] of [['2026-01-31','2026-01-31'],['2026-02-01','2026-02-01'],['2026-02-27','2026-02-27']]) {
  const j = await call({ inspect:{ from:f, to:t } });
  for (const r of (j.rows||[])) if (r.clobe_id) seen.add(r.clobe_id);
}
const todo = PLAN.filter((p) => !seen.has(p.clobe_id));
let net = 0; for (const p of todo) net += p.in - p.out;

console.log(`=== 1/31~2/1 누락 적재 ===`);
console.log(`계획 ${PLAN.length}건 · 이미 있음 ${PLAN.length-todo.length}건 · 넣을 것 ${todo.length}건 · 현금 순영향 ${won(net)}`);
for (const p of todo) console.log(`  ${p.date}  ${won(p.in-p.out).padStart(14)}  ${(p.big+'/'+p.mid).padEnd(20)} '${p.desc}'  [${p.clobe_id}]`);

/* 2/27 스파크플러스 미결정 행 찾기 */
const j227 = await call({ inspect:{ from:'2026-02-27', to:'2026-02-27' } });
const sp = (j227.rows||[]).filter((r) => /스파크/.test(r.desc||'') && !String(r.mid_cat||'').trim());
console.log(`\n2/27 스파크플러스 미결정 ${sp.length}건 → 판매관리비/임차료`);
for (const r of sp) console.log(`  ${r.date}  ${won((r.in||0)-(r.out||0)).padStart(14)}  '${r.desc}'  ${r._id}`);

/* ⚠ if / else if / else 로 반드시 묶는다. 2026-08-22 에 dry-run 이 쓰기를 해버린 사고가 있었다. */
if (!APPLY) {
  console.log(`\n[보고만] --apply 를 주면 ${todo.length}건 적재 + big_cat ${todo.length}건 + 2/27 ${sp.length}건을 씁니다.`);
} else if (!todo.length && !sp.length) {
  console.log(`\n할 일 없음 (이미 반영됨).`);
} else {
  if (todo.length) {
    const res = await call({ action:'push', rows: todo.map((p)=>({ date:p.date, in:p.in, out:p.out, desc:p.desc, clobe_id:p.clobe_id, mid:p.mid, tx_at:p.tx_at })) });
    console.log(`\npush → added ${res.added} · skipped ${res.skipped} · total ${res.total}`);
    /* push 는 big_cat 을 "" 로 넣으므로 곧바로 채운다. */
    const r2 = await call({ patch: todo.map((p)=>({ clobe_id:p.clobe_id, big_cat:p.big })) });
    console.log(`big_cat patch → updated ${r2.updated} · notFound ${(r2.notFound||[]).length}`);
  }
  if (sp.length) {
    const r3 = await call({ patch: sp.map((r)=>({ _id:r._id, mid_cat:'임차료', big_cat:'판매관리비' })) });
    console.log(`2/27 스파크플러스 patch → updated ${r3.updated}`);
  }
}

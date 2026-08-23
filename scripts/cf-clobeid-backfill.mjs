#!/usr/bin/env node
/**
 * cf-clobeid-backfill.mjs — 이미 적재된 cf_data 행에 clobe_id·tx_at 을 붙인다. 기본은 **보고만**.
 *
 * 왜 재적재가 아니라 백필인가 (2026-08-22 실측):
 *   2026-03~06 의 1,044건은 clobe_id 가 전무하다. 그 구간을 클로브로 재적재하면
 *   **667건(63.9%)·408.5억이 이중계상**된다. push 의 중복 판정이 clobe_id 없을 때
 *   (거래일+거래내용+금액+상태) 로 떨어지는데, 기존 적요는 은행 원본 문자열이고
 *   (스마트스토어정·신동섭·(유)바다향) 적재는 거래처명을 넣기 때문이다
 *   (네이버파이낸셜 주식회사·은혜수산·바다향). 같은 거래인데 문자열이 달라 안 걸린다.
 *   2026-01-28 에서 이 사고가 실제로 1건 났다(1억 이중계상).
 *   → 기존 행은 그대로 두고 clobe_id·tx_at 만 붙인다. 금액·분류·적요는 손대지 않는다.
 *
 * 매칭 (안 2 · 2026-08-22 사용자 승인):
 *   ① 날짜 + 부호금액이 **양쪽 모두 유일** → 확정        (실측 예상 87.8%)
 *   ② 같은 날 같은 금액이 여럿이면 **적요 또는 거래처명이 유일하게 맞는 짝만** 확정  (9.3%)
 *      cf 의 desc 를 클로브의 transactionDescription·businessEntityName 양쪽과 비교한다
 *      (기존 적요는 은행 원본 문자열일 수도, 거래처명일 수도 있다).
 *   ③ 그래도 안 갈리면 **건너뛴다**. 임의로 붙이지 않는다 — 금액이 같아 잔액·집계는 안 틀리지만
 *      clobe_id 로 클로브를 역조회할 때 엉뚱한 거래를 가리키게 된다.
 *
 * 안전장치:
 *   · Edge 의 set_clobe_id 는 **비어 있을 때만** 채운다(멱등, 재실행 안전).
 *   · 같은 clobe_id 를 두 행에 붙이려 하면 서버가 거부한다 — 그러면 push 의 중복 판정이
 *     깨져 이후 적재가 조용히 어긋난다.
 *   · 이 스크립트도 한 clobe_id 를 두 번 쓰지 않도록 자체 검사한다.
 *
 * 쓰는 법 (클로브 조회는 Claude 세션에서만 되므로 2단계):
 *   node scripts/cf-clobeid-backfill.mjs --clobe <파일...> --from YYYY-MM-DD --to YYYY-MM-DD [--apply]
 *   <파일>은 get_labeled_transactions 응답(또는 clobe-tsv-split 이 만든 하루 단위 파일).
 *
 * ⚠ 외화계좌(56034·145016)는 금액이 그 계좌 통화 단위(USD)라 원화 cf_data 와 금액으로
 *   맞출 수 없다. 제외한다 — 3~6월 외화 행은 어차피 fx_usd 태깅이 없어 별개 과제다.
 */

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const listOpt = (k) => {
  const i = argv.indexOf(k);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]);
  return out;
};
const FILES = listOpt('--clobe'), FROM = opt('--from'), TO = opt('--to');
const APPLY = argv.includes('--apply');
const SHOW = Math.max(1, Number(opt('--show')) || 20);
if (!FILES.length || !FROM || !TO) {
  console.error('사용법: node scripts/cf-clobeid-backfill.mjs --clobe <파일...> --from YYYY-MM-DD --to YYYY-MM-DD [--apply] [--show N]');
  process.exit(1);
}

const PK = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const SECRET = readFileSync('C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret', 'utf8').trim();
const EP = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
const FX_ACCOUNTS = new Set(['56034', '145016']);
const won = (n) => Math.round(Number(n) || 0).toLocaleString('ko-KR');
const eok = (n) => (Number(n) / 1e8).toFixed(1);
const addDays = (d, n) => {
  const [y, m, dd] = String(d).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, dd + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
};
const post = async (body) => {
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(EP, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: PK, Authorization: `Bearer ${PK}` }, body: JSON.stringify({ secret: SECRET, ...body }) });
      const t = await r.text();
      if (!t.trim().startsWith('{')) throw new Error(`HTTP ${r.status}`);
      return JSON.parse(t);
    } catch (e) { if (i === 3) throw e; await new Promise((s) => setTimeout(s, 700 * i)); }
  }
};

/* ── 클로브 읽기 ─────────────────────────────────────────────────── */
const pages = FILES.flatMap((f) => { const j = JSON.parse(readFileSync(f, 'utf8')); return Array.isArray(j) ? j : [j]; });
const uniq = new Map();
for (const t of pages.flatMap((p) => (Array.isArray(p?.content) ? p.content : []))) uniq.set(String(t.transactionId), t);
let fxSkip = 0;
const cl = [];
for (const t of uniq.values()) {
  const d = String(t.transactionAt || '').slice(0, 10);
  if (!d || d < FROM || d > TO) continue;
  if (FX_ACCOUNTS.has(String(t.accountId))) { fxSkip++; continue; }
  const amt = Math.round((Number(t.inAmount) || 0) - (Number(t.outAmount) || 0));
  if (!amt) continue;
  cl.push({ id: String(t.transactionId), date: d, amt, at: String(t.transactionAt || ''),
            desc: String(t.transactionDescription || '').trim(), be: String(t.businessEntityName || '').trim() });
}

/* ── cf_data 읽기 ────────────────────────────────────────────────── */
const seen = new Map();
const grab = async (f, t, depth = 0) => {
  const r = await post({ inspect: { from: f, to: t } });
  if (Number(r.matched) > 500 && depth < 8) {
    const span = (Date.parse(t) - Date.parse(f)) / 86400000;
    if (span >= 1) { const mid = addDays(f, Math.floor(span / 2)); await grab(f, mid, depth + 1); await grab(addDays(mid, 1), t, depth + 1); return; }
  }
  for (const x of (r.rows || [])) seen.set(x._id, x);
};
await grab(FROM, TO);
const cf = [...seen.values()]
  .filter((r) => r.status === '실제 입금' || r.status === '실제 지출')
  .map((r) => ({ ...r, amt: Math.round((Number(r.in) || 0) - (Number(r.out) || 0)) }))
  .filter((r) => r.amt !== 0);

console.log(`=== clobe_id·tx_at 백필 (${FROM} ~ ${TO}) ===`);
console.log(`클로브 ${cl.length}건 (외화 ${fxSkip}건 제외) · cf_data 실거래 ${cf.length}건`);
const already = cf.filter((r) => String(r.clobe_id || '').trim()).length;
console.log(`이미 clobe_id 있는 행 ${already}건 → 대상 ${cf.length - already}건\n`);

/* ── 매칭 ────────────────────────────────────────────────────────── */
const key = (r) => `${r.date}|${r.amt}`;
const gC = new Map(), gX = new Map();
for (const r of cf) { const k = key(r); if (!gC.has(k)) gC.set(k, []); gC.get(k).push(r); }
for (const r of cl) { const k = key(r); if (!gX.has(k)) gX.set(k, []); gX.get(k).push(r); }
const norm = (s) => String(s || '').trim();
const plan = [], ambig = [], noClobe = [], usedId = new Set();
for (const [k, cs] of gC) {
  const todo = cs.filter((r) => !String(r.clobe_id || '').trim());
  if (!todo.length) continue;
  const xs = (gX.get(k) || []).filter((x) => !usedId.has(x.id));
  if (!xs.length) { noClobe.push(...todo); continue; }
  if (todo.length === 1 && xs.length === 1) {
    plan.push({ r: todo[0], x: xs[0], via: '날짜+금액 유일' }); usedId.add(xs[0].id); continue;
  }
  /* ② 적요·거래처명으로 2차 판별 — 유일하게 맞는 짝만 */
  const left = todo.slice(), pool = xs.slice();
  for (const r of todo) {
    const d = norm(r.desc);
    const hit = pool.filter((x) => norm(x.desc) === d || norm(x.be) === d);
    if (hit.length === 1) {
      plan.push({ r, x: hit[0], via: '적요/거래처' }); usedId.add(hit[0].id);
      pool.splice(pool.indexOf(hit[0]), 1); left.splice(left.indexOf(r), 1);
    }
  }
  ambig.push(...left);
}
const byVia = {}; for (const p of plan) byVia[p.via] = (byVia[p.via] || 0) + 1;
const tot = cf.length - already;
const pc = (v) => (tot ? (v / tot * 100).toFixed(1).padStart(5) + '%' : '    -');
console.log('=== 매칭 결과 ===');
for (const [k, v] of Object.entries(byVia)) console.log(`  ${k.padEnd(14)} ${String(v).padStart(5)}건 ${pc(v)}`);
console.log(`  ─ 확정 소계      ${String(plan.length).padStart(5)}건 ${pc(plan.length)}`);
console.log(`  모호(건너뜀)     ${String(ambig.length).padStart(5)}건 ${pc(ambig.length)}`);
console.log(`  클로브에 없음     ${String(noClobe.length).padStart(5)}건 ${pc(noClobe.length)}`);

if (ambig.length) {
  console.log(`\n=== 모호 ${ambig.length}건 (같은 날 같은 금액, 적요로도 안 갈림) ===`);
  for (const r of ambig.slice(0, SHOW)) console.log(`  ${r.date} ${won(r.amt).padStart(15)}  '${String(r.desc || '').slice(0, 22)}'`);
  if (ambig.length > SHOW) console.log(`  … 외 ${ambig.length - SHOW}건`);
}
if (noClobe.length) {
  console.log(`\n=== 클로브에 없음 ${noClobe.length}건 (수기 입력분이면 정상) ===`);
  for (const r of noClobe.slice(0, SHOW)) console.log(`  ${r.date} ${won(r.amt).padStart(15)}  ${(r.big_cat || '-')}/${(r.mid_cat || '-')}  '${String(r.desc || '').slice(0, 22)}'`);
  if (noClobe.length > SHOW) console.log(`  … 외 ${noClobe.length - SHOW}건`);
}
/* 클로브에 있는데 cf_data 가 못 받은 것 = 누락 후보 */
const leftover = cl.filter((x) => !usedId.has(x.id));
const cfIds = new Set(cf.map((r) => String(r.clobe_id || '').trim()).filter(Boolean));
const missing = leftover.filter((x) => !cfIds.has(x.id));
if (missing.length) {
  console.log(`\n=== 클로브에만 있는 ${missing.length}건 = 누락 후보 (합 ${won(missing.reduce((s, x) => s + x.amt, 0))}) ===`);
  for (const x of missing.slice(0, SHOW)) console.log(`  ${x.date} ${won(x.amt).padStart(15)}  '${x.desc.slice(0, 20)}'/'${x.be.slice(0, 16)}'  [${x.id}]`);
  if (missing.length > SHOW) console.log(`  … 외 ${missing.length - SHOW}건`);
}

/* ── 적용 ────────────────────────────────────────────────────────────
   ⚠⚠ if / else if / else 로 **반드시 묶는다.** 2026-08-22 에 여기서 사고가 났다:
   Windows 의 종료코드 127 문제를 피하려고 process.exit(0) 을 지웠더니 조기 종료가 없어져
   **--apply 없이도 쓰기가 실행됐다**(3/4~3/6 40건이 dry-run 인데 반영됨). 결과는 계획과
   같아 피해는 없었지만, "보고만" 이 쓰는 것 자체가 위험하다.
   process.exit 은 쓰지 않는다(fetch keep-alive 소켓 때문에 종료코드 127) — 분기로 막는다. */
if (!APPLY) {
  console.log(`\n[보고만] --apply 를 주면 ${plan.length}건에 clobe_id·tx_at 을 씁니다.`);
} else if (!plan.length) {
  console.log('\n붙일 것이 없습니다.');
} else {
  const CHUNK = 200;
  let done = 0, rejected = 0;
  for (let i = 0; i < plan.length; i += CHUNK) {
    const slice = plan.slice(i, i + CHUNK).map(({ r, x }) => ({ _id: r._id, set_clobe_id: x.id, tx_at: x.at }));
    const res = await post({ patch: slice });
    if (!res.ok) { console.error('patch 실패:', res.error); process.exitCode = 1; break; }
    done += Number(res.updated) || 0;
    if (res.notFound?.length) {
      rejected += res.notFound.length;
      console.error(`  ⚠ 거부 ${res.notFound.length}건: ${res.notFound.slice(0, 5).join(' / ')}`);
    }
  }
  console.log(`\n적용 완료 — ${done}건 백필${rejected ? ` · 거부 ${rejected}건` : ''}`);
}

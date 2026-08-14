#!/usr/bin/env node
/**
 * clobe-cf-txat-backfill — 이미 적재된 cf_data 행에 **거래 시각(tx_at)** 을 채운다
 *
 * 사용:
 *   node scripts/clobe-cf-txat-backfill.mjs <매핑파일.json> [--dry-run]
 *
 * 매핑파일은 { "<clobe_id>": "<transactionAt>" } 형태의 단일 객체다.
 *   { "141247871": "2026-08-14T19:51:14", ... }
 * 클로브 `get_labeled_transactions` 의 transactionId / transactionAt 를 그대로 뽑은 것.
 * (커넥터는 Claude 세션에서만 부를 수 있어 조회는 사람/에이전트가 하고, 적용만 여기서 한다.)
 *
 * 왜 필요한가 (2026-08-15):
 *   적재 스크립트가 `transactionAt` 을 `.slice(0,10)` 으로 날짜만 남기고 버려서, 같은 날짜
 *   안의 순서를 알 방법이 없었다. 대시보드 잔액 열이 이 시각으로 정렬하므로, 과거분도
 *   채워야 그날 중간 잔액이 실제 은행 처리 순서를 따른다.
 *   ⚠ clobe_id 로는 대신할 수 없다 — 계좌별 스크래핑 배치 순서라 계좌가 다르면 시간순과 무관.
 *
 * 안전장치:
 *   · Edge patch 는 tx_at 이 **비어 있을 때만** 채운다(멱등). 재실행해도 기존 값을 안 덮는다.
 *   · 먼저 inspect 로 대상 행을 확인해 매핑에 있지만 cf_data 에 없는 id 를 걸러낸다.
 *   · 날짜가 어긋나는 건(같은 clobe_id 인데 tx_at 의 날짜 ≠ 행의 date) 은 **적용하지 않고** 보고한다.
 *     — 매핑을 잘못 만들었을 때 조용히 틀린 시각이 박히는 걸 막는다.
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const mapPath = argv.find(a => !a.startsWith('--'));
if (!mapPath) {
  console.error('사용법: node scripts/clobe-cf-txat-backfill.mjs <매핑파일.json> [--dry-run]');
  process.exit(1);
}

const EDGE = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
const SECRET_FILE = 'C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret';
/* Edge 게이트웨이가 verify_jwt=true 라 Authorization 헤더 필요(없으면 401).
   index.html 에 이미 박혀 배포되는 공개 publishable 키라 비밀이 아니다. */
const SUPA_PUBLISHABLE_KEY = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const secret = readFileSync(SECRET_FILE, 'utf8').trim();

async function call(body) {
  const res = await fetch(EDGE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPA_PUBLISHABLE_KEY,
      Authorization: `Bearer ${SUPA_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify({ secret, ...body }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.ok === false) {
    console.error(`\n실패 (HTTP ${res.status}):`, JSON.stringify(out).slice(0, 400));
    process.exit(3);
  }
  return out;
}

/* ── 1) 매핑 읽기 ─────────────────────────────────────────── */
let map;
try {
  map = JSON.parse(readFileSync(mapPath, 'utf8'));
} catch (e) {
  console.error(`매핑 파일을 읽지 못했습니다: ${e.message}`);
  process.exit(1);
}
if (!map || typeof map !== 'object' || Array.isArray(map)) {
  console.error('매핑 파일은 { "clobe_id": "transactionAt" } 형태의 객체여야 합니다.');
  process.exit(1);
}
const entries = Object.entries(map).filter(([k, v]) => String(k).trim() && String(v).trim());
console.log(`매핑 ${entries.length}건 읽음`);

/* ── 2) cf_data 현재 상태 조회 (월 단위 — Edge 가 500행에서 자른다) ── */
const dates = entries.map(([, v]) => String(v).slice(0, 10)).filter(Boolean).sort();
if (!dates.length) { console.error('매핑에 유효한 날짜가 없습니다.'); process.exit(1); }
const firstYm = dates[0].slice(0, 7), lastYm = dates[dates.length - 1].slice(0, 7);
console.log(`대상 기간 ${dates[0]} ~ ${dates[dates.length - 1]}`);

const months = [];
for (let y = +firstYm.slice(0, 4), m = +firstYm.slice(5, 7); ; m++) {
  if (m > 12) { m = 1; y++; }
  const ym = `${y}-${String(m).padStart(2, '0')}`;
  months.push(ym);
  if (ym === lastYm) break;
  if (months.length > 60) break;   // 폭주 방지
}

const cur = new Map();   // clobe_id → { date, tx_at, desc }
for (const ym of months) {
  const last = new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate();
  const out = await call({ inspect: { from: `${ym}-01`, to: `${ym}-${last}` } });
  if ((out.rows || []).length >= 500 && out.matched > out.rows.length) {
    console.error(`⚠ ${ym} 이 500건에서 잘렸습니다 — 이 달은 결과가 불완전합니다.`);
    process.exit(3);
  }
  for (const r of out.rows || []) {
    const cid = String(r.clobe_id || '').trim();
    if (cid) cur.set(cid, { date: String(r.date || ''), tx_at: String(r.tx_at || ''), desc: String(r.desc || '') });
  }
}
console.log(`cf_data 조회 완료 — clobe_id 보유 행 ${cur.size}건`);

/* ── 3) 대상 선별 ─────────────────────────────────────────── */
const todo = [], missing = [], already = [], mismatched = [];
for (const [cid, txAt] of entries) {
  const row = cur.get(String(cid));
  if (!row)                { missing.push(cid); continue; }
  if (row.tx_at)           { already.push(cid); continue; }
  // 날짜 정합성 — 매핑이 잘못됐을 때 틀린 시각이 조용히 박히는 걸 막는다
  if (String(txAt).slice(0, 10) !== row.date) {
    mismatched.push({ cid, rowDate: row.date, txAt: String(txAt), desc: row.desc });
    continue;
  }
  todo.push({ clobe_id: String(cid), tx_at: String(txAt) });
}

console.log(`\n채울 대상        ${todo.length}건`);
console.log(`이미 시각 있음    ${already.length}건 (건너뜀)`);
console.log(`cf_data 에 없음   ${missing.length}건 (건너뜀)`);
if (mismatched.length) {
  console.error(`\n⚠ 날짜 불일치 ${mismatched.length}건 — 적용하지 않았습니다. 매핑을 확인하세요:`);
  for (const m of mismatched.slice(0, 10)) {
    console.error(`   clobe_id=${m.cid}  cf_data 날짜 ${m.rowDate}  vs  매핑 ${m.txAt}  (${m.desc})`);
  }
  if (mismatched.length > 10) console.error(`   … 외 ${mismatched.length - 10}건`);
}

if (!todo.length) { console.log('\n적용할 것이 없습니다.'); process.exitCode = 0; }
else if (DRY) {
  console.log('\n[미리보기] 저장하지 않았습니다. 맞으면 --dry-run 을 빼고 다시 실행하세요.');
  for (const t of todo.slice(0, 5)) console.log(`   ${t.clobe_id} → ${t.tx_at}`);
  if (todo.length > 5) console.log(`   … 외 ${todo.length - 5}건`);
  process.exitCode = 0;
} else {
  /* ── 4) 적용 — 한 번에 다 보내면 요청이 커지므로 나눠 보낸다.
   *    Edge 가 매 호출마다 cf_data 전체를 읽고 조건부로 쓰므로 배치가 작을수록 충돌에 강하다. */
  const BATCH = 100;
  let updated = 0;
  const notFound = [];
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const out = await call({ patch: chunk });
    updated += out.updated || 0;
    if (out.notFound?.length) notFound.push(...out.notFound);
    console.log(`   배치 ${Math.floor(i / BATCH) + 1}: ${out.updated || 0}건 적용 (누계 ${updated})`);
  }
  console.log(`\n적용 완료 — 시각 채움 ${updated}건`);
  if (notFound.length) console.error(`⚠ 적용 못한 선택자 ${notFound.length}건: ${notFound.slice(0, 10).join(', ')}`);
  process.exitCode = 0;
}

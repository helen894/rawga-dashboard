#!/usr/bin/env node
/**
 * clobe-card-patch — 이미 적재된 법인카드 행의 계정과목(memo) 교정
 *
 * 사용:
 *   node scripts/clobe-card-patch.mjs <approval_id> <계정과목> [<approval_id> <계정과목> ...] [--dry-run]
 *
 * 예:
 *   node scripts/clobe-card-patch.mjs 29427911 지급수수료
 *
 * 왜 따로 있나:
 *   clobe-card-ingest 는 approval_id 중복을 차단하므로 재실행으로는 기존 행을 못 고친다.
 *   클로브 memo 가 '프리딕티브AGI: 2027 CES 참가비' 처럼 ':' 앞이 계정과목이 아닌 경우,
 *   클로브에서 memo 를 고쳐도 이미 적재된 행은 그대로라 이 경로가 필요하다.
 *
 * 계정과목은 ':' 앞만 쓰인다(대시보드 extractCCAccount 와 동일) — 전체 memo 를 넣어도 된다.
 * 없는 approval_id 는 notFound 로 돌아오고 행을 새로 만들지 않는다.
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const pos = argv.filter(a => !a.startsWith('--'));
if (!pos.length || pos.length % 2 !== 0) {
  console.error('사용법: node scripts/clobe-card-patch.mjs <approval_id> <계정과목> [...] [--dry-run]');
  process.exit(1);
}

const EDGE = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/card-ingest';
const SECRET_FILE = 'C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret';
/* Edge 게이트웨이가 verify_jwt=true 라 Authorization 헤더 필요(없으면 401).
   index.html 에 이미 박혀 배포되는 공개 publishable 키라 비밀이 아니다. */
const SUPA_PUBLISHABLE_KEY = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';

const patch = [];
for (let i = 0; i < pos.length; i += 2) patch.push({ approval_id: pos[i], memo: pos[i + 1] });

console.log('=== 법인카드 계정과목 교정 ===');
for (const p of patch) console.log(`  ${p.approval_id} → ${p.memo}`);
if (DRY) { console.log(`\n[dry-run] 호출하지 않았습니다. 대상 ${patch.length}건.`); process.exit(0); }

const secret = readFileSync(SECRET_FILE, 'utf8').trim();
const res = await fetch(EDGE, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    apikey: SUPA_PUBLISHABLE_KEY,
    Authorization: `Bearer ${SUPA_PUBLISHABLE_KEY}`,
  },
  body: JSON.stringify({ secret, patch }),
});
const out = await res.json().catch(() => ({}));
if (!res.ok || out.ok === false) {
  console.error(`\n교정 실패 (HTTP ${res.status}):`, JSON.stringify(out).slice(0, 300));
  process.exit(3);
}

console.log(`\n교정 완료 — 변경 ${out.updated}건 / 카드내역 총 ${out.total}건`);
for (const c of out.changes || []) {
  console.log(`  ${c.use_date}  ${c.merchant}  「${c.from}」 → 「${c.to}」`);
}
if (out.notFound?.length) console.error(`\n⚠ 없는 approval_id: ${out.notFound.join(', ')}`);
if (!out.updated && !out.notFound?.length) console.log('  (이미 그 값이라 변경 없음)');

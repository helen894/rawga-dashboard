#!/usr/bin/env node
/**
 * clobe-card-patch-batch — 법인카드 계정과목(memo) 일괄 교정
 *
 * 사용:
 *   node scripts/clobe-card-patch-batch.mjs <patch.json> [--dry-run]
 *
 * patch.json 형식 — [{ "sel": "<approval_id 또는 _id>", "want": "<계정과목>" }, ...]
 *
 * clobe-card-patch.mjs 와 같은 엔드포인트·같은 의미다. 다르게 있는 이유는 하나뿐:
 * 100건 넘는 교정을 CLI 인자로 늘어놓을 수 없어서다(2026-08-03 지급수수료 재분류 113건).
 * 몇 건짜리는 clobe-card-patch.mjs 를 쓰는 게 낫다 — 인자로 바로 보인다.
 *
 * 되돌리기: 교정할 때 만든 rollback 파일(같은 형식, want 가 변경 전 값)을 그대로 넣으면 된다.
 * rollback 자료는 가맹점·금액·사용자 실명이 들어가 이 저장소(공개)에 두지 않는다 —
 * 시크릿과 같은 %LOCALAPPDATA%\rawga\ 아래에 보관하고 절대경로로 지정한다.
 *   node scripts/clobe-card-patch-batch.mjs "C:/Users/RAWGA/AppData/Local/rawga/card-reclass-2026-08-03/5-fee-rollback.json"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const file = argv.find(a => !a.startsWith('--'));
if (!file) {
  console.error('사용법: node scripts/clobe-card-patch-batch.mjs <patch.json> [--dry-run]');
  process.exit(1);
}

const EDGE = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/card-ingest';
const SECRET_FILE = 'C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret';
/* Edge 게이트웨이가 verify_jwt=true 라 Authorization 헤더 필요(없으면 401).
   index.html 에 이미 박혀 배포되는 공개 publishable 키라 비밀이 아니다. */
const SUPA_PUBLISHABLE_KEY = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';

const items = JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8'));
if (!Array.isArray(items) || !items.length) { console.error('patch 파일이 비었습니다.'); process.exit(1); }

/* 선택자 판별은 clobe-card-patch.mjs 와 동일 — 숫자면 approval_id, 아니면 _id */
const selectorOf = tok => {
  const s = String(tok);
  if (s.startsWith('a:')) return { approval_id: s.slice(2) };
  if (s.startsWith('i:')) return { _id: s.slice(2) };
  return /^\d+$/.test(s) ? { approval_id: s } : { _id: s };
};
const patch = items.map(i => ({ ...selectorOf(i.sel), memo: i.want }));

const by = {};
for (const i of items) by[i.want] = (by[i.want] || 0) + 1;
console.log(`=== 법인카드 계정과목 일괄 교정 ${patch.length}건 ===`);
for (const [k, v] of Object.entries(by)) console.log(`  → ${k}: ${v}건`);
if (DRY) { console.log(`\n[dry-run] 호출하지 않았습니다.`); process.exit(0); }

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
if (out.notFound?.length) console.error(`⚠ 없는 선택자 ${out.notFound.length}건: ${out.notFound.slice(0, 5).join(', ')}`);
if (!out.updated && !out.notFound?.length) console.log('  (이미 그 값이라 변경 없음)');

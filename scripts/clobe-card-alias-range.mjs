#!/usr/bin/env node
/**
 * clobe-card-alias-range — 카드 1장의 **특정 기간만** 다른 별칭(집계표 열)으로 지정
 *
 * 사용:
 *   node scripts/clobe-card-alias-range.mjs <card_no> <from> <to> <별칭> [--apply]
 *
 * 예 (2026-06 비씨카드(김현민) 사용분을 SO 로 처리하던 예외 복원):
 *   node scripts/clobe-card-alias-range.mjs "41400318****4957" 2026-06-01 2026-06-30 SO
 *   node scripts/clobe-card-alias-range.mjs "41400318****4957" 2026-06-01 2026-06-30 SO --apply
 *
 * 왜 필요한가:
 *   card-alias-map.json 은 '카드 1장 = 별칭 1개' 라 기간별 예외를 못 담는다.
 *   실제로는 같은 카드를 어느 달만 다른 팀 비용으로 처리하는 경우가 있다.
 *
 * 기본은 **미리보기**다. 대상 건수와 기존 별칭 분포를 먼저 보여주고, --apply 를 붙여야 저장한다.
 * (되돌릴 수 없는 일괄 변경이므로 확인 단계를 강제한다)
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const [card_no, from, to, card_alias] = argv.filter(a => !a.startsWith('--'));
if (!card_no || !from || !to || !card_alias) {
  console.error('사용법: node scripts/clobe-card-alias-range.mjs <card_no> <from> <to> <별칭> [--apply]');
  process.exit(1);
}

const EDGE = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/card-ingest';
const SECRET_FILE = 'C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret';
/* Edge 게이트웨이가 verify_jwt=true 라 Authorization 헤더 필요(없으면 401).
   index.html 에 이미 박혀 배포되는 공개 publishable 키라 비밀이 아니다. */
const SUPA_PUBLISHABLE_KEY = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';

console.log('=== 기간 지정 별칭 ===');
console.log(`  ${card_no}  ${from} ~ ${to}  →  「${card_alias}」  ${APPLY ? '(저장)' : '(미리보기)'}`);

const secret = readFileSync(SECRET_FILE, 'utf8').trim();
const res = await fetch(EDGE, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    apikey: SUPA_PUBLISHABLE_KEY,
    Authorization: `Bearer ${SUPA_PUBLISHABLE_KEY}`,
  },
  body: JSON.stringify({ secret, aliasRange: [{ card_no, from, to, card_alias }], dryRun: !APPLY }),
});
const out = await res.json().catch(() => ({}));
if (!res.ok || out.ok === false) {
  console.error(`\n실패 (HTTP ${res.status}):`, JSON.stringify(out).slice(0, 300));
  process.exit(3);
}

const r = (out.results || [])[0] || {};
console.log(`\n대상 ${r.matched || 0}건 · 바뀔 행 ${r.changed || 0}건 / 카드내역 총 ${out.total}건`);
for (const [old, n] of Object.entries(r.fromAlias || {})) console.log(`     기존 「${old}」  ${n}건`);
if (out.dryRun) console.log('\n[미리보기] 저장하지 않았습니다. 맞으면 --apply 를 붙여 다시 실행하세요.');
else console.log(`\n저장 완료 — ${out.changed}건 변경.`);

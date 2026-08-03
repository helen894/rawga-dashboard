#!/usr/bin/env node
/**
 * clobe-card-patch — 이미 적재된 법인카드 행의 계정과목(memo) 교정
 *
 * 사용:
 *   node scripts/clobe-card-patch.mjs <선택자> <계정과목> [<선택자> <계정과목> ...] [--dry-run]
 *
 * 선택자는 approval_id(숫자) 또는 _id. 수기 업로드분은 approval_id 가 없어 _id 로만 잡힌다
 * (_id 는 Edge 의 inspect 모드로 확인). 숫자면 approval_id, 아니면 _id 로 자동 판별하고,
 * 'a:'/'i:' 접두사로 강제 지정할 수도 있다.
 *
 * 예:
 *   node scripts/clobe-card-patch.mjs 29427911 지급수수료
 *   node scripts/clobe-card-patch.mjs corp_card_1784374446934_332_sn4j8xwi41 차량유지비
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
  console.error('사용법: node scripts/clobe-card-patch.mjs <선택자(approval_id|_id)> <계정과목> [...] [--dry-run]');
  process.exit(1);
}

const EDGE = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/card-ingest';
const SECRET_FILE = 'C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret';
/* Edge 게이트웨이가 verify_jwt=true 라 Authorization 헤더 필요(없으면 401).
   index.html 에 이미 박혀 배포되는 공개 publishable 키라 비밀이 아니다. */
const SUPA_PUBLISHABLE_KEY = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';

/* 선택자 판별: 'a:'/'i:' 접두사 우선, 없으면 숫자=approval_id / 그 외=_id */
const selectorOf = tok => {
  if (tok.startsWith('a:')) return { approval_id: tok.slice(2) };
  if (tok.startsWith('i:')) return { _id: tok.slice(2) };
  return /^\d+$/.test(tok) ? { approval_id: tok } : { _id: tok };
};

const patch = [];
for (let i = 0; i < pos.length; i += 2) patch.push({ ...selectorOf(pos[i]), memo: pos[i + 1] });

console.log('=== 법인카드 계정과목 교정 ===');
for (const p of patch) console.log(`  ${p.approval_id ?? p._id} → ${p.memo}`);
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
// Edge 는 바뀐 필드별로 {from,to} 를 중첩해서 준다 — c.memo.from 이지 c.from 이 아니다.
for (const c of out.changes || []) {
  const d = ['memo', 'billing_amount']
    .filter(f => c[f])
    .map(f => `${f} 「${c[f].from}」 → 「${c[f].to}」`)
    .join(' · ');
  console.log(`  ${c.use_date}  ${c.merchant}  ${d}`);
}
if (out.notFound?.length) console.error(`\n⚠ 없는 선택자: ${out.notFound.join(', ')}`);   // a:=approval_id, i:=_id
if (!out.updated && !out.notFound?.length) console.log('  (이미 그 값이라 변경 없음)');

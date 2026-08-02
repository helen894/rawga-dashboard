#!/usr/bin/env node
/**
 * clobe-card-alias-backfill — 이미 적재된 행의 **빈 별칭**을 매핑 파일 값으로 채운다
 *
 * 사용:
 *   node scripts/clobe-card-alias-backfill.mjs [--dry-run]
 *
 * 왜 필요한가:
 *   card-alias-map.json 을 고쳐도 그건 앞으로 적재될 건에만 적용된다.
 *   이미 들어간 행은 별칭이 빈 채로 남고, 별칭이 비면 집계표(카드×계정과목)에
 *   배치할 열이 없어 통째로 빠진다 — 사용내역 목록엔 보이는데 표에는 없는 상태.
 *   매핑을 갱신했으면 이걸 한 번 돌려서 과거분까지 맞춘다.
 *
 * 안전장치:
 *   - **빈 별칭만** 채운다. 이미 별칭이 있는 행은 손대지 않는다(수기 수정분 보호).
 *   - 매핑값이 빈 문자열인 카드는 보내지 않는다(아직 정하지 않은 카드).
 *   - 기존 카드내역이 비어 있으면 서버가 409 로 중단한다.
 *   - 두 번 돌려도 안전하다(두 번째는 채울 게 없어 0건).
 */
import { readFileSync } from 'node:fs';

const DRY = process.argv.includes('--dry-run');

const EDGE = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/card-ingest';
const SECRET_FILE = 'C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret';
/* Edge 게이트웨이가 verify_jwt=true 라 Authorization 헤더 필요(없으면 401).
   index.html 에 이미 박혀 배포되는 공개 publishable 키라 비밀이 아니다. */
const SUPA_PUBLISHABLE_KEY = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const MAP_FILE = new URL('./card-alias-map.json', import.meta.url);

const map = JSON.parse(readFileSync(MAP_FILE, 'utf8')).map || {};
const aliasFill = Object.fromEntries(Object.entries(map).filter(([, v]) => String(v || '').trim()));
const blank = Object.entries(map).filter(([, v]) => !String(v || '').trim()).map(([k]) => k);

console.log('=== 법인카드 빈 별칭 채우기 ===');
console.log(`매핑 ${Object.keys(map).length}장 중 별칭 있는 ${Object.keys(aliasFill).length}장을 대상으로 보냅니다.`);
if (blank.length) console.log(`  (별칭 미정 ${blank.length}장은 제외: ${blank.join(', ')})`);
if (!Object.keys(aliasFill).length) { console.error('보낼 매핑이 없습니다.'); process.exit(1); }
if (DRY) { console.log('\n[dry-run] 호출하지 않았습니다.'); process.exit(0); }

const secret = readFileSync(SECRET_FILE, 'utf8').trim();
const res = await fetch(EDGE, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    apikey: SUPA_PUBLISHABLE_KEY,
    Authorization: `Bearer ${SUPA_PUBLISHABLE_KEY}`,
  },
  body: JSON.stringify({ secret, aliasFill }),
});
const out = await res.json().catch(() => ({}));
if (!res.ok || out.ok === false) {
  console.error(`\n실패 (HTTP ${res.status}):`, JSON.stringify(out).slice(0, 300));
  process.exit(3);
}

const won = n => Math.round(n).toLocaleString('ko-KR');

console.log(`\n완료 — 빈 별칭 ${out.filled}건 채움 / 카드내역 총 ${out.total}건`);
for (const [al, n] of Object.entries(out.byAlias || {})) console.log(`     ${al}  ${n}건`);
if (!out.filled) console.log('  (채울 빈 별칭이 없었습니다)');

/* 매핑 키에 안 걸린 카드번호 — 수기 엑셀분은 카드번호 표기가 API와 달라
   소급이 조용히 빗나갈 수 있다. blank>0 이면 그만큼 집계표에서 빠져 있다는 뜻. */
const um = out.unmatched || [];
if (um.length) {
  const blankTot = um.reduce((s, u) => s + u.blank, 0);
  console.log(`\n매핑에 없는 카드번호 ${um.length}종 (${um.reduce((s, u) => s + u.n, 0)}건)` +
    (blankTot ? ` — 이 중 별칭 빈 행 ${blankTot}건은 집계표에서 빠집니다` : ''));
  console.log('  카드번호'.padEnd(24) + '건수  별칭빈'.padStart(10) + '금액'.padStart(14) + '  기간');
  for (const u of um) {
    console.log('  ' + u.card_no.padEnd(22) + String(u.n).padStart(4) + String(u.blank).padStart(7) +
      won(u.sum).padStart(15) + `  ${u.from} ~ ${u.to}`);
  }
}

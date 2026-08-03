#!/usr/bin/env node
/**
 * clobe-cf-patch — 이미 적재된 입출금(cf_data) 행의 중분류/대분류 교정
 *
 * 사용:
 *   조회: node scripts/clobe-cf-patch.mjs --inspect [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *                                          [--desc 적요조각] [--clobe-id 123,456] [--unclassified]
 *   수정: node scripts/clobe-cf-patch.mjs <선택자> <중분류> [<선택자> <중분류> ...]
 *                                          [--big-cat <대분류>] [--dry-run]
 *
 * 선택자는 clobe_id(=클로브 transactionId, 숫자) 또는 _id(cf_ 로 시작). 숫자면 clobe_id,
 * 아니면 _id 로 자동 판별하고 'c:'/'i:' 접두사로 강제 지정할 수도 있다. _id 는 --inspect 로 얻는다.
 *
 * 왜 따로 있나:
 *   clobe-cf-ingest 는 clobe_id 중복을 skip 하므로 재실행으로는 기존 행의 분류를 못 고친다.
 *   (적요만 desc_src 비교로 갱신된다.) 수기 분류를 스크립트로 되돌리거나 일괄 교정할 때 이 경로가 필요하다.
 *
 * --big-cat 은 cat_data.mid_to_big 에 <중분류>→<대분류> 매핑을 넣는다(이미 있으면 유지).
 *   대시보드는 대분류를 catMidToBig[중분류] 로 파생하므로, 새 중분류를 쓸 땐 이걸 같이 줘야
 *   '기타' 로 떨어지지 않는다. 행의 big_cat 필드는 빈 값(=중분류 기준 자동)으로 두는 게 정상이다.
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const INSPECT = argv.includes('--inspect');

const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const FLAG_NAMES = ['--from', '--to', '--desc', '--clobe-id', '--big-cat'];
// 플래그와 그 값을 걷어내고 남은 것이 위치인자(선택자/중분류 쌍)
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { if (FLAG_NAMES.includes(a) && argv[i + 1] && !argv[i + 1].startsWith('--')) i++; continue; }
  pos.push(a);
}

const EDGE = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
const SECRET_FILE = 'C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret';
/* Edge 게이트웨이가 verify_jwt=true 라 Authorization 헤더 필요(없으면 401).
   index.html 에 이미 박혀 배포되는 공개 publishable 키라 비밀이 아니다. */
const SUPA_PUBLISHABLE_KEY = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';

const won = (n) => Number(n || 0).toLocaleString('ko-KR');

async function call(payload) {
  const secret = readFileSync(SECRET_FILE, 'utf8').trim();
  const res = await fetch(EDGE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPA_PUBLISHABLE_KEY,
      Authorization: `Bearer ${SUPA_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify({ secret, ...payload }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.ok === false) {
    console.error(`\n실패 (HTTP ${res.status}):`, JSON.stringify(out).slice(0, 400));
    process.exit(3);
  }
  return out;
}

if (INSPECT) {
  const inspect = {};
  if (flag('--from')) inspect.from = flag('--from');
  if (flag('--to')) inspect.to = flag('--to');
  if (flag('--desc')) inspect.desc = flag('--desc');
  if (flag('--clobe-id')) inspect.clobeIds = flag('--clobe-id').split(',').map(s => s.trim()).filter(Boolean);
  if (argv.includes('--unclassified')) inspect.unclassifiedOnly = true;

  const out = await call({ inspect });
  console.log(`=== cf_data 조회 — ${out.matched}건 / 총 ${out.total}건 ===`);
  for (const r of out.rows || []) {
    const amt = r.in > 0 ? `입 ${won(r.in)}` : `출 ${won(r.out)}`;
    console.log(`  ${r.date}  ${amt.padStart(20)}  ${r.desc}`);
    console.log(`      중분류「${r.mid_cat || '(없음)'}」 대분류「${r.big_cat || '(자동)'}」  clobe_id=${r.clobe_id || '-'}  _id=${r._id}`);
  }
  /* process.exit(0) 로 끊으면 fetch 의 keep-alive 소켓이 닫히는 중에
     libuv assertion(win/async.c:94)으로 죽어 종료코드 127 이 나온다 — 정상 반환시킨다. */
  process.exitCode = 0;
} else {

if (!pos.length || pos.length % 2 !== 0) {
  console.error('사용법: node scripts/clobe-cf-patch.mjs <선택자(clobe_id|_id)> <중분류> [...] [--big-cat 대분류] [--dry-run]');
  console.error('       node scripts/clobe-cf-patch.mjs --inspect [--from ...] [--to ...] [--desc ...] [--unclassified]');
  process.exit(1);
}

const selectorOf = (tok) => {
  if (tok.startsWith('c:')) return { clobe_id: tok.slice(2) };
  if (tok.startsWith('i:')) return { _id: tok.slice(2) };
  return /^\d+$/.test(tok) ? { clobe_id: tok } : { _id: tok };
};

const patch = [];
for (let i = 0; i < pos.length; i += 2) patch.push({ ...selectorOf(pos[i]), mid_cat: pos[i + 1] });

const bigCat = flag('--big-cat');
const midToBig = bigCat ? Object.fromEntries(patch.map(p => [p.mid_cat, bigCat])) : null;

console.log('=== 입출금 분류 교정 ===');
for (const p of patch) console.log(`  ${p.clobe_id ?? p._id} → 중분류「${p.mid_cat}」`);
if (midToBig) console.log(`  대분류 매핑 추가: ${Object.entries(midToBig).map(([m, b]) => `${m}→${b}`).join(', ')}`);
if (DRY) { console.log(`\n[dry-run] 호출하지 않았습니다. 대상 ${patch.length}건.`); process.exit(0); }

const out = await call({ patch, ...(midToBig ? { midToBig } : {}) });

console.log(`\n교정 완료 — 변경 ${out.updated}건 / 입출금 총 ${out.total ?? '-'}건`);
for (const c of out.changes || []) {
  console.log(`  ${c.date}  ${c.desc}`);
  console.log(`      중분류「${c.before.mid_cat || '(없음)'}」 → 「${c.after.mid_cat || '(없음)'}」` +
              (c.before.big_cat !== c.after.big_cat ? `  대분류「${c.before.big_cat || '(자동)'}」 → 「${c.after.big_cat || '(자동)'}」` : ''));
}
if (out.midToBig) {
  if (out.midToBig.added?.length) console.log(`  대분류 매핑 추가됨: ${out.midToBig.added.join(', ')}`);
  if (out.midToBig.kept?.length)  console.log(`  대분류 매핑 기존값 유지: ${out.midToBig.kept.join(', ')}`);
}
if (out.notFound?.length) console.error(`\n⚠ 없는 선택자: ${out.notFound.join(', ')}`);   // c:=clobe_id, i:=_id
if (!out.updated && !out.notFound?.length) console.log('  (이미 그 값이라 변경 없음)');

}

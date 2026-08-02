#!/usr/bin/env node
/**
 * clobe-card-ingest — 클로브 카드 승인내역(JSON) → 검증 → corp_card_tx_data 적재
 *
 * 사용:
 *   node scripts/clobe-card-ingest.mjs <clobe-card.json> [--dry-run] [--allow-today]
 *
 * <clobe-card.json> 은 클로브 MCP `get_card_approvals` 응답 그대로.
 * 여러 페이지면 배열로: [ {페이지0}, {페이지1}, ... ]
 *
 * 지키는 규칙
 *  1) 승인(사용) 축만 쓴다. `get_labeled_card_billing_items`(청구) 와 절대 섞지 않는다 — 이중계상.
 *  2) 카드 데이터는 cf_data(현금흐름)에 넣지 않는다. 실제 현금 유출은 은행 '카드대금 결제'가 잡는다.
 *  3) 취소 반영: remainingUsedAmountKrw(순액) 사용, 0 이하(전액취소)는 제외.
 *  4) 계정과목: memo 의 ':' 앞부분 (대시보드 extractCCAccount 와 동일 규칙).
 *  5) 별칭: API가 안 주므로 scripts/card-alias-map.json 으로 카드번호→별칭 매핑(뒤 4자리 폴백).
 *  6) 오늘자는 스냅샷 미완성 가능성으로 기본 제외.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const DRY = args.includes('--dry-run');
const ALLOW_TODAY = args.includes('--allow-today');
if (!file) { console.error('사용법: node scripts/clobe-card-ingest.mjs <clobe-card.json> [--dry-run] [--allow-today]'); process.exit(1); }

const EDGE = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/card-ingest';
const SECRET_FILE = 'C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret';
/* Edge 게이트웨이가 verify_jwt=true 라 Authorization 헤더가 필요하다(없으면 401 UNAUTHORIZED_NO_AUTH_HEADER).
   아래는 index.html 에 이미 박혀 브라우저로 배포되는 공개 publishable 키라 비밀이 아니다.
   실제 권한 검증은 함수 안에서 BANK_SYNC_SECRET 으로 한다. */
const SUPA_PUBLISHABLE_KEY = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const MAP_FILE = new URL('./card-alias-map.json', import.meta.url);

const won = n => Math.round(n).toLocaleString('ko-KR');
const todayKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

/* ── 별칭 매핑 (전체 일치 → 뒤 4자리 폴백) ───────────────────
   폴백은 '마스킹 뒤에 노출된 끝자리 숫자'만 본다.
   숫자를 전부 뽑아 이어붙이면 BIN 앞자리가 꼬리에 섞인다 —
   `5566*********555` → 5566555 → '6555', `3792********921` → 3792921 → '2921'.
   둘 다 실제 끝 4자리가 아니라서 엉뚱한 카드와 맞을 수 있다.
   노출 자리가 4자리 미만이면 판별 불가로 보고 폴백하지 않는다(→ 미매핑 경고).
   서로 다른 별칭이 같은 끝 4자리를 만들면 모호하므로 역시 폴백하지 않는다. */
const aliasMap = JSON.parse(readFileSync(MAP_FILE, 'utf8')).map || {};
const tail4 = s => {
  const t = String(s ?? '').match(/(\d+)$/)?.[1] ?? '';   // 끝에 붙어 있는 숫자만
  return t.length >= 4 ? t.slice(-4) : null;
};
const AMBIGUOUS = Symbol('ambiguous');
const byTail4 = new Map();
for (const [no, al] of Object.entries(aliasMap)) {
  const k = tail4(no);
  if (!k) continue;
  byTail4.set(k, byTail4.has(k) && byTail4.get(k) !== al ? AMBIGUOUS : al);
}
const aliasOf = no => {
  if (no in aliasMap) return aliasMap[no];               // 전체 일치가 항상 우선
  const k = tail4(no);
  if (!k || !byTail4.has(k)) return null;
  const hit = byTail4.get(k);
  return hit === AMBIGUOUS ? null : hit;
};

/* ── 계정과목 추출 (대시보드 extractCCAccount 와 동일) ─────── */
const acctOf = memo => {
  const s = String(memo || '').trim();
  if (!s) return '미분류';
  const a = (s.includes(':') ? s.slice(0, s.indexOf(':')) : s).trim();
  return a || '미분류';
};

/* ── 1) 파싱 · dedupe ──────────────────────────────────────── */
const raw = JSON.parse(readFileSync(file, 'utf8'));
const pages = Array.isArray(raw) ? raw : [raw];
const rowsRaw = pages.flatMap(p => Array.isArray(p?.content) ? p.content : []);
const expected = Math.max(...pages.map(p => Number(p?.totalElements) || 0), 0);
if (!rowsRaw.length) { console.error('승인내역이 없습니다.'); process.exit(1); }

const byId = new Map();
for (const r of rowsRaw) if (!byId.has(String(r.approvalId))) byId.set(String(r.approvalId), r);
const uniq = [...byId.values()];

/* ── 2) 취소·오늘자 필터 ───────────────────────────────────── */
const today = todayKST();
const dateOf = r => String(r.usedAt || '').slice(0, 10);
const net = r => Math.round(Number(r.remainingUsedAmountKrw ?? r.usedAmountKrw) || 0);
const cancelled = uniq.filter(r => net(r) <= 0);
let live = uniq.filter(r => net(r) > 0);
const todayRows = live.filter(r => dateOf(r) >= today);
if (!ALLOW_TODAY) live = live.filter(r => dateOf(r) < today);

/* ── 3) 별칭 미매핑 점검 ───────────────────────────────────── */
const unmapped = [...new Set(live.map(r => String(r.cardNo || '')).filter(no => aliasOf(no) === null))];

console.log('=== 클로브 카드 승인내역 적재 검증 ===');
console.log(`원본 ${rowsRaw.length}행 · dedupe ${uniq.length}건` + (expected ? ` · totalElements ${expected}` : ''));
if (expected && uniq.length !== expected) {
  console.error(`⚠ 건수 불일치(${uniq.length} ≠ ${expected}) — 페이지 누락 의심.`);
  if (!DRY) { console.error('적재를 중단합니다. 모든 페이지를 받아 다시 시도하세요.'); process.exit(2); }
}
console.log(`취소(순액 0) 제외 ${cancelled.length}건` + (todayRows.length && !ALLOW_TODAY ? ` · 오늘자 제외 ${todayRows.length}건` : ''));
if (unmapped.length) {
  console.error(`\n⚠ 별칭 매핑에 없는 카드 ${unmapped.length}개: ${unmapped.join(', ')}`);
  console.error('   scripts/card-alias-map.json 에 위 문자열을 키로 그대로 추가하세요. (매핑 없으면 집계표에서 빠집니다)');
}

/* ── 4) 월별 요약 ──────────────────────────────────────────── */
const byMonth = new Map();
for (const r of live) {
  const m = dateOf(r).slice(0, 7);
  const b = byMonth.get(m) || { n: 0, sum: 0 };
  b.n++; b.sum += net(r); byMonth.set(m, b);
}
console.log('\n월별 (적재 대상)');
for (const m of [...byMonth.keys()].sort()) {
  const b = byMonth.get(m);
  console.log(`  ${m}  ${String(b.n).padStart(4)}건   ${won(b.sum).padStart(15)}원`);
}
console.log(`  합계  ${String(live.length).padStart(4)}건   ${won(live.reduce((s, r) => s + net(r), 0)).padStart(15)}원`);

/* ── 5) 대시보드 행으로 변환 ───────────────────────────────── */
const rows = live.map(r => ({
  use_date:       dateOf(r),
  card_alias:     aliasOf(r.cardNo) ?? '',
  card_no:        String(r.cardNo || ''),
  merchant:       String(r.memberStoreName || '').trim(),
  billing_amount: net(r),
  memo:           acctOf(r.memo),
  approval_id:    String(r.approvalId),
}));

const acctCount = rows.reduce((m, r) => (m[r.memo] = (m[r.memo] || 0) + 1, m), {});
console.log('\n계정과목:', Object.entries(acctCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · '));

if (DRY) { console.log(`\n[dry-run] 적재하지 않았습니다. 대상 ${rows.length}건.`); process.exit(0); }

/* ── 6) 적재 ───────────────────────────────────────────────── */
const secret = readFileSync(SECRET_FILE, 'utf8').trim();
const res = await fetch(EDGE, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    apikey: SUPA_PUBLISHABLE_KEY,
    Authorization: `Bearer ${SUPA_PUBLISHABLE_KEY}`,
  },
  body: JSON.stringify({ secret, rows }),
});
const out = await res.json().catch(() => ({}));
if (!res.ok || out.ok === false) {
  console.error(`\n적재 실패 (HTTP ${res.status}):`, JSON.stringify(out).slice(0, 300));
  process.exit(3);
}
console.log(`\n적재 완료 — 추가 ${out.added} · 중복 skip ${out.skipped} · 카드내역 총 ${out.total}건`);

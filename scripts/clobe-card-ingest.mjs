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

/* ── userNames(클로브가 주는 카드 사용자) → 별칭 교차검증 ────
   별칭은 map 파일이 유일한 근거라, 카드 재발급·담당 변경으로 낡으면 조용히 틀린 사람에게 붙는다.
   클로브 응답의 userNames 로 그걸 잡는다. 다만 신호가 있는 건 개인 명의 카드뿐:
     '김*민(KIM HYUN MIN)' · '박*현'  → 사람 (가운데만 가려진 3글자)
     '주*회사 로가' · '(**로가'        → 법인 명의라 카드를 구분 못 함 = 신호 없음
   → 사람 이름 꼴일 때만 비교하고, 아니면 아무 말도 하지 않는다(오탐 방지). */
const personOf = names => {
  const raw = String((Array.isArray(names) ? names[0] : names) ?? '')
    .replace(/\(.*$/, '')   // '김*민(KIM HYUN MIN)' → '김*민'
    .trim();
  return /^[가-힣]\*[가-힣]$/.test(raw) ? raw : null;   // 그 외는 법인/깨진 값 → 신호 없음
};
// 별칭에 그 이름이 들어 있나 — '하*수' 가 '하경수대표님' 안에 있으면 일치로 본다
const aliasHasPerson = (alias, masked) => {
  const re = new RegExp('^' + masked[0] + '.' + masked[2] + '$');
  const ko = String(alias || '').match(/[가-힣]+/g) || [];
  return ko.some(seg => { for (let i = 0; i + 3 <= seg.length; i++) if (re.test(seg.slice(i, i + 3))) return true; return false; });
};

/* ── 계정과목 추출 (대시보드 extractCCAccount 와 동일) ─────── */
const acctOf = memo => {
  const s = String(memo || '').trim();
  if (!s) return '미분류';
  const a = (s.includes(':') ? s.slice(0, s.indexOf(':')) : s).trim();
  return a || '미분류';
};
// ':' 뒤 세부문구 — 계정과목 제안은 여기서만 단서를 찾는다
const detailOf = memo => {
  const s = String(memo || '').trim();
  return s.includes(':') ? s.slice(s.indexOf(':') + 1).trim() : '';
};

/* ── 계정과목 제안 (제안만, 적재값은 안 바꾼다) ──────────────
   클로브 memo 가 '계정과목: 세부' 형식이 아닐 때 — 앞에 프로젝트명·팀명·사람 이름이
   오는 경우 — 그 값이 그대로 계정과목이 된다. 세부문구 키워드로 진짜 계정과목을 추정해
   사람에게 보여준다. 자동 적용하지 않는 이유는 account-rules.json 의 _why_not_auto 참고. */
const RULES_FILE = new URL('./account-rules.json', import.meta.url);
let KNOWN_ACCOUNTS = new Set(), ACCT_RULES = [], MERCHANT_RULES = [];
try {
  const cfg = JSON.parse(readFileSync(RULES_FILE, 'utf8'));
  KNOWN_ACCOUNTS = new Set(cfg.accounts || []);
  ACCT_RULES = cfg.rules || [];
  MERCHANT_RULES = cfg.merchantRules || [];
} catch { /* 규칙 파일이 없으면 제안 기능만 조용히 꺼진다 */ }
const suggestAcct = memo => {
  const d = detailOf(memo);
  if (!d) return null;
  for (const r of ACCT_RULES) if ((r.keywords || []).some(k => d.includes(k))) return r.account;
  return null;
};
// 미분류(메모 없음)용 — 가맹점명 키워드. 식당·카페는 규칙에 없다(원리적으로 구분 불가).
const suggestByMerchant = name => {
  const s = String(name || '');
  for (const r of MERCHANT_RULES) if ((r.keywords || []).some(k => s.includes(k))) return r.account;
  return null;
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

/* ── 3) 별칭 점검 — 미매핑 · 빈값 · userNames 불일치 ───────── */
const unmapped = [...new Set(live.map(r => String(r.cardNo || '')).filter(no => aliasOf(no) === null))];

// 카드번호별로 건수·금액·userNames 를 모아 아래 두 점검에 쓴다
const byCard = new Map();
for (const r of live) {
  const no = String(r.cardNo || '');
  const e = byCard.get(no) || { n: 0, sum: 0, persons: new Set() };
  e.n++; e.sum += net(r);
  const p = personOf(r.userNames);
  if (p) e.persons.add(p);
  byCard.set(no, e);
}

// (a) 별칭이 빈 문자열인 카드 — 사용내역엔 남지만 집계표 카드열이 없어 통째로 빠진다.
//     aliasOf 가 null 이 아니라 '' 라서 위 미매핑 경고에는 안 걸린다 → 따로 알린다.
const blankCards = [...byCard].filter(([no]) => aliasOf(no) === '');

// (b) 매핑된 별칭과 클로브 userNames 가 어긋나는 카드 (개인 명의 카드에만 신호가 있다)
const nameMismatch = [];
for (const [no, e] of byCard) {
  const alias = aliasOf(no);
  if (!alias) continue;                       // 미매핑·빈값은 위에서 이미 다룬다
  for (const p of e.persons) if (!aliasHasPerson(alias, p)) nameMismatch.push({ no, alias, person: p, n: e.n });
}

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
if (blankCards.length) {
  const n = blankCards.reduce((s, [, e]) => s + e.n, 0);
  const sum = blankCards.reduce((s, [, e]) => s + e.sum, 0);
  const pct = live.length ? (sum / live.reduce((s, r) => s + net(r), 0) * 100).toFixed(1) : '0';
  console.error(`\n⚠ 별칭이 빈 카드 ${blankCards.length}장 — ${n}건 ${won(sum)}원(금액의 ${pct}%)이 집계표에서 빠집니다.`);
  console.error('   사용내역 목록·총계에는 남지만 카드×계정과목 표에는 열이 없어 안 잡힙니다.');
  for (const [no, e] of blankCards) {
    const hint = e.persons.size ? `클로브 사용자: ${[...e.persons].join('/')}` : '법인 명의라 클로브도 사람을 모름 — 직접 지정 필요';
    console.error(`     ${no}  ${String(e.n).padStart(3)}건 ${won(e.sum).padStart(11)}원  · ${hint}`);
  }
}
if (nameMismatch.length) {
  console.error(`\n⚠ 별칭과 클로브 사용자가 다른 카드 ${nameMismatch.length}장 — 카드 재발급·담당 변경으로 매핑이 낡았을 수 있습니다.`);
  for (const m of nameMismatch) {
    console.error(`     ${m.no}  매핑 「${m.alias}」 ↔ 클로브 「${m.person}」  (${m.n}건)`);
  }
  console.error('   맞으면 무시해도 되고, 틀리면 card-alias-map.json 을 고친 뒤 다시 적재하세요.');
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

/* ── 계정과목 오라벨 제안 ─────────────────────────────────
   ':' 앞이 알려진 계정과목이 아닌 행만 대상. 정상 라벨은 사람이 이미 판단한 값이라 건드리지 않는다. */
if (KNOWN_ACCOUNTS.size) {
  const odd = live
    .map(r => ({ r, acct: acctOf(r.memo) }))
    .filter(x => !KNOWN_ACCOUNTS.has(x.acct))
    .map(x => ({ ...x, guess: suggestAcct(x.r.memo) }));
  if (odd.length) {
    const sum = odd.reduce((s, x) => s + net(x.r), 0);
    const n = odd.filter(x => x.guess).length;
    console.error(`\n⚠ 계정과목 자리에 계정과목이 아닌 값이 온 행 ${odd.length}건 ${won(sum)}원 — ${n}건은 추정됩니다.`);
    console.error('   클로브 memo 가 \'계정과목: 세부\' 형식이 아니라 앞에 프로젝트명·팀명·사람 이름이 온 경우입니다.');
    for (const x of odd) {
      console.error(`     ${dateOf(x.r)}  ${String(x.r.memberStoreName).slice(0, 20).padEnd(22)}` +
        `${won(net(x.r)).padStart(11)}원  「${x.acct}」→ ${x.guess ? `「${x.guess}」` : '추정 실패 — 직접 지정'}`);
      console.error(`        memo: ${x.r.memo}`);
    }
    const cmd = odd.filter(x => x.guess).map(x => `${x.r.approvalId} ${x.guess}`).join(' ');
    if (cmd) {
      console.error('\n   확인 후 아래로 적용하세요 (추정이 틀린 건 계정과목만 바꿔서 실행):');
      console.error(`     node scripts/clobe-card-patch.mjs ${cmd}`);
    }
    console.error('   ※ 제안일 뿐 적재값은 memo 원본대로 들어갑니다. 근본 해결은 클로브에서 memo 를 고치는 것.');
  }

  /* ── 미분류(메모 없음) 제안 ────────────────────────────
     두 단계: ① 가맹점명 키워드(주유소·택시·우체국 …, 실측 정밀도 97.9%)
              ② 같은 배치 안에서 그 가맹점이 어떤 계정과목으로 라벨됐는지 다수결(2건 이상·70% 이상)
     식당·카페는 ①에 없고 ②에서도 대개 갈려서 안 잡힌다 — 혼밥/접대는 데이터에 없는 정보라
     사람이 볼 수밖에 없다. 억지로 채우지 않는다. */
  const hist = new Map();   // 가맹점 → Map(계정과목 → 건수)
  for (const r of live) {
    const a = acctOf(r.memo);
    if (!KNOWN_ACCOUNTS.has(a) || a === '미분류') continue;
    const m = String(r.memberStoreName || '').trim();
    if (!hist.has(m)) hist.set(m, new Map());
    const c = hist.get(m);
    c.set(a, (c.get(a) || 0) + 1);
  }
  const histGuess = name => {
    const c = hist.get(String(name || '').trim());
    if (!c) return null;
    const tot = [...c.values()].reduce((a, b) => a + b, 0);
    const [acc, n] = [...c].sort((a, b) => b[1] - a[1])[0];
    return (tot >= 2 && n / tot >= 0.7) ? { acc, conf: n / tot, tot } : null;
  };

  const none = live.filter(r => acctOf(r.memo) === '미분류');
  if (none.length) {
    const picked = none.map(r => {
      const byName = suggestByMerchant(r.memberStoreName);
      if (byName) return { r, acc: byName, how: '가맹점명' };
      const h = histGuess(r.memberStoreName);
      if (h) return { r, acc: h.acc, how: `이력 ${Math.round(h.conf * 100)}%·${h.tot}건` };
      return { r, acc: null, how: null };
    });
    const got = picked.filter(x => x.acc);
    const sumAll = none.reduce((s, r) => s + net(r), 0);
    const sumGot = got.reduce((s, x) => s + net(x.r), 0);
    console.error(`\n· 미분류(메모 없음) ${none.length}건 ${won(sumAll)}원 — 규칙으로 ${got.length}건 ${won(sumGot)}원 추정 가능`);
    for (const x of got) {
      console.error(`     ${dateOf(x.r)}  ${String(x.r.memberStoreName).slice(0, 20).padEnd(22)}` +
        `${won(net(x.r)).padStart(11)}원  → 「${x.acc}」  [${x.how}]`);
    }
    const rest = none.length - got.length;
    if (rest) console.error(`   나머지 ${rest}건 ${won(sumAll - sumGot)}원은 식당·카페 등이라 규칙으로 못 정합니다` +
      ' — 같은 가게라도 혼자면 복리후생비, 거래처와면 접대비라 데이터에 단서가 없습니다.');
    const cmd = got.map(x => `${x.r.approvalId} ${x.acc}`).join(' ');
    if (cmd) {
      console.error('\n   확인 후 아래로 적용하세요:');
      console.error(`     node scripts/clobe-card-patch.mjs ${cmd}`);
    }
  }
}

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

#!/usr/bin/env node
/**
 * cf-classify-from-xlsx.mjs — 사용자 제공 엑셀(로가_입출금 내역_26년 상반기.xlsx)의 K열 계정과목을
 * cf_data 의 중분류/대분류로 입힌다. 기본은 **보고만** 하고, --apply 를 줄 때만 Edge patch 로 쓴다.
 *
 * 왜 이렇게 하나 (2026-08-22):
 *   clobe-cf-ingest.mjs 는 의도적으로 중분류를 안 보낸다(대시보드 자동분류 추천에 맡긴다).
 *   1~2월 462건을 채우면서 분류까지 넣어야 하는데, 적재 스크립트를 건드리면 그 안의 검증 가드
 *   (합계 대조·외화 환율 역산·취소 레그 판정)에 손을 대는 셈이다. 그래서 **적재는 그대로 두고
 *   분류만 뒤에 입힌다.** patch 액션은 mid_cat/big_cat 만 고치므로 금액을 틀리게 할 수 없다.
 *
 * 매핑 알고리즘 — 유사도 '추론' 을 하지 않는다. 파일에 이미 있는 판정을 옮기는 것뿐이다.
 *   1) **날짜 + 부호금액 정확 매칭** → 그 행의 K. 이게 주력이다(실측 조인율 94%).
 *      같은 날 같은 금액이 여럿이면 순서대로 하나씩 소진한다(다중집합).
 *      ⚠ 외화 행은 cf_data 에 원화 환산액으로 들어가고 파일도 원화라 그대로 맞는다
 *        (2026-01-09 USD 124.12 → 179,900원, 파일과 정확히 일치 확인).
 *   2) 실패분 — cf 의 적요가 파일의 C열(적요) 또는 D열(거래처라벨)과 같고, 그 값에 걸린 K가
 *      **하나로 결정될 때만** 쓴다. (사용자 규칙: C·D 둘 중 하나만 맞아도 된다)
 *   3) 그래도 K가 둘 이상으로 갈리거나 아예 없으면 → **비우고 목록에 남긴다.**
 *      임의로 확정하지 않는다(2026-08-22 사용자 지시).
 *
 * K열 → (중분류, 대분류) 변환 규칙. 파일 표기를 그대로 쓰되 아래만 예외다(사용자 확정):
 *   · 세금과공과 → 세금과공과금 / 인건비 → 급여   (기존 중분류로 통합. 이름만 다른 같은 항목)
 *   · 대여금 → 출금이면 '대여금 지급', 입금이면 '대여금 수취' (자금거래). 기존 3종 체계 유지.
 *     ⚠ '대여금 상환' 은 방향만으로 알 수 없어 지급/수취로 들어간다 — 상환 건은 나중에 손봐야 한다.
 *   · 생산대금 → 매입 (입금이지만 매입 차감 성격, 사용자 확정)
 *   · D2C·아마존·바이오포트코리아 → 매출 (형제 채널·거래처가 전부 매출)
 *   · 보관비 → 판매관리비
 *   나머지 38가지는 대시보드 mid_to_big 에 이미 있으므로 거기서 대분류를 가져온다.
 *
 * 쓰는 법:
 *   node scripts/cf-classify-from-xlsx.mjs --rows <xlsx-rows.json> --from 2026-01-02 --to 2026-01-09
 *   node scripts/cf-classify-from-xlsx.mjs --rows <...> --from ... --to ... --apply
 *
 *   <xlsx-rows.json> 은 엑셀 rawdata 시트를 [{date,desc,partner,in,out,acct}] 로 뽑은 파일.
 *   (openpyxl 로 뽑는다 — 이 스크립트는 엑셀을 직접 읽지 않는다)
 */

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const ROWS = opt('--rows'), FROM = opt('--from'), TO = opt('--to');
const APPLY = argv.includes('--apply');
if (!ROWS || !FROM || !TO) {
  console.error('사용법: node scripts/cf-classify-from-xlsx.mjs --rows <xlsx-rows.json> --from YYYY-MM-DD --to YYYY-MM-DD [--apply]');
  process.exit(1);
}

const PK = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const SECRET = readFileSync('C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret', 'utf8').trim();
const EP = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
const won = (n) => Math.round(Number(n) || 0).toLocaleString('ko-KR');

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

/* ── K열 → (중분류, 대분류) ─────────────────────────────────────── */
const RENAME = { '세금과공과': '세금과공과금', '인건비': '급여' };          // 기존 중분류로 통합
const NEW_BIG = {                                                        // mid_to_big 에 없는 것들의 대분류
  'D2C': '매출', '아마존': '매출', '바이오포트코리아': '매출', '에이치도슨트': '매출',
  '보관비': '판매관리비', '생산대금': '매입', '세종': '세종시',
  '투자금 입금': '재무활동', '대출': '차입',
};
const resolveCat = (acct, signedAmt, m2b) => {
  if (!acct) return null;
  if (acct === '대여금') {                                               // 방향으로 분기(사용자 확정)
    const mid = signedAmt < 0 ? '대여금 지급' : '대여금 수취';
    return { mid, big: m2b[mid] || '자금거래' };
  }
  const mid = RENAME[acct] || acct;
  const big = m2b[mid] || NEW_BIG[acct] || NEW_BIG[mid] || null;
  return big ? { mid, big } : null;                                      // 대분류를 모르면 미결정으로 남긴다
};

/* ── 입력 ─────────────────────────────────────────────────────── */
const xl = JSON.parse(readFileSync(ROWS, 'utf8')).filter((r) => r.date >= FROM && r.date <= TO);
const meta = (await post({ inspect: { from: TO, to: TO, meta: ['mid_to_big'] } })).meta?.mid_to_big || {};
const cf = ((await post({ inspect: { from: FROM, to: TO } })).rows || [])
  .filter((r) => r.status === '실제 입금' || r.status === '실제 지출')
  .map((r) => ({ ...r, amt: Math.round((Number(r.in) || 0) - (Number(r.out) || 0)) }))
  .filter((r) => r.amt !== 0);

console.log(`=== 엑셀 계정과목 → cf_data 분류 (${FROM} ~ ${TO}) ===`);
console.log(`엑셀 ${xl.length}행 · cf_data 실거래 ${cf.length}건 · 대시보드 중분류 ${Object.keys(meta).length}가지\n`);

/* ── 1) 날짜+금액 다중집합 매칭 ──────────────────────────────── */
const byKey = new Map();
for (const r of xl) {
  const k = `${r.date}|${Math.round(r.in - r.out)}`;
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(r);
}
const used = new Map();
const hits = [], left = [];
for (const c of cf) {
  const k = `${c.date}|${c.amt}`;
  const cand = byKey.get(k) || [];
  const n = used.get(k) || 0;
  if (n < cand.length) { used.set(k, n + 1); hits.push({ c, x: cand[n], via: '날짜+금액' }); }
  else left.push(c);
}

/* ── 2) 적요/거래처라벨 단일 결정 ─────────────────────────────── */
const byText = new Map();                                                // 적요 또는 라벨 문자열 → K 집합
const addText = (t, acct) => { if (!t) return; if (!byText.has(t)) byText.set(t, new Set()); byText.get(t).add(acct); };
for (const r of JSON.parse(readFileSync(ROWS, 'utf8'))) { addText(r.desc, r.acct); addText(r.partner, r.acct); }
const unresolved = [];
for (const c of left) {
  const set = byText.get(String(c.desc || '').trim());
  if (set && set.size === 1) hits.push({ c, x: { acct: [...set][0] }, via: '적요/라벨' });
  else unresolved.push({ c, cands: set ? [...set] : [] });
}

/* ── 3) 결과 정리 ─────────────────────────────────────────────── */
const patch = [], noBig = [];
for (const h of hits) {
  const r = resolveCat(h.x.acct, h.c.amt, meta);
  if (!r) { noBig.push({ ...h }); continue; }
  if (h.c.mid_cat === r.mid && h.c.big_cat === r.big) continue;           // 이미 같으면 건드리지 않는다
  patch.push({ clobe_id: h.c.clobe_id, _id: h.c._id, mid_cat: r.mid, big_cat: r.big,
               _via: h.via, _acct: h.x.acct, _date: h.c.date, _amt: h.c.amt, _desc: h.c.desc,
               _was: `${h.c.big_cat || '-'}/${h.c.mid_cat || '-'}` });
}
const byVia = {}; for (const h of hits) byVia[h.via] = (byVia[h.via] || 0) + 1;
console.log(`매칭: ` + Object.entries(byVia).map(([k, v]) => `${k} ${v}`).join(' · ') + ` / 미결정 ${unresolved.length}`);
console.log(`바꿀 행 ${patch.length}건 (이미 같은 분류라 건너뛴 것 ${hits.length - patch.length - noBig.length}건)\n`);

const midCnt = {};
for (const p of patch) { const k = `${p.big_cat}/${p.mid_cat}`; midCnt[k] = (midCnt[k] || 0) + 1; }
console.log('=== 입힐 분류 분포 ===');
for (const [k, v] of Object.entries(midCnt).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);

if (noBig.length) {
  console.log(`\n❌ 대분류를 모르는 계정과목 ${noBig.length}건 — NEW_BIG 에 추가해야 합니다`);
  for (const h of [...new Set(noBig.map((h) => h.x.acct))]) console.log(`     '${h}'`);
}
if (unresolved.length) {
  console.log(`\n⚠ 미결정 ${unresolved.length}건 — 중분류를 비운 채 둡니다(임의 확정 안 함)`);
  for (const u of unresolved.slice(0, 40)) {
    const why = u.cands.length > 1 ? `계정과목이 ${u.cands.join('/')} 로 갈림` : '엑셀에 없음';
    console.log(`     ${u.c.date} ${won(u.c.amt).padStart(15)}  '${String(u.c.desc || '').slice(0, 22)}'  ${why}`);
  }
  if (unresolved.length > 40) console.log(`     … 외 ${unresolved.length - 40}건`);
}

/* ── 4) 적용 ──────────────────────────────────────────────────── */
if (!APPLY) { console.log(`\n[보고만] --apply 를 주면 ${patch.length}건을 실제로 씁니다.`); process.exit(0); }
if (!patch.length) { console.log('\n바꿀 것이 없습니다.'); process.exit(0); }
/* 새로 쓰는 중분류의 대분류 매핑도 같이 넣는다 — 없으면 대시보드에서 '기타' 로 보인다 */
const midToBig = {};
for (const p of patch) if (!meta[p.mid_cat]) midToBig[p.mid_cat] = p.big_cat;
const CHUNK = 200;
let done = 0;
for (let i = 0; i < patch.length; i += CHUNK) {
  const slice = patch.slice(i, i + CHUNK).map(({ clobe_id, _id, mid_cat, big_cat }) =>
    (clobe_id ? { clobe_id, mid_cat, big_cat } : { _id, mid_cat, big_cat }));
  const res = await post({ patch: slice, ...(i === 0 && Object.keys(midToBig).length ? { midToBig } : {}) });
  if (!res.ok) { console.error('patch 실패:', res.error); process.exit(1); }
  done += Number(res.updated) || 0;
  if (res.notFound?.length) console.error(`  ⚠ 못 찾음 ${res.notFound.length}건: ${res.notFound.slice(0, 5).join(', ')}`);
  if (i === 0 && res.midToBig) console.log(`중분류 매핑 추가: ${(res.midToBig.added || []).join(' · ') || '(없음)'}`);
}
console.log(`\n적용 완료 — ${done}건 분류 갱신`);

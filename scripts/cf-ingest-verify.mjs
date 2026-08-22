#!/usr/bin/env node
/**
 * cf-ingest-verify.mjs — 클로브 은행 입출금과 cf_data 적재분이 실제로 같은지 대조한다. **읽기 전용.**
 *
 * 왜 만들었나 (2026-08-22):
 *   2026년 cf_data 1,500건 중 **69.9%(1,049건)가 clobe_id 가 없다**(3~6월은 0%). 은행 원본과
 *   맞춰볼 키가 없어서 "빠진 게 있는지" 를 확인할 방법이 아예 없었다. 게다가 2026-02 는
 *   실거래가 **0건**이고 일반 입출금은 2026-03-03 부터 시작한다 — 1~2월이 통째로 비어 있는지
 *   확정하려면 원본과 대조해야 한다.
 *   법인카드에서 7월 42건 16,485,145원이 소리 없이 빠졌던 걸 잡아낸 게 같은 방식의 대조였다.
 *   적재 스크립트는 그때도 "추가 N · 중복 skip M" 을 찍고 정상 종료했다. 사람 눈 대신 이게 잡는다.
 *
 * 무엇을 보는가 (clobe_id 가 없어 **금액+날짜+방향**으로 맞춘다):
 *   ① 누락       클로브에 있고 cf_data 에 없는 거래
 *   ② 유령       cf_data 에 있고 클로브에 없는 거래 (수기 입력분이면 정상)
 *   ③ 금액 불일치  같은 날 같은 방향인데 금액이 2% 이내로 다른 짝 (환율·수수료 차이 의심)
 *   ④ 분할 매칭    클로브 1건 = cf_data 2건인 경우 (2026-07-09 외환차손 분할처럼) — 정상 처리
 *
 * 쓰는 법 — 클로브 조회는 Claude 세션에서만 되므로 2단계다.
 *   1) 세션에서 아래 둘을 **그대로** 파일로 저장
 *        get_bank_accounts            → accounts.json
 *        get_labeled_transactions     → clobe-*.json  (hasNext 가 false 가 될 때까지 cursor 로 전부)
 *   2) node scripts/cf-ingest-verify.mjs --accounts accounts.json --clobe clobe-01.json clobe-02.json …
 *
 *   선택: --from YYYY-MM-DD --to YYYY-MM-DD (생략하면 클로브 파일의 최소~최대 거래일)
 *         --include-fx    외화계좌 포함 (기본 제외 — 아래 함정 참고)
 *         --include-loan  대출계좌 포함 (기본 제외 — 아래 함정 참고)
 *         --show N        목록에 보여줄 건수 (기본 25)
 *   불일치가 있으면 exit 1.
 *
 * ⚠ 함정 — 실제로 밟았거나 설계상 피해야 하는 것들:
 *   · **외화계좌(accountType=FX)는 기본 제외한다.** 클로브의 inAmount/outAmount 는 그 계좌의
 *     통화 단위다 — USD 계좌면 달러 금액이 온다. cf_data 는 원화라 그대로 비교하면 전부
 *     불일치로 잡힌다. 응답의 inAmountSumKrw 는 합계만 원화라 건별 환산이 불가능하다.
 *   · **대출계좌(LOAN)도 기본 제외한다.** 대출 실행·상환은 입출금계좌 쪽에도 같이 찍혀서
 *     포함하면 같은 돈이 두 번 잡힌다.
 *   · **예정 행은 대조 대상이 아니다.** status 가 '실제 입금'/'실제 지출' 인 것만 본다
 *     (카드·대출 예정은 은행에 아직 없다).
 *   · **같은 날 같은 금액이 여러 건 있다**(2026-07-09 745,945,000 이 2건). Set 으로 맞추면
 *     한 건만 소진되고 나머지가 누락으로 잡힌다 — 반드시 다중집합(개수 세기)으로 맞춘다.
 *   · **cf_data 조회는 Edge inspect 를 쓰고 500건에서 잘린다.** matched 가 500 을 넘으면
 *     구간을 재귀로 쪼개 받는다. 이걸 안 하면 잘린 만큼이 그대로 '누락' 으로 나온다.
 *   · 거래일이 하루 어긋나는 경우가 있어(은행 처리일 vs 기표일) 같은 날 매칭 후 남은 것만
 *     ±1일까지 넓혀 한 번 더 맞춘다. 그 이상은 넓히지 않는다 — 넓히면 다른 거래를 잘못 문다.
 *
 * 한계(정직하게):
 *   · clobe_id 가 없으니 매칭은 추정이다. 같은 날 같은 금액의 서로 다른 거래를 맞바꿔 맞출 수
 *     있다. 합계와 건수가 맞는지를 1차로 보고, 개별 목록은 조사 단서로 쓴다.
 *   · 클로브 응답을 덜 받아온 파일을 주면 그만큼이 '누락' 으로 잡힌다 — totalElements 와
 *     받은 건수를 비교해 그 경우를 구분해 알린다.
 */

import { readFileSync } from 'node:fs';
import { matchTx, addDays } from './cf-match.mjs';   // 매칭 규칙은 테스트 가능하게 분리(test-cf-match.mjs)

/* ── 인자 ─────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const opt  = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const listOpt = (k) => {                     // --clobe a.json b.json c.json
  const i = argv.indexOf(k);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]);
  return out;
};
const CLOBE_FILES = listOpt('--clobe');
const ACCOUNTS    = opt('--accounts');
const FROM_ARG    = opt('--from'), TO_ARG = opt('--to');
const SHOW        = Math.max(1, Number(opt('--show')) || 25);
const INC_FX      = flag('--include-fx'), INC_LOAN = flag('--include-loan');

if (!CLOBE_FILES.length || !ACCOUNTS) {
  console.error('사용법: node scripts/cf-ingest-verify.mjs --accounts accounts.json --clobe clobe-01.json [clobe-02.json …]');
  console.error('        [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--include-fx] [--include-loan] [--show N]');
  process.exit(1);
}

const PK = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const SECRET_PATH = 'C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret';
const ENDPOINT = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';

const won = (n) => Math.round(Number(n) || 0).toLocaleString('ko-KR');
const day = (s) => String(s || '').slice(0, 10);

/* ── 계좌 정보 ─────────────────────────────────────────────────────
   accountType 과 currencyCode 로 대조 대상을 정한다. FX·LOAN 은 위 함정 참고. */
const accRaw = JSON.parse(readFileSync(ACCOUNTS, 'utf8'));
const accList = Array.isArray(accRaw?.accounts) ? accRaw.accounts : (Array.isArray(accRaw) ? accRaw : []);
if (!accList.length) { console.error(`${ACCOUNTS} 에서 계좌 목록을 못 읽었습니다.`); process.exit(1); }
const ACC = new Map();
for (const a of accList) {
  ACC.set(String(a.bankAccountId), {
    type: String(a.accountType || ''),
    label: `${a.bankCode === '088' ? '신한/하나' : ''}${String(a.accountName || '')}${a.aliasName ? `(${a.aliasName})` : ''}`.trim() || String(a.displayAccountNumber || ''),
  });
}

/* ── 클로브 응답 읽기 ─────────────────────────────────────────────── */
let pages = [];
for (const f of CLOBE_FILES) {
  const j = JSON.parse(readFileSync(f, 'utf8'));
  pages.push(...(Array.isArray(j) ? j : [j]));
}
const rawTx = pages.flatMap((p) => (Array.isArray(p?.content) ? p.content : []));
if (!rawTx.length) { console.error('클로브 거래내역이 비어 있습니다.'); process.exit(1); }
/* transactionId 로 중복 제거 — 페이지가 겹쳐 저장됐을 수 있다 */
const dedup = new Map();
for (const t of rawTx) dedup.set(String(t.transactionId), t);

/* 페이지 누락 검사 — 같은 질의의 페이지끼리만 비교 의미가 있다 */
const totals = [...new Set(pages.map((p) => Number(p?.totalElements)).filter((v) => Number.isFinite(v)))];
if (totals.length === 1 && dedup.size !== totals[0]) {
  console.error(`⚠ 클로브 파일이 불완전합니다 — 받은 ${dedup.size}건 ≠ totalElements ${totals[0]}.`);
  console.error('  hasNext=false 까지 cursor 로 받아 다시 저장하세요. 이대로 돌리면 덜 받은 만큼이 "누락"으로 잡힙니다.\n');
}

const dates = [...dedup.values()].map((t) => day(t.transactionAt)).filter(Boolean).sort();
const FROM = FROM_ARG || dates[0];
const TO   = TO_ARG   || dates[dates.length - 1];

const unknownAcc = new Set();
const clobe = [];                                        // { date, amt(부호), desc, acc }
let skippedFx = 0, skippedLoan = 0;
for (const t of dedup.values()) {
  const d = day(t.transactionAt);
  if (!d || d < FROM || d > TO) continue;
  const id = String(t.accountId);
  if (!ACC.has(id)) unknownAcc.add(id);
  const a = ACC.get(id);
  const amt = Math.round((Number(t.inAmount) || 0) - (Number(t.outAmount) || 0));
  if (!amt) continue;                                    // 0원 거래(신규 개설 등)는 제외
  if (a?.type === 'FX' && !INC_FX)     { skippedFx++;   continue; }
  if (a?.type === 'LOAN' && !INC_LOAN) { skippedLoan++; continue; }
  clobe.push({ date: d, amt, acc: a?.label || `계좌 ${id}`,
               desc: String(t.transactionName || t.transactionDescription || '').trim(), tid: String(t.transactionId) });
}

/* ── cf_data 읽기 (Edge inspect · 500건 상한이라 재귀 분할) ─────────── */
const secret = readFileSync(SECRET_PATH, 'utf8').trim();
const post = async (body) => {
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: PK, Authorization: `Bearer ${PK}` },
        body: JSON.stringify({ secret, ...body }),
      });
      const text = await res.text();
      if (!text.trim().startsWith('{')) throw new Error(`HTTP ${res.status}`);
      return JSON.parse(text);
    } catch (e) { if (i === 3) throw e; await new Promise((r) => setTimeout(r, 700 * i)); }
  }
};
const seen = new Map();
const grab = async (f, t, depth = 0) => {
  const r = await post({ inspect: { from: f, to: t } });
  if (Number(r.matched) > 500 && depth < 8) {
    const span = (Date.parse(t) - Date.parse(f)) / 86400000;
    if (span >= 1) {
      const mid = addDays(f, Math.floor(span / 2));
      await grab(f, mid, depth + 1); await grab(addDays(mid, 1), t, depth + 1); return;
    }
    console.error(`⚠ ${f} 하루에 ${r.matched}건 — 500건만 받았습니다. 그만큼이 누락으로 잡힙니다.`);
  }
  for (const x of (r.rows || [])) seen.set(x._id, x);
};
await grab(FROM, TO);
const ours = [];
let oursFxSkipped = 0;
for (const r of seen.values()) {
  if (r.status !== '실제 입금' && r.status !== '실제 지출') continue;   // 예정 행 제외
  const amt = Math.round((Number(r.in) || 0) - (Number(r.out) || 0));
  if (!amt) continue;
  /* ⚠ 외화계좌를 클로브 쪽에서만 빼면 **cf_data 쪽 외화 행이 전부 '유령' 으로 잡힌다**
     (2026-08-22 검증 중 발견). 양쪽을 같은 기준으로 빼야 한다 — fx_usd 표시가 그 키다.
     단 2026-06-30 이전 외화 행은 태깅이 없어서 여전히 유령으로 남는다. 그건 오탐이 아니라
     "식별 불가능한 외화 행이 이만큼 있다" 는 정보다 — 아래 안내문에 그렇게 적는다. */
  if (r.fx_usd === true && !INC_FX) { oursFxSkipped++; continue; }
  ours.push({ date: r.date, amt, desc: String(r.desc || ''), cat: `${r.big_cat || '-'}/${r.mid_cat || '-'}`, _id: r._id });
}

const { matched1, matched2, matched3, splitHits, mismatch, missing, ghost } = matchTx(clobe, ours);

/* ── 보고 ─────────────────────────────────────────────────────────── */
const cSumIn  = clobe.filter((r) => r.amt > 0).reduce((s, r) => s + r.amt, 0);
const cSumOut = clobe.filter((r) => r.amt < 0).reduce((s, r) => s + r.amt, 0);
const oSumIn  = ours.filter((r) => r.amt > 0).reduce((s, r) => s + r.amt, 0);
const oSumOut = ours.filter((r) => r.amt < 0).reduce((s, r) => s + r.amt, 0);

console.log('=== 은행 입출금 적재 대조 ===');
console.log(`기간 ${FROM} ~ ${TO}`);
if (unknownAcc.size) console.log(`⚠ accounts.json 에 없는 계좌 ${unknownAcc.size}개 — 일단 포함했습니다: ${[...unknownAcc].join(', ')}`);
if (!INC_FX)   console.log(`제외: 외화 — 클로브 ${skippedFx}건 / cf_data ${oursFxSkipped}건(fx_usd 표시) (계좌 통화 단위라 원화 비교 불가 — --include-fx 로 포함)`);
if (!INC_FX)   console.log(`       ⚠ 2026-06-30 이전 외화 행은 fx_usd 태깅이 없어 아래 '유령' 에 섞입니다 — 오탐이 아니라 식별 불가 행의 규모입니다.`);
if (!INC_LOAN) console.log(`제외: 대출계좌 ${skippedLoan}건 (입출금계좌에 중복 반영 — --include-loan 로 포함)`);
console.log('');
console.log(`               건수        입금합            출금합`);
console.log(`클로브    ${String(clobe.length).padStart(8)}  ${won(cSumIn).padStart(16)}  ${won(cSumOut).padStart(16)}`);
console.log(`cf_data   ${String(ours.length).padStart(8)}  ${won(oSumIn).padStart(16)}  ${won(oSumOut).padStart(16)}`);
console.log(`차액      ${String(clobe.length - ours.length).padStart(8)}  ${won(cSumIn - oSumIn).padStart(16)}  ${won(cSumOut - oSumOut).padStart(16)}`);
console.log('');
console.log(`매칭: 같은날·같은금액 ${matched1} · ±1일 ${matched2} · 분할(1:2) ${matched3}`);

const show = (label, arr, fmt) => {
  if (!arr.length) { console.log(`\n✅ ${label} 없음`); return; }
  const sum = arr.reduce((s, r) => s + Math.abs(fmt.amt(r)), 0);
  console.log(`\n❌ ${label} ${arr.length}건 ${won(sum)}원`);
  for (const r of [...arr].sort((a, b) => Math.abs(fmt.amt(b)) - Math.abs(fmt.amt(a))).slice(0, SHOW))
    console.log(`     ${fmt.line(r)}`);
  if (arr.length > SHOW) console.log(`     … 외 ${arr.length - SHOW}건`);
};
show('누락(클로브에만)', missing, {
  amt: (r) => r.amt,
  line: (r) => `${r.date}  ${won(r.amt).padStart(15)}  ${r.desc.slice(0, 24).padEnd(25)} ${r.acc.slice(0, 20)}`,
});
show('금액 불일치(2% 이내)', mismatch, {
  amt: (r) => r.gap,
  line: (r) => `${r.c.date}  클로브 ${won(r.c.amt).padStart(14)} vs cf ${won(r.o.amt).padStart(14)}  차 ${won(r.gap).padStart(11)}  ${r.c.desc.slice(0, 18)}`,
});
show('유령(cf_data에만)', ghost, {
  amt: (r) => r.amt,
  line: (r) => `${r.date}  ${won(r.amt).padStart(15)}  ${r.cat.slice(0, 18).padEnd(19)} ${r.desc.slice(0, 22)}  ← 수기 입력분이면 정상`,
});
if (splitHits.length) {
  console.log(`\nℹ 분할 매칭 ${splitHits.length}건 (클로브 1건 = cf_data 2건 — 정상)`);
  for (const s of splitHits.slice(0, SHOW))
    console.log(`     ${s.c.date}  ${won(s.c.amt).padStart(14)} = ${s.parts.map((p) => won(p.amt)).join(' + ')}   ${s.parts.map((p) => p.cat).join(' , ')}`);
}

/* 월별 요약 — 어느 달이 비어 있는지 한눈에 */
console.log('\n=== 월별 건수 ===');
const months = [...new Set([...clobe, ...ours].map((r) => r.date.slice(0, 7)))].sort();
console.log('월        클로브   cf_data    차');
for (const m of months) {
  const c = clobe.filter((r) => r.date.startsWith(m)).length;
  const o = ours.filter((r) => r.date.startsWith(m)).length;
  console.log(`${m}   ${String(c).padStart(6)}  ${String(o).padStart(7)}  ${String(c - o).padStart(5)}${c > 0 && o === 0 ? '   ← cf_data 통째로 비어 있음' : ''}`);
}

if (missing.length || mismatch.length) {
  console.log('\n조치:');
  if (missing.length)  console.log('  · 누락 → 그 기간을 클로브 적재로 채운다. **기존 행을 지우지 말 것** — 분류가 자산이다(2026년 99.9% 분류 완료).');
  if (mismatch.length) console.log('  · 금액 불일치 → 환율·수수료 차이일 수 있다. 건별로 확인하고 필요하면 Edge split 로 비용을 분리한다.');
  process.exit(1);
}
console.log('\n대조 통과 — 누락·금액 불일치 없음.');

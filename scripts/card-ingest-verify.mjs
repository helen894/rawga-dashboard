#!/usr/bin/env node
/**
 * card-ingest-verify.mjs — 클로브 승인내역과 대시보드 적재분이 실제로 같은지 대조한다.
 *
 * 왜 만들었나 (2026-08-18):
 *   비씨카드 8/23 청구서가 18,544,957 인데 예정 추정은 2,048,614 였다. 추정 로직은 멀쩡했고,
 *   **7월 적재가 조용히 42건 16,485,145원을 빠뜨린 것**이 원인이었다. 적재 스크립트는
 *   "추가 N · 중복 skip M" 을 찍고 정상 종료했기 때문에 아무도 몰랐다. 한 달을 통째로
 *   놓쳐도 티가 안 나는 게 진짜 문제라, 사람 눈 대신 이 스크립트가 잡는다.
 *
 *   조사 중에 두 번째 결함도 나왔다: **해외 결제는 원화 금액이 나중에 확정**되는데,
 *   적재는 approval_id 가 같으면 건너뛰기만 하고 금액을 갱신하지 않는다.
 *   예) ANTHROPIC CLAUDE SUB 27164000 — 우리 2,200 vs 클로브 34,190.
 *   그래서 '누락' 뿐 아니라 '금액 불일치' 도 같이 본다.
 *
 * 무엇을 보는가 (approval_id 기준 3종):
 *   ① 누락      클로브에 있고 우리에 없는 유효건 (취소건은 제외 — 우리가 일부러 안 넣는다)
 *               단 **오늘(KST) 이후 승인은 누락으로 치지 않는다** — 적재가 당일분을 일부러
 *               빼기 때문이다. 금액 불일치·유령에는 이 면제가 없다.
 *   ② 금액 불일치 양쪽에 있는데 금액이 다른 건 (해외 환율 확정·부분취소 반영 누락)
 *   ③ 유령      우리에 있고 클로브에 없는 건 (수기 업로드분이면 정상, 아니면 조사 대상)
 *
 * 쓰는 법 — 클로브 조회는 Claude 세션에서만 되므로 2단계다.
 *   1) 세션에서 get_card_approvals 응답을 **그대로** 파일로 저장 (적재 절차와 같은 형식.
 *      여러 페이지면 배열 `[{page0}, {page1}, …]`)
 *   2) node scripts/card-ingest-verify.mjs <clobe.json> [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *
 *   --from/--to 를 안 주면 파일 안 승인일의 최소~최대를 자동으로 쓴다.
 *   불일치가 있으면 exit 1 — 스케줄 태스크가 이걸 보고 요약에 남기면 된다.
 *   ⚠ exit code 로 판정하므로 이 파일에서는 fetch 이후 process.exit() 을 쓰지 않는다(아래 주석).
 *
 * 한계(정직하게):
 *   · 클로브 응답이 있어야 돈다. 이 스크립트 혼자서는 원본을 못 가져온다.
 *   · 페이지를 덜 받아온 파일을 주면 그만큼이 '누락' 으로 잡힌다 — totalElements 를 같이
 *     검사해 그 경우를 구분해 알린다.
 */

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const FROM = opt('--from'), TO = opt('--to');
/* ⚠ --from/--to 의 '값' 도 '--' 로 시작하지 않으므로 파일 목록에서 빼야 한다.
   안 그러면 날짜 문자열을 파일로 열려다 ENOENT 로 죽는다. */
const taken = new Set(['--from', '--to'].flatMap(k => { const i = args.indexOf(k); return i >= 0 ? [i, i + 1] : []; }));
const files = args.filter((a, i) => !a.startsWith('--') && !taken.has(i));
if (!files.length) {
  console.error('사용법: node scripts/card-ingest-verify.mjs <clobe.json> [--from YYYY-MM-DD] [--to YYYY-MM-DD]');
  process.exit(1);
}

const PK = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const SECRET_PATH = 'C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret';
const ENDPOINT = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/card-ingest';

const won = n => Math.round(Number(n) || 0).toLocaleString('ko-KR');
const day = s => String(s || '').slice(0, 10);

/* ── 클로브 응답 읽기 ─────────────────────────────────────────────── */
let pages = [];
for (const f of files) {
  const j = JSON.parse(readFileSync(f, 'utf8'));
  pages.push(...(Array.isArray(j) ? j : [j]));
}
const clobeRows = pages.flatMap(p => Array.isArray(p?.content) ? p.content : []);
if (!clobeRows.length) { console.error('클로브 승인내역이 비어 있습니다.'); process.exit(1); }

/* 페이지 누락 검사 — totalElements 는 같은 질의의 페이지들끼리만 비교 의미가 있다.
   여러 질의를 한 파일에 섞었으면 이 검사는 못 하므로 건너뛴다(그때는 합계 대조로 본다). */
const totals = [...new Set(pages.map(p => Number(p?.totalElements)).filter(Boolean))];
const sameQuery = totals.length === 1;
const dedup = new Map();
for (const r of clobeRows) dedup.set(String(r.approvalId), r);
if (sameQuery && dedup.size !== totals[0]) {
  console.error(`⚠ 클로브 파일이 불완전합니다 — ${dedup.size}건 ≠ totalElements ${totals[0]}.`);
  console.error('  페이지를 끝까지 받아 다시 저장하세요. 이대로 돌리면 덜 받은 만큼이 "누락"으로 잡힙니다.\n');
}

const dates = [...dedup.values()].map(r => day(r.usedAt)).filter(Boolean).sort();
const from = FROM || dates[0];
const to   = TO   || dates[dates.length - 1];

/* 취소(순액 0)는 우리가 일부러 안 넣으므로 대조 대상에서 뺀다 */
const valid = new Map();
let cancelled = 0;
for (const [id, r] of dedup) {
  const net = Number(r.remainingUsedAmountKrw ?? r.usedAmountKrw) || 0;
  if (day(r.usedAt) < from || day(r.usedAt) > to) continue;
  if (net === 0) { cancelled++; continue; }
  valid.set(id, { net, date: day(r.usedAt), card: String(r.cardNo || ''), store: String(r.memberStoreName || '').trim() });
}

/* ── 우리 적재분 읽기 ─────────────────────────────────────────────── */
/* ⚠ 여기부터는 process.exit() 을 쓰지 않는다 — fetch 의 keep-alive 소켓이 닫히는 중에
   process.exit 하면 libuv assertion(win/async.c:94)으로 죽어 종료코드가 127 이 된다.
   출력은 이미 다 찍힌 뒤라 결과는 멀쩡해 보이는데 종료코드만 127 이라, **불일치 여부를
   exit code 로 판정하는 스케줄 태스크가 늘 '실패' 로 읽는다**(2026-09-16 발견).
   대신 process.exitCode 를 세팅하고 자연 종료시킨다(clobe-card-inspect.mjs 와 같은 방식).
   ⚠⚠ 단 exitCode 는 실행을 **멈추지 않는다.** cf-clobeid-backfill.mjs 에서 같은 이유로
   process.exit 을 지웠다가 조기 종료가 사라져 dry-run 이 쓰기를 해버린 사고가 있었다
   (2026-08-22). 반드시 분기로 뒤 코드를 막을 것 — 아래 else 가 그 역할이다.
   위쪽 인자·빈파일 검사는 fetch 전이라 process.exit 그대로 둬도 안전하다. */
const secret = readFileSync(SECRET_PATH, 'utf8').trim();
const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: PK, Authorization: `Bearer ${PK}` },
  body: JSON.stringify({ secret, inspect: { from, to } }),
});
const text = await res.text();
if (!text.trim().startsWith('{')) {
  console.error(`조회 실패 HTTP ${res.status}`);
  process.exitCode = 1;
} else {
  const ourRows = JSON.parse(text).rows || [];
  const ours = new Map(ourRows.map(r => [String(r.approval_id), {
    net: Number(r.billing_amount) || 0, date: day(r.use_date), card: String(r.card_no || ''),
  }]));

  /* ── 대조 ─────────────────────────────────────────────────────────── */
  const missing = [], mismatch = [], ghost = [];
  for (const [id, c] of valid) {
    const o = ours.get(id);
    if (!o) { missing.push({ id, ...c }); continue; }
    if (Math.round(o.net) !== Math.round(c.net)) mismatch.push({ id, ...c, oursNet: o.net });
  }
  for (const [id, o] of ours) if (!valid.has(id)) ghost.push({ id, ...o });

  const cSum = [...valid.values()].reduce((s, r) => s + r.net, 0);
  const oSum = ourRows.reduce((s, r) => s + (Number(r.billing_amount) || 0), 0);

  console.log('=== 법인카드 적재 대조 ===');
  console.log(`기간 ${from} ~ ${to}`);
  console.log(`클로브 유효 ${valid.size}건 ${won(cSum)}원 (취소 제외 ${cancelled}건)`);
  console.log(`우리   적재 ${ourRows.length}건 ${won(oSum)}원`);
  console.log(`차액        ${won(cSum - oSum)}원\n`);

  const show = (label, arr, fmt) => {
    if (!arr.length) { console.log(`✅ ${label} 없음`); return; }
    const sum = arr.reduce((s, r) => s + Math.abs(fmt.amt(r)), 0);
    console.log(`❌ ${label} ${arr.length}건 ${won(sum)}원`);
    for (const r of arr.sort((a, b) => Math.abs(fmt.amt(b)) - Math.abs(fmt.amt(a))).slice(0, 30))
      console.log(`     ${r.date}  ${String(r.card).padEnd(20)} ${fmt.line(r)}`);
    if (arr.length > 30) console.log(`     … 외 ${arr.length - 30}건`);
  };
  /* 오늘자 누락은 정상이다 — 적재가 당일분을 일부러 뺀다('가승인'류가 몇 시간 뒤 전액취소되는
     일이 잦아 당일 사용액이 과대계상된다). 하루 지나면 취소가 반영된 순액으로 들어온다.
     ⚠ 기준을 적재 쪽과 **똑같이** 맞춘다. clobe-card-ingest.mjs 는 KST 기준 `dateOf < today`,
     즉 오늘 '이후' 를 통째로 빼므로 여기서도 `>= today` 를 눈감아 준다. `=== today` 로 쓰면
     미래 일자 승인(해외 결제 시차 등) 한 건에 대조가 실패한다.
     ⚠ 눈감아 주는 건 '누락' 뿐이다 — 금액 불일치·유령은 날짜와 무관하게 그대로 잡는다.
     --allow-today 로 적재했다면 애초에 누락이 안 잡히니 이 분기는 그냥 지나간다. */
  const todayKST    = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const skipped     = missing.filter(r => r.date >= todayKST);
  const realMissing = missing.filter(r => r.date <  todayKST);

  show('누락(클로브에만)', realMissing, {
    amt: r => r.net,
    line: r => `${won(r.net).padStart(11)}  ${r.store.slice(0, 30)}  [${r.id}]`,
  });
  if (skipped.length) {
    const sum = skipped.reduce((s, r) => s + r.net, 0);
    console.log(`ℹ 누락 ${skipped.length}건 ${won(sum)}원은 오늘(${todayKST}) 이후 승인분 — 적재가 당일분을 일부러 뺀 것이라 정상입니다.`);
    console.log(`   위 '차액' ${won(sum)}원이 이것입니다. 날짜가 지난 뒤 다시 돌리면 취소 반영된 순액으로 들어옵니다.`);
  }
  show('금액 불일치', mismatch, {
    amt: r => r.net - r.oursNet,
    line: r => `우리 ${won(r.oursNet).padStart(10)} vs 클로브 ${won(r.net).padStart(10)}  ${r.store.slice(0, 24)}  [${r.id}]`,
  });
  show('유령(우리에만)', ghost, {
    amt: r => r.net,
    line: r => `${won(r.net).padStart(11)}  [${r.id}]  ← 수기 업로드분이면 정상`,
  });

  if (realMissing.length || mismatch.length) {
    console.log('\n조치:');
    if (realMissing.length)  console.log('  · 누락 → 그 기간 클로브 응답을 저장해 scripts/clobe-card-ingest.mjs 로 적재');
    if (mismatch.length) console.log('  · 금액 불일치 → 해외 결제 환율 확정분. 현재 적재 스크립트는 중복이면 건너뛰어 금액을 안 고친다.');
    process.exitCode = 1;
  } else {
    console.log('\n대조 통과 — 누락·불일치 없음.');
  }
}

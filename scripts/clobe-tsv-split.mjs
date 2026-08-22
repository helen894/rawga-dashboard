#!/usr/bin/env node
/**
 * clobe-tsv-split.mjs — 여러 날짜가 섞인 클로브 거래를 **하루 단위 파일**로 쪼갠다.
 *
 * 왜 필요한가 (2026-08-22):
 *   clobe-cf-ingest.mjs 는 반드시 하루 단위 파일을 받아야 한다(외화 환율을 그날 잔차에서
 *   역산하므로 여러 날을 섞으면 깨진다). 그런데 1~2월 462건을 하루씩 34번 조회하면
 *   비용이 크다. 그래서 주 단위로 받아 여기서 쪼갠다.
 *
 * ⚠⚠ 쓸 수 있는 조건 — **외화계좌(56034·145016) 거래가 없는 구간에만** 쓴다.
 *   적재 스크립트의 행-누락 방어선은 "API 합계 vs 원화계좌 합계 잔차" 다. 이 스크립트는
 *   per-day 합계를 **행에서 직접 계산**하므로, 외화가 없는 날은 잔차가 0 이 되어 검사가
 *   자동 통과한다(원화만 있으니 실제로 0 이 맞다 — 정보를 잃는 게 아니다).
 *   외화가 섞인 날은 API 의 per-day 원화 합계가 있어야 환율을 역산할 수 있으므로,
 *   **그 날짜는 반드시 개별 조회**해서 원본 응답을 그대로 써야 한다.
 *   이 스크립트는 외화계좌 id 가 보이면 중단한다.
 *
 * 대신 이 스크립트가 지키는 검증 (전사 오류를 잡는 게 목적):
 *   · 입력 행수 == --total (조회 응답의 totalElements)
 *   · Σ per-day 입금 == --in,  Σ per-day 출금 == --out  (조회 응답의 구간 합계)
 *   두 검사가 통과하면 내가 손으로 옮겨 적는 과정에서 행을 빠뜨리거나 금액을 틀리지 않았다는 뜻이다.
 *
 * 입력 TSV (헤더 없음, 탭 구분):
 *   transactionId \t accountId \t YYYY-MM-DDTHH:MM:SS \t inAmount \t outAmount \t 적요 \t 거래처라벨
 *
 * 쓰는 법:
 *   node scripts/clobe-tsv-split.mjs <in.tsv> --outdir <dir> --prefix clobe-cf- \
 *        --total 73 --in 1295085116 --out 982047699
 */

import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const FILE = argv.find((a) => !a.startsWith('--') && argv.indexOf(a) === 0) || argv.find((a) => a.endsWith('.tsv'));
const OUTDIR = opt('--outdir'), PREFIX = opt('--prefix') || 'clobe-cf-';
const TOTAL = Number(opt('--total')), IN_SUM = Number(opt('--in')), OUT_SUM = Number(opt('--out'));
if (!FILE || !OUTDIR || !Number.isFinite(TOTAL) || !Number.isFinite(IN_SUM) || !Number.isFinite(OUT_SUM)) {
  console.error('사용법: node scripts/clobe-tsv-split.mjs <in.tsv> --outdir <dir> [--prefix clobe-cf-] --total N --in N --out N');
  process.exit(1);
}
const FX_ACCOUNTS = new Set(['56034', '145016']);          // accountType=FX. 목록이 바뀌면 여기도 고칠 것
const won = (n) => Math.round(n).toLocaleString('ko-KR');

const lines = readFileSync(FILE, 'utf8').split(/\r?\n/).filter((l) => l.trim());
const rows = [];
for (const [i, l] of lines.entries()) {
  const p = l.split('\t');
  if (p.length < 5) { console.error(`${i + 1}행: 열이 부족합니다 — ${l.slice(0, 60)}`); process.exit(1); }
  const [id, acct, ts, inA, outA, desc = '', be = ''] = p;
  if (FX_ACCOUNTS.has(String(acct).trim())) {
    console.error(`❌ ${i + 1}행에 외화계좌(${acct}) 거래가 있습니다 — 이 스크립트로 쪼개면 환율 역산이 깨집니다.`);
    console.error('   그 날짜는 get_labeled_transactions 로 개별 조회해 원본 응답을 그대로 쓰세요.');
    process.exit(1);
  }
  rows.push({ transactionId: String(id).trim(), accountId: Number(acct), transactionAt: String(ts).trim(),
              inAmount: Number(inA), outAmount: Number(outA),
              transactionName: '', transactionType: '', transactionDescription: desc.trim(),
              accountName: '', bankName: '', category: '', businessEntityName: be.trim(), memo: null });
}
/* transactionId 중복 제거 — 라벨이 여럿이면 같은 거래가 여러 행으로 온다 */
const uniq = new Map();
for (const r of rows) uniq.set(r.transactionId, r);
const all = [...uniq.values()];

const gotIn = all.reduce((s, r) => s + r.inAmount, 0);
const gotOut = all.reduce((s, r) => s + r.outAmount, 0);
let bad = false;
const chk = (name, got, want) => {
  const ok = Math.abs(got - want) < 1;
  if (!ok) bad = true;
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(12)} ${won(got).padStart(16)}  (기대 ${won(want)})`);
};
console.log('=== 전사 검증 ===');
chk('행수', all.length, TOTAL);
chk('입금 합', gotIn, IN_SUM);
chk('출금 합', gotOut, OUT_SUM);
if (rows.length !== all.length) console.log(`   (transactionId 중복 ${rows.length - all.length}건 제거)`);
if (bad) { console.error('\n검증 실패 — 옮겨 적는 과정에서 행이 빠졌거나 금액이 틀렸습니다. 파일을 고쳐 다시 실행하세요.'); process.exit(1); }

/* 날짜별로 쪼개 저장 */
const byDay = new Map();
for (const r of all) {
  const d = r.transactionAt.slice(0, 10);
  if (!byDay.has(d)) byDay.set(d, []);
  byDay.get(d).push(r);
}
console.log('\n=== 하루 단위 파일 ===');
for (const d of [...byDay.keys()].sort()) {
  const rs = byDay.get(d);
  const i = rs.reduce((s, r) => s + r.inAmount, 0), o = rs.reduce((s, r) => s + r.outAmount, 0);
  const path = `${OUTDIR}/${PREFIX}${d.replace(/-/g, '')}.json`;
  writeFileSync(path, JSON.stringify({ content: rs, totalElements: rs.length, hasNext: false,
    inAmountSumKrw: i, outAmountSumKrw: o, totalAmountSumKrw: i - o }));
  console.log(`  ${d}  ${String(rs.length).padStart(3)}건  입금 ${won(i).padStart(15)}  출금 ${won(o).padStart(15)}`);
}
console.log(`\n${byDay.size}개 파일 저장 — ${OUTDIR}`);

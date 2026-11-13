#!/usr/bin/env node
/**
 * test-clobe-validate.mjs — 검증 모듈의 **중단 조건 6개**를 합성 데이터로 건다.
 *
 * 왜 따로 있는가 (2026-11-13)
 *   동치 테스트(test-clobe-ingest-parity)는 실데이터 10건으로 돌리는데 **전부 정상 경로**다.
 *   정상만 맞춰서는 "가드가 살아 있는지" 를 증명하지 못한다. 가드는 전부 사고 뒤에 붙은
 *   것이라(외화 원금이 원화로 섞임 · 계좌 단위 행 누락 · 페이지 누락 …) 여기서 일부러 깨뜨려
 *   정확히 그 코드로 멈추는지 본다. 옛 스크립트도 같은 입력에 이의를 제기하는지 함께 확인한다.
 *
 * 쓰는 법: node scripts/test-clobe-validate.mjs
 */
import { validateClobe } from '../supabase/functions/cf-clobe-ingest/clobe-validate.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TODAY = '2026-11-13';
const OLD = process.env.OLD_INGEST || join(tmpdir(), 'old-ingest.mjs');

/* 거래 한 건. accountId 가 외화 화이트리스트에 있으면 금액은 통화 원금이다. */
const tx = (o = {}) => ({
  transactionId: o.id ?? Math.random().toString(36).slice(2),
  transactionAt: o.at ?? '2026-11-10T10:00:00',
  accountId: o.acc ?? 1001,
  accountName: o.accName ?? '기업은행 주거래',
  accountNumber: o.accNo ?? '1234567890',
  businessEntityName: o.desc ?? '테스트거래처',
  transactionDescription: o.desc ?? '테스트거래처',
  inAmount: o.in ?? 0,
  outAmount: o.out ?? 0,
});
const page = (rows, o = {}) => ({
  content: rows,
  totalElements: o.total ?? rows.length,
  inAmountSumKrw: o.expIn ?? rows.reduce((s, r) => s + (r.inAmount || 0), 0),
  outAmountSumKrw: o.expOut ?? rows.reduce((s, r) => s + (r.outAmount || 0), 0),
});
const base = { today: TODAY, fxAccounts: {}, fxRef: 0, fxRefAsOf: null };

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = got === want;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : `   got=${got} want=${want}`}`);
  ok ? pass++ : fail++;
};
/* 옛 스크립트도 같은 입력에 이의를 제기하는가 — dry-run 은 중단하지 않고 경고만 찍는다.
   ⚠⚠ 옛 스크립트는 --fx-accounts / --fx-ref 를 받으면 **운영 캐시 파일을 덮어쓴다**.
     테스트 값이 들어가면 다음 실제 적재의 외화 판정과 환율 밴드가 틀어진다.
     그래서 호출 전후로 캐시를 백업·복원한다. (여기서 한 번 실수하면 내일 아침 적재가 깨진다) */
const CACHES = ['C:/Users/RAWGA/AppData/Local/rawga/fx-accounts.json',
                'C:/Users/RAWGA/AppData/Local/rawga/fx-ref-rate.json'];
const oldObjects = (pages, extraArgs = []) => {
  if (!existsSync(OLD)) return null;
  const saved = CACHES.map(p => (existsSync(p) ? readFileSync(p) : null));
  try {
    const f = join(tmpdir(), `clobe-guard-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, JSON.stringify(pages));
    let out = '';
    try {
      out = execFileSync(process.execPath, [OLD, f, '--dry-run', ...extraArgs],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
    return /⚠/.test(out);
  } finally {
    CACHES.forEach((p, i) => { if (saved[i] !== null) writeFileSync(p, saved[i]); else if (existsSync(p)) unlinkSync(p); });
  }
};

console.log('중단 조건 6종\n');

// ① 페이지 누락 — dedupe 후 건수 ≠ totalElements
{
  const p = page([tx({ id: 'a', in: 1000 })], { total: 5 });
  t('COUNT_MISMATCH', validateClobe({ ...base, pages: p }).abort?.code, 'COUNT_MISMATCH');
  t('  옛 스크립트도 이의', oldObjects(p), true);
}
// ② 라벨 다중으로 같은 거래가 여러 행 → dedupe 되어 통과해야 한다
{
  const rows = [tx({ id: 'dup', in: 1000 }), tx({ id: 'dup', in: 1000 })];
  const r = validateClobe({ ...base, pages: page(rows, { total: 1, expIn: 1000, expOut: 0 }) });
  t('중복 transactionId 는 dedupe 되어 통과', r.abort, null);
  t('  행 1건만 남음', r.rows.length, 1);
}
// ③ 화이트리스트에 없는 외화계좌 (새 계좌가 열림)
{
  const p = page([tx({ id: 'a', in: 1000, acc: 1001 }), tx({ id: 'b', in: 500, acc: 9999, accName: '외화보통예금' })]);
  const r = validateClobe({ ...base, pages: p, fxAccounts: { 1001: 'USD' } });
  t('FX_STRAY_ACCOUNT', r.abort?.code, 'FX_STRAY_ACCOUNT');
  t('  옛 스크립트도 이의', oldObjects(p, ['--fx-accounts', '1001:USD']), true);
}
// ④ 외화 통화 혼재 — 단일 환율 모델이 깨진다
{
  const p = page([tx({ id: 'a', in: 100, acc: 1 }), tx({ id: 'b', in: 200, acc: 2 })]);
  t('FX_MIXED_CURRENCY', validateClobe({ ...base, pages: p, fxAccounts: { 1: 'USD', 2: 'EUR' } }).abort?.code, 'FX_MIXED_CURRENCY');
}
// ⑤ 한쪽만 빠진 행 누락 — API 합계 잔차가 환율 밴드 밖
{
  //   원화 입금 1,000 인데 API 는 9,000,000 이라고 한다. 외화 1 USD 로 설명하려면 환율이
  //   말도 안 되는 값이어야 하므로 밴드에서 걸려야 한다.
  const p = page([tx({ id: 'a', in: 1000, acc: 1001 }), tx({ id: 'f', in: 1, acc: 5000 })],
                 { expIn: 9_000_000, expOut: 0 });
  const r = validateClobe({ ...base, pages: p, fxAccounts: { 5000: 'USD' }, fxRef: 1400, fxRefAsOf: TODAY });
  t('SUM_MISMATCH', r.abort?.code, 'SUM_MISMATCH');
  t('  옛 스크립트도 이의', oldObjects(p, ['--fx-accounts', '5000:USD', '--fx-ref', '1400']), true);
}
// ⑥ 취소 레그 과대 — 계좌 하나가 통째로 빠진 피드 장애 의심
{
  //   행은 1,000 뿐인데 API 합계는 입·출금 양쪽 다 50,000,000 — 공통분 c 가 총액의 100%.
  const p = page([tx({ id: 'a', in: 1000, out: 0, acc: 1001 })], { expIn: 50_000_000, expOut: 49_999_000 });
  const r = validateClobe({ ...base, pages: p });
  t('LARGE_CANCEL', r.abort?.code, 'LARGE_CANCEL');
  const r2 = validateClobe({ ...base, pages: p, allowLargeCancel: true });
  t('  allowLargeCancel 로 통과', r2.abort, null);
}
// ⑦ 오늘자 제외 (스냅샷 불완전 방어)
{
  const p = page([tx({ id: 'y', in: 1000, at: '2026-11-12T10:00:00' }),
                  tx({ id: 't', in: 2000, at: `${TODAY}T10:00:00` })]);
  t('오늘자는 기본 제외', validateClobe({ ...base, pages: p }).rows.length, 1);
  t('  allowToday 로 포함', validateClobe({ ...base, pages: p, allowToday: true }).rows.length, 2);
}
// ⑧ today 를 안 넘기면 거부 — 런타임 시계를 모듈이 읽지 않는다는 계약
{
  t('today 미지정이면 거부', validateClobe({ pages: page([tx({ in: 1 })]) }).abort?.code, 'NO_TODAY');
}
// ⑨ 외화 환산 — 역산 환율로 원화 적재 + fx_usd 원금 보존
{
  //   원화 입금 1,000 · 외화 입금 10 USD. API 입금합계 = 1,000 + 10×1,400 = 15,000
  const p = page([tx({ id: 'k', in: 1000, acc: 1001 }), tx({ id: 'f', in: 10, acc: 5000, accName: '외화보통예금' })],
                 { expIn: 15_000, expOut: 0 });
  const r = validateClobe({ ...base, pages: p, fxAccounts: { 5000: 'USD' }, fxRef: 1400, fxRefAsOf: TODAY });
  t('외화 환산 통과', r.abort, null);
  const fx = r.rows.find(x => x.fx_usd);
  t('  환산 원화액', fx?.in, 14000);
  t('  외화 원금 보존(fx_usd)', fx?.fx_usd, 10);
}

console.log(`\n${fail ? '❌' : '✅'} ${pass}/${pass + fail} 통과`);
process.exit(fail ? 1 : 0);

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
 *
 * 기준(옛) 스크립트는 **git 에서 꺼내 쓴다** — 바꾸려면 BASE_REF=<ref>, 직접 지정하려면
 * OLD_INGEST=<경로>.
 *   ⚠ 2026-11-23 수정: 전에는 OS 임시폴더의 old-ingest.mjs 가 **이미 있다고 가정**했다.
 *     주말에 윈도우가 임시폴더를 비우자 3건이 got=null 로 깨졌다. 테스트가 틀려서가 아니라
 *     기준본이 사라져서였는데, 화면에는 똑같이 ❌ 로 보인다 — 이런 실패가 쌓이면
 *     '원래 빨간 것' 으로 분류되고 진짜 고장이 묻힌다(2026-11-20 에 4건이 그래서 방치됐다).
 *     동치 테스트(test-clobe-ingest-parity)가 쓰던 git 조달 방식으로 맞춘다.
 */
import { validateClobe } from '../supabase/functions/cf-clobe-ingest/clobe-validate.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TODAY = '2026-11-13';

/* 기준 커밋 = 검증을 clobe-validate.mjs 로 분리하기 **직전**. 그 뒤 커밋을 쓰면 옛
   스크립트가 모듈을 상대경로로 import 하는데 임시폴더엔 그게 없어 통째로 빈 출력이 된다
   (동치 테스트가 2026-11-13~20 에 그래서 7일간 죽어 있었다). */
const BASE_REF = process.env.BASE_REF || '2e5f3d9';
const OLD = process.env.OLD_INGEST
  || join(tmpdir(), `clobe-validate-base-${BASE_REF.replace(/[^\w.-]/g, '_')}.mjs`);

/* 없으면 git 에서 꺼내 만든다 — 임시폴더는 언제든 비워진다고 가정한다. */
if (!existsSync(OLD)) {
  try {
    writeFileSync(OLD, execFileSync('git', ['show', `${BASE_REF}:scripts/clobe-cf-ingest.mjs`],
      { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1') }));
  } catch (e) {
    console.error(`❌ 기준 스크립트를 git 에서 못 꺼냈습니다 (BASE_REF=${BASE_REF}): ${e.message}`);
    console.error('   OLD_INGEST=<경로> 로 직접 지정하거나 BASE_REF 를 바꾸세요.');
    process.exit(1);
  }
}

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
  /* 위에서 조달을 보장했다. 그래도 없으면 **조용히 null 을 돌려주지 않는다** —
     null 은 '기준본 없음' 과 '옛 스크립트가 이의 없음' 을 겸해서 원인을 가린다. */
  if (!existsSync(OLD)) throw new Error('기준 스크립트가 사라졌습니다: ' + OLD);
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

/* ⑩ 환율 밴드 문구 — 세 갈래 (2026-11-20)
   종전엔 외화가 0건인 날에도 '기준환율 없음' 경고가 떴다. 외화 없는 날이 대부분이라
   경고가 일상이 됐고, 그러면 **외화는 있는데 환율이 없는** 진짜 경우가 같은 문구에 묻힌다.
   세 경우가 서로 다른 말을 하는지 고정한다. 하나라도 합쳐지면 다시 묻히기 시작한다. */
{
  const krwOnly = page([tx({ id: 'a', in: 1000, acc: 1001 }), tx({ id: 'b', out: 400, acc: 1001 })]);

  const noFx = validateClobe({ ...base, pages: krwOnly, fxRef: 1400, fxRefAsOf: TODAY });
  t('외화 0건이면 경고가 아니다', /^외화 거래 없음/.test(noFx.report.bandNote || ''), true);
  t('  경고 표시(⚠)가 붙지 않는다', (noFx.report.bandNote || '').includes('⚠'), false);
  t('  fxCount 0 — 출력부가 밴드 줄을 접는 근거', noFx.report.fxCount, 0);

  /* 외화가 있는데 기준환율이 없다 — 이때만 진짜 경고 */
  const pFx = page([tx({ id: 'k', in: 1000, acc: 1001 }), tx({ id: 'f', in: 10, acc: 5000, accName: '외화보통예금' })],
                   { expIn: 15_000, expOut: 0 });
  const fxNoRef = validateClobe({ ...base, pages: pFx, fxAccounts: { 5000: 'USD' }, fxRef: 0 });
  t('외화는 있고 환율이 없으면 경고', (fxNoRef.report.bandNote || '').includes('⚠'), true);
  t('  몇 건인지 밝힌다', /외화 1건/.test(fxNoRef.report.bandNote || ''), true);

  /* 외화 + 기준환율 → 밴드 문구 */
  const fxWithRef = validateClobe({ ...base, pages: pFx, fxAccounts: { 5000: 'USD' }, fxRef: 1400, fxRefAsOf: TODAY });
  t('외화 + 환율이면 밴드를 적는다', /^기준 1400\.00원 ±5%/.test(fxWithRef.report.bandNote || ''), true);
  t('  이 경우에도 ⚠ 는 없다', (fxWithRef.report.bandNote || '').includes('⚠'), false);
  t('  fxCount 가 실제 외화 건수', fxWithRef.report.fxCount, 1);
}

console.log(`\n${fail ? '❌' : '✅'} ${pass}/${pass + fail} 통과`);
process.exit(fail ? 1 : 0);

/**
 * clobe-validate — 클로브 거래내역 검증·변환 (순수 함수, I/O 없음)
 *
 * ⚠⚠ **이 파일이 단일 출처다.** 로컬 스크립트(scripts/clobe-cf-ingest.mjs)와
 *   Edge 함수(index.ts) 가 **같은 이 파일을 import** 한다. 사본을 만들지 말 것 —
 *   이 저장소는 메일 HTML 을 두 벌로 둔 탓에 숫자가 갈리는 사고를 반복해서 겪었다
 *   (rawga-weekly-email 메모 참고). 검증은 그보다 더 갈리면 안 되는 곳이다.
 *
 * ⚠ 여기서 막는 것들은 전부 **실제로 터진 뒤** 하나씩 붙인 가드다. 느슨하게 고치지 말 것:
 *   · 라벨 다중으로 같은 거래가 여러 행 → transactionId dedupe
 *   · 페이지 누락 → totalElements 대조
 *   · 새 외화계좌가 열려 USD 원금이 원화로 섞임 → 화이트리스트 + 계좌명 트립와이어
 *   · 두 통화 섞임 → 단일 환율 모델이 깨지므로 중단
 *   · 한쪽만 빠진 행 누락 → API 합계 잔차에서 환율 역산 + 밴드 검사
 *   · 계좌 하나가 통째 빠진 피드 장애 → 취소 레그 규모 상한
 *
 * Deno(Edge)·Node(로컬) 양쪽에서 돌아야 하므로 **런타임 API 를 쓰지 않는다**
 *   (fs·fetch·process·Deno 전부 금지). 날짜·환율·화이트리스트는 호출부가 넘긴다.
 */

export const TOL = 1;                                  // 원 단위 반올림 오차
export const C_STOP_RATIO = 0.50, C_STOP_ABS = 10_000_000;
export const FX_TOL = 0.05, FX_TOL_STALE = 0.10, STALE_DAYS = 14;
export const RATE_MIN_WIDE = 100, RATE_MAX_WIDE = 5000;

const num = (v) => Number(v) || 0;
const sumOf = (a, k) => a.reduce((s, r) => s + num(r[k]), 0);
const dateOf = (r) => String(r.transactionAt || '').slice(0, 10);
const looksFx = (r) => /외화|수출입|FX/i.test(String(r.accountName || ''));

/**
 * @param {object} inp
 *   pages            클로브 응답(배열 또는 단건). { content[], totalElements, inAmountSumKrw, outAmountSumKrw }
 *   fxAccounts       { "56034": "USD", ... }  accountType==='FX' 인 계좌. 비어 있으면 계좌명으로만 판정(약함)
 *   fxRef            기준환율(원/통화). 0 이면 넓은 밴드 + 경고
 *   fxRefAsOf        'YYYY-MM-DD' 기준환율 기준일(캐시 노후 판정용). 없으면 오래된 것으로 본다
 *   today            'YYYY-MM-DD' KST 오늘. **호출부가 반드시 넘긴다** (런타임 시계를 여기서 읽지 않는다)
 *   allowToday       true 면 오늘자도 적재
 *   allowLargeCancel true 면 취소 레그 규모 상한을 통과시킨다
 * @returns {{abort:null|{code,message,detail}, warnings:string[], notes:string[],
 *            rows:object[], report:object}}
 */
export function validateClobe(inp) {
  const pages = Array.isArray(inp.pages) ? inp.pages : [inp.pages];
  const fxAccounts = new Map(Object.entries(inp.fxAccounts || {}).map(([k, v]) => [String(k), String(v).toUpperCase()]));
  const fxRef = num(inp.fxRef);
  const today = String(inp.today || '');
  const allowToday = !!inp.allowToday;
  const allowLargeCancel = !!inp.allowLargeCancel;
  const warnings = [], notes = [];
  const fail = (code, message, detail) => ({ abort: { code, message, detail: detail ?? null }, warnings, notes, rows: [], report });

  const report = {};
  if (!today) return fail('NO_TODAY', 'today(YYYY-MM-DD)를 넘기지 않았습니다. 런타임 시계를 쓰지 않는 설계라 호출부가 반드시 지정해야 합니다.');

  /* ── 1) 파싱 ── */
  const rowsRaw = pages.flatMap((p) => (Array.isArray(p?.content) ? p.content : []));
  const totalElements = pages.reduce((s, p) => s + num(p?.totalElements), 0);
  const expIn = pages.reduce((s, p) => s + num(p?.inAmountSumKrw), 0);
  const expOut = pages.reduce((s, p) => s + num(p?.outAmountSumKrw), 0);
  if (!rowsRaw.length) return fail('NO_ROWS', '거래 행이 없습니다.');

  /* ── 2) transactionId dedupe (라벨 다중 → 행 복제 방지) ── */
  const byId = new Map();
  for (const r of rowsRaw) {
    const id = String(r.transactionId);
    if (!byId.has(id)) byId.set(id, r);          // 첫 행의 category 를 대표로
  }
  const uniq = [...byId.values()];
  Object.assign(report, { rawCount: rowsRaw.length, uniqCount: uniq.length,
                          dupRemoved: rowsRaw.length - uniq.length, totalElements, expIn, expOut });

  if (totalElements && uniq.length !== totalElements) {
    return fail('COUNT_MISMATCH',
      `dedupe 후 ${uniq.length}건인데 totalElements 는 ${totalElements}건입니다 — 페이지 누락이 의심됩니다.`,
      { uniq: uniq.length, totalElements });
  }

  /* ── 3) 외화 계좌 분리 ── */
  const isFx = (r) => (fxAccounts.size ? fxAccounts.has(String(r.accountId)) : looksFx(r));
  const fxRows = uniq.filter(isFx);
  const krwRows = uniq.filter((r) => !isFx(r));

  if (fxAccounts.size) {
    /* 목록에 없는데 이름이 외화계좌처럼 생긴 행 = 새 계좌가 열렸다.
       그냥 두면 USD 원금이 원화로 섞여 조용히 망가지므로 멈춘다. */
    const strays = uniq.filter((r) => !fxAccounts.has(String(r.accountId)) && looksFx(r));
    if (strays.length) {
      const seen = [...new Map(strays.map((r) => [String(r.accountId), r])).values()]
        .map((r) => ({ accountId: String(r.accountId), accountName: String(r.accountName || '') }));
      return fail('FX_STRAY_ACCOUNT',
        `화이트리스트에 없는 외화계좌로 보이는 거래 ${strays.length}건 — 새 외화계좌가 열렸는지 확인하세요. ` +
        'get_bank_accounts 에서 accountType=FX 계좌를 다시 뽑아 넘겨야 합니다. (원화로 섞이면 USD 원금이 원화 금액으로 적재됩니다.)',
        { accounts: seen });
    }
    const curs = [...new Set(fxRows.map((r) => fxAccounts.get(String(r.accountId))))];
    if (curs.length > 1) {
      return fail('FX_MIXED_CURRENCY',
        `외화 거래의 통화가 ${curs.join('·')} 로 섞여 있습니다 — 단일 환율로 환산할 수 없습니다. 통화별로 나눠 각각의 기준환율로 적재하세요.`,
        { currencies: curs });
    }
  } else if (fxRows.length) {
    warnings.push('외화계좌 화이트리스트 없음 — 계좌명(/외화|수출입|FX/)으로만 판정했습니다. fxAccounts 를 넘기는 편이 안전합니다.');
  }

  /* ── 4) 환율 밴드 ──
     ⚠ 밴드는 **외화 행이 있을 때만** 뜻이 있다. 외화가 0건이면 검사할 환율 자체가 없으므로
       '기준환율 없음' 은 경고가 아니라 틀린 말이다. 종전엔 이 경우에도 같은 경고가 떠서
       외화 없는 날(= 대부분의 날)마다 울렸고, 그러면 **정작 외화가 있는데 환율이 없는 날**의
       같은 문구가 그 소음에 묻힌다. 2026-11-20 주간 검산이 실제로 이 경고를 보고
       "왜 뜨는지 모르겠다" 고 남겼다. 세 경우를 갈라 적는다. */
  let RATE_MIN = RATE_MIN_WIDE, RATE_MAX = RATE_MAX_WIDE;
  let bandNote;
  if (!fxRows.length) {
    bandNote = '외화 거래 없음 — 환율 검사 해당 없음';
  } else if (fxRef > 0) {
    const asOf = inp.fxRefAsOf ? String(inp.fxRefAsOf) : null;
    const age = asOf ? Math.round((Date.parse(today) - Date.parse(asOf)) / 864e5) : 9999;
    const tol = age > STALE_DAYS ? FX_TOL_STALE : FX_TOL;
    RATE_MIN = fxRef * (1 - tol);
    RATE_MAX = fxRef * (1 + tol);
    bandNote = `기준 ${fxRef.toFixed(2)}원 ±${(tol * 100).toFixed(0)}%` + (asOf ? ` · 기준일 ${asOf}${age > STALE_DAYS ? ` (${age}일 경과라 밴드 완화)` : ''}` : '');
  } else {
    bandNote = `⚠ 외화 ${fxRows.length}건이 있는데 기준환율이 없습니다 — 행 누락 감지가 약합니다`;
  }

  /* ── 5) 합계 교차검증 + 환율 역산 ──
     API 합계는 외화를 원화로 환산해 넣지만 환율은 안 알려준다. 잔차의 원인은 둘뿐:
       ① 외화 환산분(환율 r 미상)  ② 취소·정정(입·출금 양쪽에 같은 금액 c)
     연립:  입금잔차 = fxIn·r + c,  출금잔차 = fxOut·r + c
            r = (입금잔차 − 출금잔차) / (fxIn − fxOut),  c = 입금잔차 − fxIn·r
     한쪽만 부풀리는 진짜 누락은 r 을 상식 밖으로 밀어내 밴드에서 걸린다. */
  const fxIn = sumOf(fxRows, 'inAmount'), fxOut = sumOf(fxRows, 'outAmount');
  const fxNet = fxIn - fxOut;
  let fxRate = 0, fxRateSrc = '';

  if (expIn || expOut) {
    const krwIn = sumOf(krwRows, 'inAmount'), krwOut = sumOf(krwRows, 'outAmount');
    const resIn = expIn - krwIn, resOut = expOut - krwOut;
    const hasRes = Math.abs(resIn) > TOL || Math.abs(resOut) > TOL;

    /* fxNet 이 0 이면 연립이 r 을 못 낸다(환전·pass-through). 이때는 기준환율을 쓴다 —
       fxIn === fxOut 이라 어떤 환율이든 순액은 0 이고 총액 크기만 달라지므로,
       행을 통째로 버리는 것보다 환산해 넣는 편이 낫다. */
    const rDerived = fxNet ? (resIn - resOut) / fxNet : 0;
    const rUsed = fxNet ? rDerived : (fxRows.length && fxRef > 0 ? fxRef : 0);
    const c = rUsed ? resIn - fxIn * rUsed : resIn;
    const cIsolated = !fxRows.length || rUsed > 0;
    const rateOk = fxNet ? (rDerived > RATE_MIN && rDerived < RATE_MAX) : Math.abs(resIn - resOut) <= TOL;
    const explained = rateOk && c >= -TOL;

    Object.assign(report, { krwIn, krwOut, resIn, resOut, fxIn, fxOut, fxNet, fxCount: fxRows.length,
                            rDerived, rateBand: [RATE_MIN, RATE_MAX], bandNote, cancelLeg: c });

    if (hasRes && !explained) {
      return fail('SUM_MISMATCH',
        `합계가 맞지 않습니다 (입금 잔차 ${Math.round(resIn)}, 출금 잔차 ${Math.round(resOut)}) — 행 누락이 의심됩니다.` +
        (fxNet ? ` 외화 ${fxNet} 로 설명하려면 환율이 ${rDerived.toFixed(2)}원이어야 하는데 허용 밴드 ${RATE_MIN.toFixed(0)}~${RATE_MAX.toFixed(0)}원 밖입니다 (${bandNote}).` : ''),
        { resIn, resOut, rDerived, rateBand: [RATE_MIN, RATE_MAX], bandNote });
    }

    const gross = Math.max(expIn, expOut);
    const cRatio = gross ? c / gross : 0;
    if (c > TOL) {
      notes.push(`입·출금 양쪽에 동액 잔차 ${Math.round(c)} — 순액 0이라 적재를 계속합니다` +
        (cIsolated ? ` (그날 총액의 ${(cRatio * 100).toFixed(1)}%).` : ' — 환율 미정이라 외화 환산분이 섞여 있어 규모 판정은 건너뜁니다.'));
    }
    /* c 는 "집계에는 있는데 행 목록에는 없는" 양쪽 공통분이라 정상 원인은 취소·정정뿐이다.
       그날 총액의 상당 비율이면 계좌 하나가 통째 빠진 피드 장애일 수 있어 멈춘다.
       (실측: 2026-07-31 의 220,000,000원 = 총액의 14.7% 는 정상 취소쌍이었다.) */
    if (cIsolated && c > C_STOP_ABS && cRatio > C_STOP_RATIO && !allowLargeCancel) {
      return fail('LARGE_CANCEL',
        `취소 레그가 그날 총액의 ${(cRatio * 100).toFixed(1)}% (${Math.round(c)}) 로 과대합니다 — 계좌 단위 행 누락이 의심됩니다. 클로브에서 그날 취소·정정이 실제로 이 규모인지 확인하고 맞을 때만 allowLargeCancel 로 다시 실행하세요.`,
        { cancelLeg: c, ratio: cRatio });
    }
    fxRate = rUsed;
    fxRateSrc = rUsed ? (fxNet ? '역산 환율' : '기준환율') : '';
  }

  /* ── 6) 외화 행 원화 환산 ── */
  let fxKrwRows = [];
  if (fxRows.length && fxRate) {
    fxKrwRows = fxRows.map((r) => ({
      ...r,
      inAmount: Math.round(num(r.inAmount) * fxRate),
      outAmount: Math.round(num(r.outAmount) * fxRate),
      accountName: `${r.accountNumber} (외화 원화환산 @${fxRate.toFixed(2)} ${fxRateSrc})`,
      businessEntityName: r.transactionName || r.businessEntityName || r.transactionDescription,
      /* 외화 원금(통화 단위)을 남겨야 나중에 "외화 실잔액 − 외화 행 순증" 으로
         환산조정액을 계산할 수 있다. 원화 행과 섞이면 구분할 방법이 없다. */
      _fxUsd: num(r.inAmount) + num(r.outAmount),
    }));
    notes.push(`외화 ${fxRows.length}건 — ${fxRateSrc} ${fxRate.toFixed(2)}원으로 환산해 함께 적재합니다.` +
      (fxRateSrc === '기준환율' ? ' 외화 순액 0(환전·pass-through)이라 역산이 불가능해 기준환율을 그대로 썼습니다 — 실제 환전 대금과는 다를 수 있습니다.' : ''));
  } else if (fxRows.length) {
    warnings.push(`외화 ${fxRows.length}건 — 환율을 정할 수 없어(합계 검증 미통과 · API 합계 없음 · 순액 0인데 기준환율도 없음) 적재에서 제외합니다. 순액 0 때문이라면 기준환율(fxRef)을 넘기면 환산해 적재합니다.`);
  }
  Object.assign(report, { fxRate, fxRateSrc, fxExcluded: fxRows.length && !fxRate ? fxRows.length : 0 });

  /* ── 7) 오늘자 제외 (스냅샷 불완전 방어) ── */
  const allRows = [...krwRows, ...fxKrwRows];
  const target = allRows.filter((r) => (allowToday ? true : dateOf(r) < today));
  const todaySkipped = allRows.length - target.length;
  if (todaySkipped) notes.push(`오늘(${today})자 ${todaySkipped}건은 수집 미완성 가능성으로 제외했습니다.`);

  const byDate = {};
  for (const r of target) {
    const d = dateOf(r);
    const b = byDate[d] || (byDate[d] = { n: 0, in: 0, out: 0 });
    b.n++; b.in += num(r.inAmount); b.out += num(r.outAmount);
  }
  Object.assign(report, { todaySkipped, byDate, targetCount: target.length });

  /* ── 8) cf_data 행으로 변환 ──
     desc 는 businessEntityName(클로브가 정규화한 거래처명) 우선. 은행 원본 문자열은
     잘리거나 이체수단마다 달라져 학습 매핑 키가 분산된다("주식회사스파크"↔"스파크플러스").
     중분류는 보내지 않는다 — 대시보드 '자동분류 추천'이 맡는다. */
  const rows = target.map((r) => {
    const inA = num(r.inAmount), outA = num(r.outAmount);
    const desc = String(r.businessEntityName || r.transactionDescription || r.transactionName || '').trim();
    return {
      date: dateOf(r),
      desc: desc || '(거래내용 없음)',
      in: inA, out: outA,
      status: inA > 0 ? '실제 입금' : '실제 지출',
      clobe_id: String(r.transactionId),
      /* 같은 날 안의 순서는 tx_at 으로만 알 수 있다. clobe_id 는 계좌별 스크래핑 배치
         순서라 계좌가 다르면 시간순과 무관하다(2026-07-10 실측으로 확인). */
      ...(r.transactionAt ? { tx_at: String(r.transactionAt) } : {}),
      ...(r._fxUsd ? { fx_usd: r._fxUsd } : {}),
    };
  });

  return { abort: null, warnings, notes, rows, report };
}

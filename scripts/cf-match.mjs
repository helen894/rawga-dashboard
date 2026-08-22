/**
 * cf-match.mjs — 클로브 은행거래와 cf_data 행을 **clobe_id 없이** 맞추는 매칭 규칙.
 *
 * cf-ingest-verify.mjs 에서 떼어냈다(2026-08-22). 이유: CLI 쪽은 최상위에서 인자를 읽고
 * 네트워크를 타서, 그 파일을 import 하면 테스트가 CLI 를 실행해 버린다. 규칙만 따로 둔다.
 *
 * 왜 clobe_id 없이 맞추나: 2026년 cf_data 1,500건 중 69.9%(3~6월 전량)가 clobe_id 가 없다.
 * 키가 없으니 **날짜 + 금액(부호 포함)** 으로 맞춘다. 추정이므로 아래 순서로 좁혀 간다.
 *
 * 4단계 (엄격한 것부터):
 *   1) 같은 날 · 같은 금액 — **다중집합**으로. 같은 날 같은 금액이 2건 이상 있다
 *      (2026-07-09 745,945,000 이 2건). Set 으로 맞추면 한 건만 소진되고 나머지가 누락으로 잡힌다.
 *   2) 남은 것끼리 ±1일 · 같은 금액 — 은행 처리일과 기표일이 하루 어긋나는 경우.
 *      ⚠ ±1일에서 멈춘다. 더 넓히면 다른 거래를 잘못 문다.
 *   3) 클로브 1건 = cf_data 2건 — Edge split 으로 쪼갠 행(2026-07-09 외환차손 분할).
 *      ⚠ 짝(2개)까지만 본다. 3개 이상 조합은 조합 폭발이고, 우연히 합이 맞는 오탐이 늘어난다.
 *   4) 같은 날 · 같은 방향 · 2% 이내 — 금액 불일치 후보. 환율·수수료 차이를 잡는 그물이다.
 *      2%는 은행 환전 스프레드(실측 1.19%)를 덮되 다른 거래를 안 물 정도로 잡았다.
 *
 * 입력: clobe/ours 는 [{ date:'YYYY-MM-DD', amt: 부호있는정수, … }] — 나머지 필드는 보고용으로 통과.
 * 출력: { matched1, matched2, matched3, splitHits, mismatch, missing, ghost }
 *   missing = 클로브에만 있음 / ghost = cf_data 에만 있음 / mismatch = 근사 매칭된 짝
 *
 * ⚠ 입력 배열은 변형하지 않는다(내부에서 복사해 쓴다) — 호출부가 원본을 다시 쓴다.
 */

export const addDays = (d, n) => {
  const [y, m, dd] = String(d).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, dd + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
};

export function matchTx(clobeIn, oursIn) {
  const keyOf = (r) => `${r.date}|${r.amt}`;
  const bucket = (arr) => {
    const m = new Map();
    for (const r of arr) { const k = keyOf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return m;
  };
  /* 얕은 복사 — splice 로 소진시키므로 호출부의 배열을 건드리면 안 된다 */
  const cB = bucket([...clobeIn]), oB = bucket([...oursIn]);

  /* 1) 같은 날 · 같은 금액 (다중집합) */
  const cLeft = [], oLeft = [];
  let matched1 = 0;
  for (const [k, cs] of cB) {
    const os = oB.get(k) || [];
    const n = Math.min(cs.length, os.length);
    matched1 += n;
    cLeft.push(...cs.slice(n));
    os.splice(0, n);
  }
  for (const [, os] of oB) oLeft.push(...os);

  /* 2) ±1일 · 같은 금액 */
  let matched2 = 0;
  const oByAmt = new Map();
  for (const r of oLeft) { const k = String(r.amt); if (!oByAmt.has(k)) oByAmt.set(k, []); oByAmt.get(k).push(r); }
  const cLeft2 = [];
  for (const c of cLeft) {
    const cands = oByAmt.get(String(c.amt)) || [];
    const i = cands.findIndex((o) => o.date === addDays(c.date, 1) || o.date === addDays(c.date, -1));
    if (i >= 0) { cands.splice(i, 1); matched2++; } else cLeft2.push(c);
  }
  const oLeft2 = [...oByAmt.values()].flat();

  /* 3) 분할 매칭 — 클로브 1건 = cf_data 2건 */
  let matched3 = 0;
  const splitHits = [], cLeft3 = [];
  for (const c of cLeft2) {
    const same = oLeft2.filter((o) => o.date === c.date && Math.sign(o.amt) === Math.sign(c.amt));
    let hit = null;
    for (let i = 0; i < same.length && !hit; i++)
      for (let j = i + 1; j < same.length && !hit; j++)
        if (same[i].amt + same[j].amt === c.amt) hit = [same[i], same[j]];
    if (hit) {
      matched3++; splitHits.push({ c, parts: hit });
      for (const h of hit) oLeft2.splice(oLeft2.indexOf(h), 1);
    } else cLeft3.push(c);
  }

  /* 4) 근사 매칭 → 금액 불일치 후보 */
  const mismatch = [], missing = [];
  for (const c of cLeft3) {
    const same = oLeft2.filter((o) => o.date === c.date && Math.sign(o.amt) === Math.sign(c.amt));
    let best = null, bestGap = Infinity;
    for (const o of same) {
      const gap = Math.abs(o.amt - c.amt);
      if (gap / Math.abs(c.amt) <= 0.02 && gap < bestGap) { best = o; bestGap = gap; }
    }
    if (best) { mismatch.push({ c, o: best, gap: c.amt - best.amt }); oLeft2.splice(oLeft2.indexOf(best), 1); }
    else missing.push(c);
  }

  return { matched1, matched2, matched3, splitHits, mismatch, missing, ghost: oLeft2 };
}

#!/usr/bin/env node
/**
 * test-monthly-diagnosis.mjs — 월간 리포트 진단 3종의 **분류 판정**을 검증한다.
 *
 * 왜 있는가 (2026-11-15)
 *   종전 판별식은 적요까지 정규식으로 훑었다:
 *       /이자|금융|대출|차입|상환|수수료/
 *   '수수료' 하나 때문에 판매관리비의 **지급수수료가 통째로 금융비용**으로 셈됐다.
 *   2026-11 실측 — 금융비용이라고 표시한 5,840만 중 4,732만(81%)이 지급수수료였고
 *   진짜 금융비용은 960만뿐이었다. 피해가 양방향이었다:
 *     ⑴ 없는 위험을 경고 — 비중 16.2%(임계 10%)로 '위험', 실제는 2.7%로 '정상'
 *     ⑵ **영업 적자를 작게 보이게** — 같은 행이 영업성 출금에서도 빠져
 *        출금 6.08억 → 6.57억, 순현금 −2.47억 → −2.96억. 이쪽이 더 위험하다.
 *
 *   적요 키워드로 회계 성격을 가르면 안 된다. 분류는 mid_cat/big_cat 이 이미 갖고 있다.
 *   이 테스트는 "적요가 뭐라고 쓰여 있든 분류를 따른다" 를 못 박는다.
 *
 * 실행: node scripts/test-monthly-diagnosis.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* renderMonthlyReport 안의 화살표 함수들을 소스 그대로 꺼낸다 */
function grabConst(name) {
  const i = html.indexOf(`const ${name} = r =>`);
  if (i < 0) throw new Error(`index.html 에서 ${name} 을 못 찾았습니다`);
  const brace = html.indexOf('{', i);
  const semi = html.indexOf(';', i);
  if (brace < 0 || semi < brace) return html.slice(i, semi + 1);   // 한 줄짜리
  let d = 0, started = false;
  for (let j = brace; j < html.length; j++) {
    if (html[j] === '{') { d++; started = true; }
    else if (html[j] === '}') { d--; if (started && d === 0) return html.slice(i, j + 2); }
  }
  throw new Error(`${name} 의 끝을 못 찾았습니다`);
}
const api = new Function(`
  ${grabConst('isExcluded')}
  ${grabConst('isFinance')}
  ${grabConst('isNonOperating')}
  return { isExcluded, isFinance, isNonOperating };
`)();

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = got === want;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : `   got=${got} want=${want}`}`);
  ok ? pass++ : fail++;
};
const row = (big, mid, desc = '') => ({ big_cat: big, mid_cat: mid, desc });

console.log('\n월간 진단 — 분류 판정\n');

// ① 금융비용은 대분류로만 — 적요에 뭐라고 쓰여 있든 끌려오지 않는다
{
  t('이자비용 → 금융비용', api.isFinance(row('금융비용', '이자비용', '중진공대출원리')), true);
  t('지급수수료는 금융비용 아님', api.isFinance(row('판매관리비', '지급수수료', '우리대주회계법인')), false);
  t('판매수수료도 아님', api.isFinance(row('판매관리비', '판매수수료', '')), false);
  //   ↓ 종전 정규식이 걸려 넘어지던 바로 그 적요들
  t("  적요에 '수수료' 있어도", api.isFinance(row('판매관리비', '지급수수료', 'SMS 발송수수료')), false);
  t("  적요에 '대출' 있어도", api.isFinance(row('기타수입', '기타 입금', '대출금 입금')), false);
  t("  적요에 '상환' 있어도", api.isFinance(row('자금이동', '대여금 상환', '하경수_회수')), false);
  t("  적요에 '이자' 있어도", api.isFinance(row('판매관리비', '급여', '이자람')), false);
}

// ② 영업성에서 빠지는 것 — 실제 데이터의 대분류 이름을 쓴다
{
  //   ⚠ 종전엔 '자금이동/제외' 를 찾았는데 데이터의 대분류는 '자금이동'·'자금거래' 라
  //     2026년 표본 1,438행 중 **0건**이 잡혔다(중분류 목록이 가려 줘 안 드러났을 뿐).
  t('자금이동 대분류 제외', api.isExcluded(row('자금이동', '계좌간이체')), true);
  t('자금거래 대분류 제외', api.isExcluded(row('자금거래', '자기앞수표발행')), true);
  t('  옛 매핑값도 호환', api.isExcluded(row('자금이동/제외', '투자금')), true);
  t('인오가닉 제외', api.isExcluded(row('인오가닉', '천대표(부산)')), true);
  t('중분류 목록도 유효', api.isExcluded(row('기타', '대여금 수취')), true);
  t('판매관리비는 영업성', api.isExcluded(row('판매관리비', '지급수수료')), false);
  t('매출도 영업성', api.isExcluded(row('매출', '매출')), false);
}

// ③ 영업 판정에서 빠지는 재무성 대분류
{
  t('금융비용은 비영업', api.isNonOperating(row('금융비용', '이자비용')), true);
  t('금융수익도 비영업', api.isNonOperating(row('금융수익', '이자수익')), true);
  t('차입도 비영업', api.isNonOperating(row('차입', '')), true);
  t('재무활동도 비영업', api.isNonOperating(row('재무활동', '')), true);
  t('지급수수료는 영업', api.isNonOperating(row('판매관리비', '지급수수료')), false);
}

// ④ 소스 수준 — 되돌아오기 쉬운 것들을 못 박는다
{
  t('적요 정규식이 판정에 안 쓰인다',
    /const isFinance = r =>[^;]*\/이자\|/.test(html), false);
  t('월간 회수는 collect_date 기준',
    /const mColAR = arView\.filter\(a => a\.collect_date/.test(html), true);
  t('  ar_applied 집계는 쓰지 않는다', /mColCF/.test(html), false);
  t('영업 적자일 때 비율 대신 사실',
    /영업 순현금 적자\(\$\{fmtM\(operatingNet\)\}\)/.test(html), true);
}

console.log(`\n${fail ? '❌' : '✅'} ${pass}/${pass + fail} 통과`);
process.exit(fail ? 1 : 0);

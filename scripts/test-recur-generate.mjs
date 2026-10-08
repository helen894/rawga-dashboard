#!/usr/bin/env node
/**
 * test-recur-generate.mjs - generateRecurring 회귀 테스트.
 *
 * 왜 있는가 (2026-10-08 급여 중복 사고)
 *   중복 체크가 `recur_id + 정확한 날짜` 였다. 생성된 행의 날짜를 옮기면 원래 날짜가 비어
 *   "없다"로 판정돼 그 자리에 다시 만들었다. 템플릿이 10일+주말보정(prev)이라
 *   2026-10-10(토) -> 10-09(금)을 만들었는데 10-09는 한글날이라 실제 지급일이 10-08.
 *   대표님이 10-08로 옮기자 10-09가 부활해 10월 급여 122,586,410원이 중복 계상됐다.
 *   삭제해도 새로고침마다 되살아났다 - 생성기가 '없으면 만든다'만 알았기 때문.
 *
 * 무엇을 지키는가
 *   (1) 중복 체크는 **달** 기준  - 날짜를 옮겨도 재생성 안 함
 *   (2) 삭제한 달은 recurSkip 에 남아 재생성 안 함 / 되살리면 복구
 *
 * 판정 함수는 index.html 에서 **떼어 와** 쓴다. 사본을 만들면 화면과 테스트가 갈린다.
 * 쓰는 법: node scripts/test-recur-generate.mjs
 */
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const grab = (name) => { const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(name + ' 없음'); let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };

const TPL = [
  { _id: 'rc_pay0', day: 10, biz: 'prev', desc: '타행급여',   in: 0, out: 82206410, mid_cat: '급여' },
  { _id: 'rc_pay1', day: 10, biz: 'prev', desc: '당행급여',   in: 0, out: 30873930, mid_cat: '급여' },
  { _id: 'rc_pay2', day: 10, biz: 'prev', desc: '근로소득세', in: 0, out: 9506070,  mid_cat: '세금과공과금' },
];
const mk = (cf, skip, today) => {
  const env = {
    cfData: cf, recurData: TPL, recurSkip: skip, _cfIdCounter: 0,
    todayKST: () => today,
    addDays: (d, n) => { const [y, m, dd] = d.split('-').map(Number);
      const t = new Date(Date.UTC(y, m - 1, dd + n));
      return `${t.getUTCFullYear()}-${String(t.getUTCMonth()+1).padStart(2,'0')}-${String(t.getUTCDate()).padStart(2,'0')}`; },
    normalizeCFRow: (r) => r, getMidCat: () => '', getBigCat: () => '판매관리비',
    saveData: () => {}, showToast: () => {}, renderRecurSkipList: () => {},
    saveRecurSkip: () => ({ error: null }),
    localStorage: { getItem: (k) => (k === 'recur_months' ? '3' : null), setItem: () => {} },
    document: { getElementById: () => null },
  };
  const fn = new Function(...Object.keys(env), `
    ${grab('recurDupExists')}
    ${grab('shiftOffWeekend')}
    ${grab('pruneRecurSkip')}
    ${src.slice(src.indexOf('const recurSkipKey ='), src.indexOf('async function saveRecurSkip'))}
    ${grab('generateRecurring')}
    const _added = generateRecurring(false);
    return { added: _added, skip: recurSkip };`);
  /* pruneRecurSkip 이 recurSkip 을 **재할당**하므로 바깥 배열은 안 바뀐다 — 돌려받아 옮겨 담는다.
     (이걸 빼먹으면 '지난 달 정리' 가 통과한 것처럼 보인다) */
  const out = fn(...Object.values(env));
  skip.length = 0; for (const k of out.skip) skip.push(k);
  return out.added;
};
const row = (date, desc, out, rid) => ({ _id: 'x' + date + desc, date, desc, in: 0, out,
  status: '지출 예정', recur_id: rid, type: '지출' });
let pass = 0, fail = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++; };

// ① 빈 상태 → 10/11/12/(10월 포함) 생성
let cf = [];
t('빈 상태에서 생성', mk(cf, [], '2026-10-08'), 12);   // 3템플릿 × (당월+3개월)
console.log('     생성 날짜:', [...new Set(cf.map(r => r.date))].sort().join(', '));

// ② 이번 사고 재현 — 생성된 10/09 행을 10/08 로 옮긴 상태
cf = [row('2026-10-08', '타행급여', 82206410, 'rc_pay0'),
      row('2026-10-08', '당행급여', 30873930, 'rc_pay1'),
      row('2026-10-08', '원천세',   11695390, 'rc_pay2')];
const addedMove = mk(cf, [], '2026-10-08');
t('날짜를 10/08 로 옮겨도 10/09 재생성 안 함', cf.filter(r => r.date === '2026-10-09').length, 0);
t('  10월에 추가 생성 0건', cf.filter(r => r.date.startsWith('2026-10')).length, 3);

// ③ 삭제 → 건너뛴 달 기록 → 재생성 안 함
cf = [];
mk(cf, [], '2026-10-08');
const oct = cf.filter(r => r.date.startsWith('2026-10'));
cf = cf.filter(r => !r.date.startsWith('2026-10'));          // 10월 3건 삭제
const skip = oct.map(r => r.recur_id + '|2026-10');
mk(cf, skip, '2026-10-08');
t('삭제한 달은 다시 안 만듦', cf.filter(r => r.date.startsWith('2026-10')).length, 0);
t('  다른 달은 그대로', cf.filter(r => r.date.startsWith('2026-11')).length, 3);

// ④ 되살리기 — skip 을 비우면 복구
mk(cf, [], '2026-10-08');
t('되살리면 복구', cf.filter(r => r.date.startsWith('2026-10')).length, 3);

// ⑤ 한 템플릿만 건너뛰기
cf = []; mk(cf, [], '2026-10-08');
cf = cf.filter(r => !(r.date.startsWith('2026-10') && r.recur_id === 'rc_pay2'));
mk(cf, ['rc_pay2|2026-10'], '2026-10-08');
t('건너뛴 템플릿만 빠짐', cf.filter(r => r.date.startsWith('2026-10')).map(r => r.recur_id).sort(), ['rc_pay0', 'rc_pay1']);

// ⑥ 지난 달 기록은 자동으로 치운다 / 이번 달·미래는 남긴다
cf = [];
const skip6 = ['rc_pay0|2026-08', 'rc_pay1|2026-09', 'rc_pay2|2026-10', 'rc_pay0|2026-12', '엉터리키'];
mk(cf, skip6, '2026-10-08');
t('지난 달 기록 정리 · 이번 달/미래/비정상 키는 유지',
  skip6.slice().sort(), ['rc_pay0|2026-12', 'rc_pay2|2026-10', '엉터리키'].sort());
t('  정리 뒤에도 이번 달 건너뛰기는 유효', cf.filter(r => r.date.startsWith('2026-10')).map(r => r.recur_id).sort(),
  ['rc_pay0', 'rc_pay1']);

console.log(`\n${fail ? '❌' : '✅'} ${pass}/${pass + fail} 통과`);
process.exit(fail ? 1 : 0);

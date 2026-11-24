#!/usr/bin/env node
/**
 * test-ingest-notify.mjs — 자동적재 알림(collectNewIngest)이 '무엇을 신규로 세는가' 를 못 박는다.
 *
 * 이 알림에는 적재 로그 테이블이 없다. 행의 `_id`(`cf_<base36 적재시각ms>_…`)에 박힌
 * 시각을 되읽어 세는 방식이라, 세는 규칙이 틀리면 **화면이 사실과 다른 말을 한다**:
 *   · `clobe_id` 조건이 빠지면 → 내가 방금 손으로 넣은 행을 '자동적재' 라고 부른다
 *   · 기준선 처리가 틀리면    → 첫 화면에서 1,500건을 통째로 '신규' 라고 외친다
 * 둘 다 알림을 안 다느니만 못한 고장이라 여기서 고정한다.
 *
 * index.html 의 함수 본문을 그대로 떼어 와 돌린다 — 사본을 만들면 원본과 갈린다.
 */
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
/* ⚠ 중괄호를 세서 본문을 떼므로 **매개변수에 기본값 `{}` 가 있는 함수는 못 쓴다** —
     `function showToast(msg, type='green', opts={})` 에서 `opts={}` 의 중괄호를 본문 시작으로
     보고 거기서 끊는다(2026-11-24 에 실제로 밟았다). 그런 함수를 떼야 하면 파라미터 괄호를
     먼저 닫고 나서 `{` 를 찾도록 고쳐야 한다. 여기 대상들은 그런 기본값이 없다. */
const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`${name} 를 못 찾음`);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error(`${name} 본문 끝을 못 찾음`);
};

let cfData = [];
/* ⚠ 키 상수를 같이 넣어야 한다. 안 넣으면 collectNewIngest 안의
     `try { localStorage.getItem(INGEST_ALERT_KEY) } catch {}` 가 ReferenceError 를
     **삼켜서** seen=0 으로 조용히 흘러간다 — 터지지 않으니 하네스가 틀린 걸 모른다
     (2026-11-24 에 실제로 여기서 30분 헤맸다). */
const lsStore = new Map();
const fn = new Function('getCf', 'ls', `
  Object.defineProperty(globalThis, 'cfData', { get: getCf, configurable: true });
  const localStorage = ls;
  const INGEST_ALERT_KEY = 'cf_ingest_seen';
  const INGEST_HELLO_KEY = 'cf_ingest_hello2';
  ${grab('idStamp')}
  ${grab('collectNewIngest')}
  return { collectNewIngest, idStamp };`)(() => cfData, {
    getItem: k => lsStore.has(k) ? lsStore.get(k) : null,
    setItem: (k, v) => lsStore.set(k, String(v)),
  });
const { collectNewIngest, idStamp } = fn;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✅' : '❌'} ${name.padEnd(46)} ${ok ? JSON.stringify(got) : `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

/* Edge 의 genId 와 같은 형식으로 만든다: cf_<base36 ms>_<rand> */
const ms = (iso) => Date.parse(iso + '+09:00');                       // KST 로 읽는다
const ID = (iso) => `cf_${ms(iso).toString(36)}_abc1234`;
/* 자동적재 행(clobe_id 있음) / 수기 행(없음) */
const AUTO = (iso, date, inA = 0, outA = 0, cid = '17100000') =>
  ({ _id: ID(iso), clobe_id: cid, date, in: inA, out: outA, status: inA ? '실제 입금' : '실제 지출' });
const MANUAL = (iso, date, outA = 1000) =>
  ({ _id: ID(iso), date, in: 0, out: outA, status: '실제 지출' });

console.log('\n_id 에 박힌 적재 시각 되읽기\n');
eq('base36 왕복', idStamp(ID('2026-11-24T11:12:00'), 'cf'), ms('2026-11-24T11:12:00'));
eq('형식이 다르면 0', idStamp('row_17', 'cf'), 0);
eq('빈 값이면 0', idStamp('', 'cf'), 0);
eq('1970년대 값은 안 믿는다', idStamp('cf_1_abc', 'cf'), 0);

console.log('\n무엇을 신규로 세나\n');

const base = ms('2026-11-24T07:00:00');
cfData = [
  AUTO('2026-11-23T07:00:00', '2026-11-20', 0, 5000),        // 기준선 이전 — 신규 아님
  AUTO('2026-11-24T11:12:00', '2026-11-23', 0, 88149640),    // 신규
  AUTO('2026-11-24T11:12:01', '2026-11-21', 1000000, 0),     // 신규
];
let g = collectNewIngest(base);
eq('기준선 뒤 행만 신규', g.rows.length, 2);
eq('maxStamp 는 전체 최대', g.maxStamp, ms('2026-11-24T11:12:01'));
eq('입금 합계', g.inSum, 1000000);
eq('출금 합계', g.outSum, 88149640);
eq('날짜 범위는 거래일 기준으로 정렬', [g.from, g.to], ['2026-11-21', '2026-11-23']);

/* ★ 핵심. 수기 입력분은 같은 cf_<ms>_ 를 받지만 clobe_id 가 없다.
   이 조건이 빠지면 내가 방금 손으로 넣은 행을 '자동적재' 라고 말한다. */
cfData = [
  MANUAL('2026-11-24T11:30:00', '2026-11-24'),
  AUTO('2026-11-24T11:12:00', '2026-11-23', 0, 5000),
];
g = collectNewIngest(base);
eq('수기 입력분(clobe_id 없음)은 제외', g.rows.length, 1);
eq('수기 행은 maxStamp 에도 안 들어간다', g.maxStamp, ms('2026-11-24T11:12:00'));

cfData = [{ _id: 'cf_17_bad', clobe_id: '1', date: '2026-11-24', in: 0, out: 1 }];
eq('_id 가 깨진 행은 세지 않는다', collectNewIngest(base).rows.length, 0);

cfData = [{ date: '2026-11-24', status: '지출 예정', in: 0, out: 70000000 }];
g = collectNewIngest(base);
eq('예정 행(_id·clobe_id 없음)은 제외', [g.rows.length, g.maxStamp], [0, 0]);

cfData = [AUTO('2026-11-23T07:00:00', '2026-11-20', 0, 5000)];
g = collectNewIngest(base);
eq('새 게 없으면 rows 는 비고 maxStamp 는 남는다',
   [g.rows.length, g.maxStamp], [0, ms('2026-11-23T07:00:00')]);

cfData = [];
eq('데이터가 없으면 maxStamp 0 (알리지 않는다)', collectNewIngest(base).maxStamp, 0);

/* 기준선이 0(첫 실행)이면 전건이 신규로 잡힌다 — 그래서 notifyIngest 가
   이 경우 토스트를 띄우지 않고 기준선만 찍는다. 그 분기가 사라지지 않았는지 본다. */
cfData = [AUTO('2026-11-23T07:00:00', '2026-11-20'), AUTO('2026-11-24T11:12:00', '2026-11-23')];
eq('기준선 0 이면 전건이 신규로 잡힌다(= 첫 실행 가드가 필요한 이유)',
   collectNewIngest(0).rows.length, 2);
const guard = grab('notifyIngest');
eq('notifyIngest 에 첫 실행 가드가 있다',
   /const first = !g\.seen;\s*\n\s*const nothingNew = first \|\| !g\.rows\.length;/.test(guard), true);
eq('신규 0건이면 조용하다', /\n  if \(nothingNew\) return;/.test(guard), true);
/* 첫 화면에서 아무 말도 안 하면 고장과 구별이 안 된다 — 2026-11-24 에 실제로 그 문의를
   받았다. 기준선(cf_ingest_seen)과 **별도 키**로 한 번만 인사하는 분기가 살아있나. */
eq('켜졌다는 인사를 한 번은 한다',
   /INGEST_HELLO_KEY[\s\S]*if \(nothingNew\) \{[\s\S]*showToast\(/.test(guard), true);
eq('인사 플래그는 기준선과 다른 키다',
   /const INGEST_HELLO_KEY = 'cf_ingest_hello2';/.test(src)
   && /const INGEST_ALERT_KEY = 'cf_ingest_seen';/.test(src), true);

/* 무인자 호출 — 실제 코드(notifyIngest)가 쓰는 경로다. 기준선을 localStorage 에서
   읽어야 하는데, 위 ⚠ 처럼 여기서 조용히 0 이 되면 **매번 전건을 신규로 세게 된다.** */
cfData = [
  AUTO('2026-11-23T07:00:00', '2026-11-20', 0, 5000),
  AUTO('2026-11-24T11:12:00', '2026-11-23', 0, 88149640),
];
lsStore.set('cf_ingest_seen', String(ms('2026-11-24T07:00:00')));
eq('무인자 호출은 localStorage 기준선을 읽는다',
   [collectNewIngest().seen, collectNewIngest().rows.length], [ms('2026-11-24T07:00:00'), 1]);
lsStore.delete('cf_ingest_seen');
eq('기준선이 없으면 seen 0 (첫 실행)', collectNewIngest().seen, 0);

const dayStamp = ms('2026-11-24T11:12:00');
eq('하루 단위 집계는 KST 로 센다',
   new Function(`${grab('stampYmd')} return stampYmd(${dayStamp});`)(), '2026-11-24');

console.log(`\n${fail ? '❌' : '✅'} 통과 ${pass} · 실패 ${fail}\n`);
process.exit(fail ? 1 : 0);

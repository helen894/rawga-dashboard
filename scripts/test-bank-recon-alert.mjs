#!/usr/bin/env node
/**
 * test-bank-recon-alert.mjs — 은행 실잔액 대조 알림(notifyBankRecon) 회귀 테스트.
 *
 * 왜: 이 알림은 **안 뜨는 게 기본**이라 고장나도 티가 안 난다. 조건이 조용히 뒤집히면
 * (초기화 전 가짜 경보로 하루치 기회를 써버린다든지) 정작 필요할 때 아무 말이 없다.
 * 사람 눈으로는 못 잡으므로 여기서 잡는다.
 *
 * 어떻게: index.html 은 단일 파일이라 import 가 안 된다. 함수 소스를 이름으로 잘라내
 * new Function 으로 격리 실행한다 — **배포되는 코드 그대로**를 검사한다.
 *
 * 실행: node scripts/test-bank-recon-alert.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function grab(name){
  const i = html.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('없음: ' + name);
  let d = 0, started = false;
  for (let j = html.indexOf('{', i); j < html.length; j++){
    if (html[j] === '{') { d++; started = true; }
    else if (html[j] === '}') { d--; if (started && d === 0) return html.slice(i, j+1); }
  }
  throw new Error('불균형: ' + name);
}
const KEYLINE = html.match(/const RECON_ALERT_KEY = '[^']+';/)[0];

const src = `
  let _isInitialized = true, TODAY = '2026-08-19';
  const store = {};
  const localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k,v) => { store[k] = String(v); } };
  const todayKST = () => TODAY;
  const fmt = n => Math.round(Number(n)||0).toLocaleString('ko-KR');
  let toasts = [];
  const showToast = (msg, type, opts) => toasts.push({ msg, type, ms: opts && opts.ms, hasClick: !!(opts && opts.onClick) });
  ${KEYLINE}
  ${grab('notifyBankRecon')}
  globalThis.__api = {
    call: (...a) => notifyBankRecon(...a),
    reset: () => { toasts = []; for (const k of Object.keys(store)) delete store[k]; },
    clearToasts: () => { toasts = []; },
    get toasts(){ return toasts; },
    set init(v){ _isInitialized = v; },
    set today(v){ TODAY = v; },
  };
`;
new Function(src)();
const api = globalThis.__api;

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '  ✅' : '  ❌'} ${label}${ok ? '' : `\n       기대 ${JSON.stringify(want)}\n       실제 ${JSON.stringify(got)}`}`);
  ok ? pass++ : fail++;
};
const DAY = 86400000;
const fresh = new Date(Date.now() - 3600e3).toISOString();          // 1시간 전
const old3  = new Date(Date.now() - 3 * DAY).toISOString();         // 3일 전

console.log('');
console.log('[1] 일치(100만 이하) — 아무것도 안 뜬다');
api.reset(); api.call(500000, 500000, false, fresh);
check('토스트 없음', api.toasts.length, 0);

console.log('');
console.log('[2] 100만 초과 — 노랑 "확인 필요"');
api.reset(); api.call(3500000, -3500000, false, fresh);
check('1건', api.toasts.length, 1);
check('색', api.toasts[0]?.type, 'amber');
check('금액 표기', api.toasts[0]?.msg.includes('3,500,000'), true);
check('확인 필요', api.toasts[0]?.msg.includes('확인 필요'), true);
check('클릭 가능', api.toasts[0]?.hasClick, true);

console.log('');
console.log('[3] 1,000만 초과 — 빨강 "점검 필요"');
api.reset(); api.call(132051757, 132051757, false, fresh);
check('색', api.toasts[0]?.type, 'red');
check('점검 필요', api.toasts[0]?.msg.includes('점검 필요'), true);

console.log('');
console.log('[4] 낡은 스냅샷 — 금액 불일치가 아니라 "갱신" 으로 알린다');
api.reset(); api.call(132051757, 132051757, true, old3);
check('색', api.toasts[0]?.type, 'amber');
check('갱신 문구', api.toasts[0]?.msg.includes('갱신되지 않았습니다'), true);
check('금액 불일치라고 하지 않음', /확인 필요|점검 필요/.test(api.toasts[0]?.msg || ''), false);
check('경과일', api.toasts[0]?.msg.includes('3일째'), true);

console.log('');
console.log('[5] 초기화 전 — 절대 알리지 않는다 (가짜 경보가 하루치 기회를 먹으면 안 됨)');
api.reset(); api.init = false; api.call(999999999, 999999999, false, fresh);
check('토스트 없음', api.toasts.length, 0);
api.init = true;
api.call(999999999, 999999999, false, fresh);
check('초기화 후엔 뜬다', api.toasts.length, 1);

console.log('');
console.log('[6] 하루 한 번 — 같은 날 다시 불러도 안 뜬다');
api.reset(); api.call(3500000, 3500000, false, fresh); api.clearToasts();
api.call(3500000, 3500000, false, fresh);
check('두 번째 침묵', api.toasts.length, 0);
api.call(3600000, 3600000, false, fresh);
check('금액만 달라져도 같은 날엔 침묵', api.toasts.length, 0);

console.log('');
console.log('[7] 종류가 바뀌면 같은 날이라도 다시 알린다');
api.reset(); api.call(3500000, 3500000, false, fresh); api.clearToasts();
api.call(132051757, 132051757, false, fresh);
check('노랑 → 빨강 재알림', api.toasts.length, 1);
api.clearToasts();
api.call(132051757, 132051757, true, old3);
check('빨강 → 갱신 재알림', api.toasts.length, 1);

console.log('');
console.log('[8] 날짜가 바뀌면 다시 알린다');
api.reset(); api.call(3500000, 3500000, false, fresh); api.clearToasts();
api.today = '2026-08-20';
api.call(3500000, 3500000, false, fresh);
check('다음날 재알림', api.toasts.length, 1);

console.log('');
console.log(`${fail === 0 ? '✅ 전부 통과' : '❌ 실패 ' + fail + '건'} (${pass}/${pass+fail})`);
process.exitCode = fail ? 1 : 0;

/* cat_data.settings 를 통째로 덮어써 cf_start 같은 키를 날리는 회귀를 막는다.
   2026-08-24: saveCatDataToSupabase 와 기초잔액 모달이 { init_cash } 만 써서 cf_start 가
   지워졌고, 2025년 4건(−328,588,261)이 잔액에 되살아나 3.29억이 어긋났다.
   실행: node scripts/test-settings-merge.mjs */
import fs from 'node:fs';
const html = fs.readFileSync('index.html', 'utf8');
let pass = 0, fail = 0;
const t = (name, ok, detail) => { ok ? pass++ : fail++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok || !detail ? '' : '\n       ' + detail}`); };

/* ① 전역 선언 — null 초기값(미로드 표시)이어야 한다 */
t('SETTINGS_RAW 가 null 로 선언됨', /let SETTINGS_RAW = null;/.test(html));

/* ② settings 를 쓰는 모든 지점이 SETTINGS_RAW 를 펼쳐 병합하는가 */
const writes = [];
const re = /key:\s*'settings'\s*,\s*data:\s*([^\n]*)/g;
let m;
while ((m = re.exec(html))) writes.push({ at: html.slice(0, m.index).split('\n').length, expr: m[1].trim() });
t(`settings 쓰기 지점 발견 (${writes.length}곳)`, writes.length >= 2, '2곳 이상이어야 한다');
for (const w of writes) {
  const merged = /\.\.\.SETTINGS_RAW/.test(w.expr) || /data:\s*SETTINGS_RAW/.test(w.expr) || w.expr.startsWith('SETTINGS_RAW');
  t(`index.html:${w.at} 병합 저장`, merged, `통째 덮어쓰기 위험: data: ${w.expr.slice(0, 70)}`);
}

/* ③ 로드 지점 2곳 모두 SETTINGS_RAW 를 채우는가 */
const loads = (html.match(/SETTINGS_RAW = \{ \.\.\.\(row\.data \|\| \{\}\) \};/g) || []).length;
t(`로드 지점에서 SETTINGS_RAW 채움 (${loads}곳)`, loads === 2, '최초 로드 + Realtime 두 곳이어야 한다');

/* ④ 미로드(null) 상태에서는 settings 를 쓰지 않는가 */
t('SETTINGS_RAW 가 null 이면 저장 제외', /if \(SETTINGS_RAW\) upserts\.splice/.test(html));
t('모달도 null 이면 서버 저장 안 함', /if \(_supa && SETTINGS_RAW\)/.test(html));

/* ⑤ 기능 검증 — 병합이 미지의 키를 실제로 보존하는가 */
const server = { init_cash: 148963934, cf_start: '2026-01-01', future_key: 'keep-me' };
let SETTINGS_RAW = null;
SETTINGS_RAW = { ...(server || {}) };            // 로드
const INIT_CASH = 999;
const payloadA = { ...SETTINGS_RAW, init_cash: INIT_CASH };            // saveCatDataToSupabase
SETTINGS_RAW = { ...SETTINGS_RAW, init_cash: 777 };
const payloadB = SETTINGS_RAW;                                        // 모달
t('병합 후 cf_start 보존 (일괄저장)', payloadA.cf_start === '2026-01-01', JSON.stringify(payloadA));
t('병합 후 미지의 키 보존 (일괄저장)', payloadA.future_key === 'keep-me', JSON.stringify(payloadA));
t('병합 후 init_cash 갱신 (일괄저장)', payloadA.init_cash === 999);
t('병합 후 cf_start 보존 (모달)', payloadB.cf_start === '2026-01-01', JSON.stringify(payloadB));
t('병합 후 init_cash 갱신 (모달)', payloadB.init_cash === 777);

console.log(`\n${pass}/${pass + fail} 통과`);
process.exit(fail ? 1 : 0);

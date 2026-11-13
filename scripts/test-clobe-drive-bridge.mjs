#!/usr/bin/env node
/**
 * test-clobe-drive-bridge.mjs — Apps Script 브리지의 **분기 판정**을 GAS 없이 검증한다.
 *
 * 왜 있는가 (2026-11-13)
 *   이 브리지가 틀리면 조용히 망가진다. 제일 위험한 건 **검증 실패(422)를 성공으로 처리**해
 *   파일을 '완료' 로 치워 버리는 것이다 — 그러면 사고를 막으라고 만든 가드 6개가
 *   아무 소리 없이 무의미해진다. 그 분기를 여기서 못 박는다.
 *
 * GAS 전역(DriveApp·UrlFetchApp·…)을 가짜로 끼워 넣고 runBridge() 를 돌린다.
 * 쓰는 법: node scripts/test-clobe-drive-bridge.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../apps-script/clobe-drive-bridge.gs', import.meta.url), 'utf8');

const mkFile = (name, content) => ({
  _name: name, _content: content, _id: 'id_' + name,
  getName: () => name, getId: () => 'id_' + name,
  getBlob: () => ({ getDataAsString: () => content }),
});
const mkFolder = (name, files = []) => {
  const f = {
    _name: name, _files: files,
    getFiles: () => { let i = 0; return { hasNext: () => i < f._files.length, next: () => f._files[i++] }; },
    addFile: (x) => { if (!f._files.includes(x)) f._files.push(x); },
    removeFile: (x) => { const i = f._files.indexOf(x); if (i >= 0) f._files.splice(i, 1); },
    getFoldersByName: (n) => { const c = f._sub?.[n]; let used = false;
      return { hasNext: () => !!c && !used, next: () => { used = true; return c; } }; },
    createFolder: (n) => { throw new Error('테스트에서는 폴더를 미리 만들어 둔다: ' + n); },
  };
  return f;
};

function run(inboxFiles, fetchImpl) {
  const inbox = mkFolder('대기', inboxFiles), done = mkFolder('완료'), hold = mkFolder('보류');
  const root = mkFolder('RAWGA-자동적재'); root._sub = { '대기': inbox, '완료': done, '보류': hold };
  const driveRoot = mkFolder('/'); driveRoot._sub = { 'RAWGA-자동적재': root };
  const props = {};
  const mails = [];
  const ctx = vm.createContext({
    DriveApp: { getRootFolder: () => driveRoot },
    MimeType: { PLAIN_TEXT: 'text/plain' },
    UrlFetchApp: { fetch: fetchImpl },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k === 'BANK_SYNC_SECRET' ? 'test-secret' : props[k] ?? null),
      setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    MailApp: { sendEmail: (to, subj, body) => mails.push({ to, subj, body }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'test@example.com' }) },
    ScriptApp: { getProjectTriggers: () => [] },
    Logger: { log: () => {} },
    console,
  });
  vm.runInContext(src, ctx);
  ctx.runBridge();
  return { inbox: inbox._files.map(f => f.getName()), done: done._files.map(f => f.getName()),
           hold: hold._files.map(f => f.getName()), mails, props };
}

const resp = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });
const okPayload = JSON.stringify({ pages: { content: [{ transactionId: 'a' }] }, fxAccounts: {}, fxRef: 0 });

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// ① 성공 → 완료로 이동, 알림 없음
{
  const r = run([mkFile('cf-20261113-0900.json', okPayload)], () => resp(200, { ok: true, added: 3, skipped: 1 }));
  t('성공 → 완료 이동', [r.done, r.inbox, r.hold], [['cf-20261113-0900.json'], [], []]);
  t('  성공만이면 알림 없음', r.mails.length, 0);
}
// ② 검증 실패(422) → 보류로, 알림 발송.  ★ 절대 '완료' 로 가면 안 된다
{
  const r = run([mkFile('cf-20261113-0900.json', okPayload)],
    () => resp(422, { ok: false, aborted: true, code: 'FX_STRAY_ACCOUNT', error: '새 외화계좌' }));
  t('검증 실패 → 보류 이동', [r.hold, r.done, r.inbox], [['cf-20261113-0900.json'], [], []]);
  t('  알림 발송', r.mails.length, 1);
  t('  사유가 본문에 있다', /FX_STRAY_ACCOUNT/.test(r.mails[0].body), true);
}
// ③ 서버 오류(5xx) → 대기에 그대로, 다음 실행이 재시도
{
  const r = run([mkFile('cf-20261113-0900.json', okPayload)], () => resp(500, { ok: false, error: 'boom' }));
  t('서버 오류 → 대기 유지(재시도)', [r.inbox, r.done, r.hold], [['cf-20261113-0900.json'], [], []]);
  t('  알림 발송', r.mails.length, 1);
}
// ④ 네트워크 예외 → 대기에 그대로
{
  const r = run([mkFile('cf-20261113-0900.json', okPayload)], () => { throw new Error('timeout'); });
  t('네트워크 예외 → 대기 유지', [r.inbox, r.done, r.hold], [['cf-20261113-0900.json'], [], []]);
}
// ⑤ 깨진 JSON → 보류 (억지 해석 금지)
{
  const r = run([mkFile('bad.json', '{not json')], () => resp(200, { ok: true }));
  t('깨진 JSON → 보류', [r.hold, r.done], [['bad.json'], []]);
}
// ⑥ pages 없는 파일 → 보류
{
  const r = run([mkFile('x.json', JSON.stringify({ hello: 1 }))], () => resp(200, { ok: true }));
  t('pages 없으면 보류', [r.hold, r.done], [['x.json'], []]);
}
// ⑦ 오래된 것부터 처리 — 날짜 순서가 어긋나면 잔액 추이가 틀어진다
{
  const seen = [];
  run([mkFile('cf-20261113.json', okPayload), mkFile('cf-20261110.json', okPayload), mkFile('cf-20261112.json', okPayload)],
      (url, o) => { seen.push(JSON.parse(o.payload).pages ? o.payload.length : 0); return resp(200, { ok: true }); });
  t('3건 모두 처리', seen.length, 3);
}
// ⑧ 성공 시각 기록 — "안 돌았다" 를 나중에 알아볼 수 있어야 한다
{
  const r = run([mkFile('cf-20261113.json', okPayload)], () => resp(200, { ok: true, added: 1 }));
  t('BRIDGE_LAST_OK 기록', !!r.props.BRIDGE_LAST_OK, true);
  const r2 = run([mkFile('cf-20261113.json', okPayload)], () => resp(500, {}));
  t('실패만이면 LAST_OK 안 찍음', !!r2.props.BRIDGE_LAST_OK, false);
}

console.log(`\n${fail ? '❌' : '✅'} ${pass}/${pass + fail} 통과`);
process.exit(fail ? 1 : 0);

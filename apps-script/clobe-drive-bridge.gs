/**
 * clobe-drive-bridge — Drive 에 떨어진 클로브 원본을 Supabase Edge 로 넘겨 cf_data 에 적재한다.
 *
 * ═══ 왜 이런 구조인가 (2026-11-13) ═══════════════════════════════════════════
 * 목표는 **PC 가 꺼져 있어도 자동 적재가 도는 것**이다. 걸림돌이 둘이었다:
 *   ① 클로브는 REST API 가 없다 — MCP 커넥터(=Claude)로만 읽을 수 있다.
 *   ② Supabase 쓰기에는 BANK_SYNC_SECRET 이 필요한데, Claude 클라우드 루틴에는
 *      비밀값을 넣을 자리가 없다(넣으면 루틴 설정·실행 로그에 그대로 남는다).
 * 그래서 역할을 쪼갰다:
 *   [Claude 클라우드 루틴]  클로브 읽기 → Drive 에 JSON 저장   (시크릿 불필요)
 *   [이 스크립트, 시간 트리거]  Drive 읽기 → Edge 호출          (시크릿은 Script Properties)
 * 양쪽 다 서버에서 돌아 PC 가 빠진다. 매출채권 동기화(AR_SYNC_SECRET)가 이미 같은 방식이다.
 *
 * ═══ 설치 ═══════════════════════════════════════════════════════════════════
 *  1) [프로젝트 설정 > 스크립트 속성] 에 `BANK_SYNC_SECRET` 추가
 *     값 = Supabase Edge 의 BANK_SYNC_SECRET 과 동일 (로컬 %LOCALAPPDATA%\rawga\bank-sync.secret)
 *     ⚠ 이 값은 코드·채팅·저장소 어디에도 적지 않는다.
 *  2) Drive 에 폴더 3개를 만든다 (이름은 아래 상수와 맞출 것):
 *     RAWGA-자동적재/대기 · RAWGA-자동적재/완료 · RAWGA-자동적재/보류
 *  3) `setupTrigger()` 를 한 번 실행 — 10분마다 도는 시간 트리거를 건다.
 *  4) `runOnce()` 로 수동 1회 실행해 권한을 선승인한다.
 *
 * ═══ 설계상 반드시 지키는 것 ═══════════════════════════════════════════════
 *  · **검증 실패(422)는 성공이 아니다.** 파일을 '보류' 로 옮기고 메일로 알린다.
 *    조용히 삭제하거나 완료 처리하면, 막으라고 만든 가드가 무의미해진다.
 *  · **네트워크·서버 오류는 파일을 그대로 둔다.** 다음 실행이 다시 시도한다.
 *    Edge 가 clobe_id 로 중복을 걸러내므로 재시도는 안전하다(이중 적재되지 않음).
 *  · **성공했을 때는 조용히.** 매번 메일이 오면 곧 안 읽게 되고, 진짜 사고가 묻힌다.
 *  · 동시 실행 방지 — 트리거가 겹치면 같은 파일을 두 번 보낸다. LockService 로 막는다.
 */

var EDGE_URL   = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
/* ⚠⚠ 이 함수는 verify_jwt=true 로 배포돼 있어 **게이트웨이가 키를 요구한다.**
   apikey / Authorization 헤더가 없으면 함수에 닿기도 전에 401 이 난다
   (2026-11-14 실제로 당했다 — 5개 파일 전부 HTTP 401, 시크릿은 멀쩡했는데 요청이
    Edge 까지 가지도 못했다. ar-sheet-sync.gs 를 본떠 쓰면서 그쪽은 다른 함수를
    호출한다는 걸 놓쳤다).
   아래 키는 index.html 에 이미 박혀 브라우저로 배포되는 **공개 publishable 키**라
   비밀이 아니다. 실제 인증은 본문의 secret(=BANK_SYNC_SECRET) 이 한다. */
var SUPA_PUBLISHABLE_KEY = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
var ROOT_FOLDER = 'RAWGA-자동적재';
var DIR_IN   = '대기';     // 클라우드 루틴이 여기 떨군다
var DIR_DONE = '완료';     // 적재 성공
var DIR_HOLD = '보류';     // 검증에 걸림 — 사람이 봐야 한다
var NOTIFY_TO = '';        // 비우면 스크립트 소유자에게 보낸다
var MAX_FILES_PER_RUN = 10;   // 한 번에 너무 많이 보내 6분 실행 한도에 걸리지 않게

/* ── 시크릿 ──────────────────────────────────────────────────────────────── */
function getSecret_() {
  var s = PropertiesService.getScriptProperties().getProperty('BANK_SYNC_SECRET');
  if (!s) throw new Error('스크립트 속성에 BANK_SYNC_SECRET 이 없습니다. [프로젝트 설정 > 스크립트 속성]에 추가하세요.');
  return s;
}

/* ── 폴더 ────────────────────────────────────────────────────────────────── */
function folder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function dirs_() {
  var root = folder_(DriveApp.getRootFolder(), ROOT_FOLDER);
  return {
    root: root,
    inbox: folder_(root, DIR_IN),
    done:  folder_(root, DIR_DONE),
    hold:  folder_(root, DIR_HOLD),
  };
}
/* Drive 에는 '이동' 이 없어 추가 후 제거로 옮긴다. 순서가 바뀌면 파일이 미아가 된다. */
function move_(file, from, to) {
  to.addFile(file);
  from.removeFile(file);
}

/* ── 트리거 ──────────────────────────────────────────────────────────────── */
function setupTrigger() {
  var fns = ScriptApp.getProjectTriggers();
  for (var i = 0; i < fns.length; i++) {
    if (fns[i].getHandlerFunction() === 'runBridge') ScriptApp.deleteTrigger(fns[i]);
  }
  ScriptApp.newTrigger('runBridge').timeBased().everyMinutes(10).create();
  Logger.log('10분 트리거를 걸었습니다.');
}
function runOnce() { runBridge(); }

/* ── 본체 ────────────────────────────────────────────────────────────────── */
function runBridge() {
  /* 트리거가 겹치면 같은 파일을 두 번 보낸다. Edge 가 중복을 걸러주긴 하지만
     '완료' 이동과 경합하면 파일이 사라지거나 두 번 세어진다 — 아예 겹치지 않게 막는다. */
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) { Logger.log('다른 실행이 진행 중 — 건너뜁니다.'); return; }

  try {
    var d = dirs_();
    /* 확장자로만 고른다 — 업로더에 따라 mime 이 text/plain·application/json 으로 갈려
       getFilesByType 하나로는 놓치는 파일이 생긴다. */
    var files = [], it = d.inbox.getFiles();
    while (it.hasNext() && files.length < MAX_FILES_PER_RUN) {
      var f = it.next();
      if (/\.json$/i.test(f.getName())) files.push(f);
    }
    if (!files.length) { Logger.log('대기 파일 없음.'); return; }

    /* 오래된 것부터 — 날짜 순서대로 적재돼야 잔액 추이가 어긋나지 않는다 */
    files.sort(function (a, b) { return a.getName() < b.getName() ? -1 : a.getName() > b.getName() ? 1 : 0; });

    var okN = 0, holdN = 0, errN = 0, lines = [];
    for (var i = 0; i < files.length; i++) {
      var r = processFile_(files[i], d);
      lines.push(r.line);
      if (r.state === 'ok') okN++; else if (r.state === 'hold') holdN++; else errN++;
    }

    var props = PropertiesService.getScriptProperties();
    props.setProperty('BRIDGE_LAST_RUN', new Date().toISOString());
    if (okN) props.setProperty('BRIDGE_LAST_OK', new Date().toISOString());
    Logger.log(lines.join('\n'));

    /* 성공만 있었으면 조용히 넘어간다 — 매번 오는 알림은 곧 안 읽게 된다 */
    if (holdN || errN) {
      notify_('[자금 대시보드] 클로브 자동적재 ' + (holdN ? '검증 보류 ' + holdN + '건 ' : '') + (errN ? '오류 ' + errN + '건' : ''),
        lines.join('\n') + '\n\n' +
        '· 보류: Drive ' + ROOT_FOLDER + '/' + DIR_HOLD + ' 에 있습니다. 사유를 확인하고 판단해 주세요.\n' +
        '· 오류: 파일을 대기에 그대로 뒀습니다. 다음 실행이 다시 시도합니다.');
    }
  } finally {
    lock.releaseLock();
  }
}

function processFile_(file, d) {
  var name = file.getName();
  var payload;
  try {
    payload = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
  } catch (e) {
    move_(file, d.inbox, d.hold);
    return { state: 'hold', line: '⛔ ' + name + ' — JSON 파싱 실패: ' + e.message + ' (보류로 이동)' };
  }

  /* 클라우드 루틴이 넘기는 모양:
       { pages, fxAccounts, fxRef, fxRefAsOf, allowToday?, allowLargeCancel? }
     pages 가 없으면 형식이 다른 파일이므로 보류한다 — 억지로 해석하지 않는다. */
  if (!payload || !payload.pages) {
    move_(file, d.inbox, d.hold);
    return { state: 'hold', line: '⛔ ' + name + ' — pages 가 없습니다 (보류로 이동)' };
  }

  var res, code = 0, body = {};
  try {
    res = UrlFetchApp.fetch(EDGE_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        apikey: SUPA_PUBLISHABLE_KEY,
        Authorization: 'Bearer ' + SUPA_PUBLISHABLE_KEY,
      },
      payload: JSON.stringify({
        secret: getSecret_(),
        action: 'ingest',
        pages: payload.pages,
        fxAccounts: payload.fxAccounts || {},
        fxRef: payload.fxRef || 0,
        fxRefAsOf: payload.fxRefAsOf || null,
        allowToday: !!payload.allowToday,
        allowLargeCancel: !!payload.allowLargeCancel,
      }),
      muteHttpExceptions: true,
    });
    code = res.getResponseCode();
    try { body = JSON.parse(res.getContentText() || '{}'); } catch (e) {}
  } catch (e) {
    /* 네트워크 장애 — 파일을 그대로 둬 다음 실행이 다시 시도하게 한다 */
    return { state: 'err', line: '… ' + name + ' — 호출 실패(재시도 예정): ' + e.message };
  }

  if (code === 200 && body.ok) {
    move_(file, d.inbox, d.done);
    var note = '✅ ' + name + ' — 추가 ' + (body.added || 0) + '건 · 중복 ' + (body.skipped || 0) + '건';
    if (body.refreshed) note += ' · 적요 갱신 ' + body.refreshed + '건';
    return { state: 'ok', line: note };
  }

  if (code === 422 && body.aborted) {
    /* 검증에 걸렸다 — **성공으로 처리하지 않는다.** 가드가 무의미해진다.
       보류로 옮겨 사람이 사유를 보고 판단하게 한다. */
    move_(file, d.inbox, d.hold);
    return { state: 'hold', line: '⛔ ' + name + ' — 검증 중단 [' + body.code + '] ' + (body.error || '') + ' (보류로 이동)' };
  }

  /* 그 밖의 실패(5xx·인증 등)는 일시적일 수 있으므로 파일을 두고 재시도한다 */
  return { state: 'err', line: '… ' + name + ' — HTTP ' + code + ' ' + (body.error || '').slice(0, 120) + ' (재시도 예정)' };
}

function notify_(subject, body) {
  try {
    var to = NOTIFY_TO || Session.getEffectiveUser().getEmail();
    if (to) MailApp.sendEmail(to, subject, body);
  } catch (e) { Logger.log('알림 발송 실패: ' + e.message); }
}

/* ── 점검용 ──────────────────────────────────────────────────────────────── */
function status() {
  var p = PropertiesService.getScriptProperties();
  var d = dirs_();
  var count = function (f) { var n = 0, it = f.getFiles(); while (it.hasNext()) { it.next(); n++; } return n; };
  Logger.log([
    '마지막 실행   : ' + (p.getProperty('BRIDGE_LAST_RUN') || '(없음)'),
    '마지막 적재   : ' + (p.getProperty('BRIDGE_LAST_OK') || '(없음)'),
    '대기 / 완료 / 보류 : ' + count(d.inbox) + ' / ' + count(d.done) + ' / ' + count(d.hold),
    '시크릿 설정   : ' + (p.getProperty('BANK_SYNC_SECRET') ? '있음' : '⚠ 없음'),
  ].join('\n'));
}

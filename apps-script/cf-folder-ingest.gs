/**
 * cf-folder-ingest.gs — 구글 드라이브 폴더의 입출금(CF) 엑셀을 파싱해
 * Supabase Edge Function(cf-folder-ingest)으로 cf_data에 적재.
 *
 * 흐름: [업로드 폴더]에 xlsx 드롭 → 시간 트리거가 감지 → 파싱 → Edge Function push
 *       → 성공 시 [완료 폴더], 실패 시 [오류 폴더]로 이동, 결과 로그.
 * 중분류는 빈칸으로 적재됨 → 대시보드 "✨ 자동분류 추천"으로 분류.
 *
 * ※ 공유 드라이브(RAWGA_현금) 사용:
 *    - Drive 고급 서비스 v2 필요 (식별자 Drive). xlsxToValues_ 는 v2 insert+convert 사용.
 *    - 파일 이동은 공유 드라이브 호환 위해 Drive.Files.update(supportsAllDrives) 사용.
 *
 * 설치(가이드 참고):
 *  1) Apps Script에 이 파일 붙여넣기
 *  2) 서비스에서 "Drive API" 고급 서비스 v2 사용 설정 (식별자 Drive)
 *  3) 아래 폴더 ID 3개 입력 + 스크립트 속성 CF_SYNC_SECRET 설정
 *     (Supabase Edge Function의 CF_SYNC_SECRET 시크릿과 동일 값)
 *  4) installTrigger() 1회 실행(10분마다 자동 적재) — 또는 메뉴에서 수동 실행
 */

// ⚠ Supabase 함수 URL 슬러그 = clever-endpoint (대시보드 표시명은 cf-folder-ingest지만 실제 invoke 슬러그는 clever-endpoint로 고정)
var EDGE_URL = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/clever-endpoint';

// ▼▼ 드라이브 폴더 ID 3개 (폴더 URL의 .../folders/<여기> 부분) ▼▼
var INBOX_FOLDER_ID = '1QdNNqxyF3o2qqR3mftalqiDxDmBZRkes';
var DONE_FOLDER_ID  = '1oEpbYu86u8dxgYY7UQykL08srWPw1xKj';
var ERROR_FOLDER_ID = '1SQO5SlHC1ekFOXs2FcRjuXKZBS0ntm2q';
// ▲▲

// CF 컬럼 후보 (대시보드 CF_FIELDS와 동일 — 헤더 이름으로 자동 감지)
var CF_CANDIDATES = {
  date:   ['거래일', '날짜', 'date', '일자'],
  desc:   ['거래내용', '내용', '적요', 'desc', 'description', '거래처'],
  desc_alt: ['거래자명', '거래자', '예금주', '상대방'],   // 적요(desc) 비었을 때 거래내용 폴백 (클로브 계좌간 이체 등 적요 공란 행)
  in:     ['입금액', '입금', 'in', 'credit', '수입'],
  out:    ['출금액', '출금', 'out', 'debit', '지출액'],
  amount: ['금액', 'amount', '잔액변동'],
  status: ['상태', 'status'],
  // (선택) 클로브 연동 파일용 — 없으면 무시(하위호환). 일반 은행 xlsx엔 이 헤더가 없어 영향 없음.
  mid:      ['중분류'],
  clobe_id: ['clobe_id', '클로브id', 'clobeid'],
};

function getSecret_() {
  var s = PropertiesService.getScriptProperties().getProperty('CF_SYNC_SECRET');
  if (!s) throw new Error('스크립트 속성 CF_SYNC_SECRET 이 없습니다. [프로젝트 설정 > 스크립트 속성]에 추가하세요.');
  return s;
}

function norm_(s) { return String(s == null ? '' : s).toLowerCase().replace(/[\s_\-\/]/g, ''); }
function num_(v) {
  if (typeof v === 'number') return v;
  var n = parseFloat(String(v == null ? '' : v).replace(/[,₩\s]/g, ''));
  return isNaN(n) ? 0 : n;
}
function dstr_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]')
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var s = String(v == null ? '' : v).replace(/[./]/g, '-').trim();
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  return s.slice(0, 10);
}
function detect_(headers, cands) {
  for (var i = 0; i < cands.length; i++) {
    var c = norm_(cands[i]);
    for (var j = 0; j < headers.length; j++) {
      if (headers[j] && norm_(headers[j]).indexOf(c) >= 0) return j;
    }
  }
  return -1;
}

/** 메뉴 (스프레드시트에 바인딩한 경우에만 표시; standalone이면 무시) */
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('CF 적재')
      .addItem('① 파싱 미리보기(첫 파일)', 'previewFirst')
      .addItem('② 지금 적재 실행', 'ingestNewFiles')
      .addToUi();
  } catch (e) {}
}

/** 10분마다 자동 적재 트리거 설치 — 1회 실행 */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'ingestNewFiles') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('ingestNewFiles').timeBased().everyMinutes(10).create();
  return '트리거 설치 완료 (10분마다 ingestNewFiles 실행)';
}

/** xlsx 파일 → 임시 구글시트 변환 후 첫 시트 값 배열 반환 (Drive 고급 서비스 v2) */
function xlsxToValues_(file) {
  var resource = { title: '_cftmp_' + file.getName(), mimeType: MimeType.GOOGLE_SHEETS };
  var tmp = Drive.Files.insert(resource, file.getBlob(), { convert: true });
  try {
    var ss = SpreadsheetApp.openById(tmp.id);
    return ss.getSheets()[0].getDataRange().getValues();
  } finally {
    try { Drive.Files.remove(tmp.id); } catch (e) {}
  }
}

/** 값 배열 → CF 행 [{date,desc,in,out,status,(mid),(clobe_id)}]. mid/clobe_id는 헤더 있을 때만(클로브 CSV). */
function parseValues_(values) {
  if (!values || values.length < 2) return { rows: [], note: '데이터 행 없음' };
  var headers = values[0];
  var idx = {};
  for (var k in CF_CANDIDATES) idx[k] = detect_(headers, CF_CANDIDATES[k]);
  if (idx.date < 0) return { rows: [], note: '⚠ 거래일 컬럼 못 찾음 (헤더 확인)' };

  var out = [], skipped = 0;
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var date = dstr_(row[idx.date]);
    var desc = idx.desc >= 0 ? String(row[idx.desc] || '').trim() : '';
    var descAlt = idx.desc_alt >= 0 ? String(row[idx.desc_alt] || '').trim() : '';  // 적요 비면 거래자명 폴백
    var inA = 0, outA = 0;
    if (idx.amount >= 0) { var v = num_(row[idx.amount]); if (v > 0) inA = v; else outA = -v; }
    if (idx.in  >= 0 && row[idx.in])  inA  = num_(row[idx.in]);
    if (idx.out >= 0 && row[idx.out]) outA = num_(row[idx.out]);
    var status = idx.status >= 0 ? String(row[idx.status] || '').trim() : '';
    if (!date || (inA === 0 && outA === 0)) { skipped++; continue; }
    var rec = { date: date, desc: desc || descAlt || '(거래내용 없음)', in: inA, out: outA, status: status };
    // (선택) 클로브 연동 필드 — 있을 때만 전달(하위호환)
    if (idx.mid      >= 0) { var m = String(row[idx.mid] || '').trim();      if (m) rec.mid = m; }
    if (idx.clobe_id >= 0) { var c = String(row[idx.clobe_id] || '').trim(); if (c) rec.clobe_id = c; }
    out.push(rec);
  }
  return { rows: out, note: '파싱 ' + out.length + '건 (건너뜀 ' + skipped + ')' };
}

function postRows_(rows) {
  var res = UrlFetchApp.fetch(EDGE_URL, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ secret: getSecret_(), action: 'push', rows: rows }),
  });
  return { code: res.getResponseCode(), body: res.getContentText() };
}

/** 파일을 folder 로 이동 (공유 드라이브 호환 — 고급 Drive 서비스 사용) */
function moveFile_(file, folder) {
  var fileId = file.getId();
  var meta = Drive.Files.get(fileId, { supportsAllDrives: true });
  var removeIds = (meta.parents || []).map(function (p) { return p.id; }).join(',');
  Drive.Files.update({}, fileId, null, {
    addParents: folder.getId(),
    removeParents: removeIds,
    supportsAllDrives: true
  });
}

/** ① 미리보기: 업로드 폴더 첫 파일을 파싱만 (적재 안 함) */
function previewFirst() {
  var inbox = DriveApp.getFolderById(INBOX_FOLDER_ID);
  var files = inbox.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    if (!/\.(xlsx|xls|csv)$/i.test(f.getName())) continue;
    var p = parseValues_(xlsxToValues_(f));
    var sample = p.rows.slice(0, 5).map(function (r) {
      return r.date + ' | ' + r.desc + ' | 입 ' + r.in + ' 출 ' + r.out + ' | ' + (r.status || '(자동)');
    }).join('\n');
    var msg = f.getName() + '\n' + p.note + '\n\n[상위 5건]\n' + sample;
    try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
    return msg;
  }
  var none = '업로드 폴더에 xlsx 파일이 없습니다.';
  try { SpreadsheetApp.getUi().alert(none); } catch (e) { Logger.log(none); }
  return none;
}

/** ② 적재: 업로드 폴더의 모든 xlsx 파싱 → Edge Function push → 완료/오류 폴더로 이동 */
function ingestNewFiles() {
  var inbox = DriveApp.getFolderById(INBOX_FOLDER_ID);
  var done  = DriveApp.getFolderById(DONE_FOLDER_ID);
  var err   = DriveApp.getFolderById(ERROR_FOLDER_ID);
  var files = inbox.getFiles();
  var summary = [];

  while (files.hasNext()) {
    var f = files.next();
    var name = f.getName();
    if (!/\.(xlsx|xls|csv)$/i.test(name)) continue;
    try {
      var p = parseValues_(xlsxToValues_(f));
      if (!p.rows.length) { moveFile_(f, err); summary.push('⚠ ' + name + ': ' + p.note); continue; }
      var r = postRows_(p.rows);
      if (r.code === 200) {
        var j = JSON.parse(r.body);
        moveFile_(f, done);
        summary.push('✓ ' + name + ': 추가 ' + j.added + ' / 중복·제외 ' + j.skipped + ' (cf_data 총 ' + j.total + ')');
      } else {
        moveFile_(f, err);
        summary.push('✗ ' + name + ': HTTP ' + r.code + ' ' + r.body);
      }
    } catch (e) {
      try { moveFile_(f, err); } catch (_) {}
      summary.push('✗ ' + name + ': ' + e.message);
    }
  }

  var out = summary.length ? summary.join('\n') : '처리할 xlsx 파일이 없습니다.';
  Logger.log(out);
  return out;
}

/**
 * RAWGA 매출채권(AR) ↔ 대시보드 동기화 — Google Apps Script (멀티탭 / 헤더이름 매핑)
 *
 * 동작: 워크북의 업체별 탭을 읽어 → 대시보드 ar_data를 "전체 교체" 한다.
 *   - 컬럼은 위치가 아니라 헤더 '이름'으로 찾음(열 이동에 강함)
 *   - partner(거래처) = 탭(시트) 이름
 *   - 미회수 열이 있는 탭은 그 값 사용, 없으면 (예상-회수)로 자동 계산
 *
 * 메뉴(시트 새로고침 후 'RAWGA 동기화'):
 *   ① 미리보기(검증)     : 파싱 결과를 'AR_preview' 시트 + 요약창에 표시(대시보드 변경 X) — 먼저 꼭 실행
 *   ② 대시보드로 동기화   : 파싱 결과로 대시보드 AR을 교체(되돌릴 수 없으니 ① 확인 후)
 *
 * 설치: 확장 프로그램>Apps Script에 붙여넣고 저장 → 프로젝트설정>스크립트속성에 AR_SYNC_SECRET 추가 → 시트 새로고침
 *
 * 2026-07 수정: ① 천대표(부산영업) 탭 추가  ② fmtDate_ 날짜 시리얼 처리
 *              ③ 설정 없는 탭을 미리보기/동기화에서 눈에 띄게 경고(새 거래처 조용한 누락 방지)
 *              ④ 동기화 안전가드: 설정없는 탭 있으면 중단 + 직전 대비 건수 급감 시 재확인
 *                 (실수로 데이터가 통째 사라지는 것 방지. 기준 건수는 스크립트속성 AR_LAST_COUNT에 자동 저장)
 */

// ⚠ Supabase 함수 slug = quick-service (대시보드에서 이름은 ar-sheet-sync로 표시되나 URL slug는 quick-service로 고정됨)
var EDGE_URL = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/quick-service';

// 동기화에서 제외할 탭(전체현황·미리보기 등)
var EXCLUDE_TABS = ['인오가닉사업 전체현황', 'AR_preview'];

// 탭별 매핑: 키 = 탭(시트) 이름과 일치해야 함. 값 = 각 필드의 헤더 텍스트.
//  - remaining 이 ''(빈값)이면 (예상-회수)로 자동 계산
//  - start/due/collect 는 화면에서 추정한 값 — 미리보기로 확인 후 필요시 수정
var TAB_CONFIG = {
  'CNA':            { expected: '세금계산서 발행가액', collected: '실제 입금액',  remaining: '',       start: '송금날짜', due: '입금예정일', collect: '실제 입금날짜', zeroExpectedNearValues: [763760] },
  '핀다':           { expected: '부가세 포함금액',     collected: '최종 회수액',  remaining: '미회수액', start: '송금날짜', due: '예상회수일', collect: '회수일' },
  'JHT':            { expected: '예상입금액',         collected: '실제 입금액',  remaining: '',       start: '송금일',   due: '예상 입금일', collect: '입금일' },
  '팬텀':           { expected: '총 회수예정액',       collected: '최종 회수액',  remaining: '',       start: '송금날짜', due: '예상회수일', collect: '회수일' },
  '천대표':         { expected: '총 회수예정액',       collected: '실제 회수액',  remaining: '미회수액', start: '송금날짜', due: '예상회수일', collect: '회수일' },
  '천대표(부산영업)': { expected: '예상회수액',         collected: '최종 회수액(1)', remaining: '',      start: '송금일',   due: '예상회수일', collect: '최종회수일(1)' },
  '동이식품':       { expected: '매출액',             collected: '현재 회수액',  remaining: '미회수금액', start: '송금일',   due: '예상회수일', collect: '실제회수일' },
  '지앤원':         { expected: '입금예정액(vat포함)', collected: '입금액',      remaining: '',       start: '지출일자', due: '예정입금일', collect: '입금일자' },
  '숯':             { expected: '양도금액(원화)',      collected: '수금액(원화)', remaining: '',       start: '송금일',   due: '',         collect: '수금일' },
  '로가온':         { expected: '금액',               collected: '회수금액',     remaining: '',       start: '날짜',     due: '회수예정일', collect: '회수일자' },
  '디앤비푸드':      { expected: '매출액',             collected: '현재 회수액',  remaining: '',       start: '귀속월',   due: '회수예정일', collect: '' },
  '세진식품':       { expected: '회수예상금액',       collected: '회수금액',     remaining: '미회수금액', start: '송금날짜', due: '회수일정', collect: '' },
  '기타대여금':      { expected: '예상회수액',         collected: '회수액',       remaining: '',       start: '날짜',     due: '',         collect: '' },
};

var FIELDS = ['expected', 'collected', 'remaining', 'start', 'due', 'collect'];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('RAWGA 동기화')
    .addItem('① 미리보기(검증)', 'previewSync')
    .addItem('② 대시보드로 동기화', 'pushToDashboard')
    .addToUi();
}

function getSecret_() {
  var s = PropertiesService.getScriptProperties().getProperty('AR_SYNC_SECRET');
  if (!s) throw new Error('스크립트 속성에 AR_SYNC_SECRET 이 없습니다. [프로젝트 설정 > 스크립트 속성]에 추가하세요.');
  return s;
}

function norm_(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, '').trim(); }

function num_(v) {
  if (v === '' || v == null) return 0;
  if (typeof v === 'number') return v;
  var neg = /^\(.*\)$/.test(String(v).trim());
  var s = String(v).replace(/[^0-9.\-]/g, '');
  var n = parseFloat(s);
  if (isNaN(n)) return 0;
  return neg ? -Math.abs(n) : n;
}

function fmtDate_(v) {
  if (v === '' || v == null) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  // 구글시트 날짜 시리얼 숫자 (예: 45961 → 2025-10-31) — 천대표 '회수일' 등
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    var base = new Date(Date.UTC(1899, 11, 30));
    var d = new Date(base.getTime() + Math.round(v) * 86400000);
    return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
  }
  var s = String(v).trim();
  var m = s.match(/^(\d{4})[.\-\/]\s*(\d{1,2})[.\-\/]\s*(\d{1,2})/);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  return s;
}

// 행의 어느 셀이든 키워드(공백 무시) 중 하나를 포함하면 true
function rowHasKeyword_(rowVals, keywords) {
  for (var i = 0; i < rowVals.length; i++) {
    var c = String(rowVals[i] == null ? '' : rowVals[i]).replace(/\s+/g, '');
    for (var k = 0; k < keywords.length; k++) {
      if (c.indexOf(String(keywords[k]).replace(/\s+/g, '')) >= 0) return true;
    }
  }
  return false;
}

function isSummaryRow_(rowVals) {
  for (var i = 0; i < rowVals.length; i++) {
    var c = String(rowVals[i] == null ? '' : rowVals[i]).replace(/\s+/g, ''); // 공백 제거('합 계'→'합계')
    if (c.indexOf('누적') >= 0 || c.indexOf('합계') >= 0 || c.indexOf('소계') >= 0 ||
        c.indexOf('누계') >= 0 || c.indexOf('총계') >= 0) return true;
  }
  return false;
}

/**
 * 과입금(회수 > 예상) 자동 감지 시에만, 그 거래처의 회수액을 2단 우선순위로 예상회수액
 * 상한까지 재배분한다: ①실제 회수일 있는 행 먼저(회수일 순) → ②나머지 오래된 송금일 순.
 * (예: 로가온 — 오래된 채권부터 lump로 처리되며 한 행에 회수가 몰려 예상 초과 → 음수 미회수 교정)
 *  - 총 회수·총 예상은 보존(재분배만). 거래처 미회수 합계·KPI는 불변.
 *  - 진짜 초과분(총회수 > 총예상, 예: 회수이자)은 가장 최근 행에 남겨 음수 미회수 유지(기존 'clamp 안 함' 결정과 일관).
 *  - 예상이 0/음수인 행은 상한 0 → 회수 0으로 비우고 그 금액을 오래된 채권으로 흘려보냄
 *    (단, 음수 예상 자체는 시트 원본 오류 — FIFO로 고쳐지지 않으니 별도 정정 필요).
 * 반환: { changed, moved }  moved = 회수액이 조정된 행 수
 */
function allocateFifoIfOvercollected_(records) {
  if (!records || !records.length) return { changed: false, moved: 0 };
  var TOL = 1; // 부동소수 오차 무시

  // 1) 과입금 감지: 예상이 양수인데 회수가 예상을 초과하는 행이 하나라도 있으면 발동
  var over = false;
  for (var i = 0; i < records.length; i++) {
    if (records[i].expected > 0 && (records[i].collected || 0) > records[i].expected + TOL) { over = true; break; }
  }
  if (!over) return { changed: false, moved: 0 };

  // 2) 총 회수액 + 원본 백업(변경 건수 집계용)
  var totalCollected = 0, before = [];
  for (var j = 0; j < records.length; j++) { totalCollected += (records[j].collected || 0); before.push(records[j].collected || 0); }

  // 3) 2단 정렬: ①실제 회수일(collect_date) 있는 행 우선(회수일 순) → ②나머지 오래된 송금일 순
  //    회수일 찍힌 행 = 실제로 걷힌 것이므로 먼저 정산, 그 뒤 남은 회수액을 오래된 채권부터.
  //    (회수일 열 없는 탭은 전부 회수일 '' → 자동으로 ②오래된 순만 = 현행과 동일)
  var order = [];
  for (var k = 0; k < records.length; k++) order.push(k);
  order.sort(function (a, b) {
    var ra = records[a], rb = records[b];
    var ca = ra.collect_date ? String(ra.collect_date).trim() : '';
    var cb = rb.collect_date ? String(rb.collect_date).trim() : '';
    var hasA = ca !== '', hasB = cb !== '';
    if (hasA !== hasB) return hasA ? -1 : 1;                 // 회수일 있는 행 먼저
    if (hasA && hasB && ca !== cb) return ca < cb ? -1 : 1;  // 둘 다 있으면 회수일 순
    var sa = ra.start || '9999-99-99', sb = rb.start || '9999-99-99';  // 나머지는 오래된 송금일 순
    if (sa !== sb) return sa < sb ? -1 : 1;
    return a - b;                                            // 동률은 원래 순서
  });

  // 4) FIFO 배분 (예상 상한까지)
  var pool = totalCollected;
  for (var o = 0; o < order.length; o++) {
    var rec = records[order[o]];
    var cap = rec.expected > 0 ? rec.expected : 0;
    var alloc = Math.min(pool, cap);
    if (alloc < 0) alloc = 0;
    rec.collected = alloc;
    pool -= alloc;
    if (rec.remaining !== undefined) rec.remaining = rec.expected - alloc; // 미회수 열 보유 탭은 재계산
  }
  // 5) 진짜 초과분(총회수 > 총예상) → 가장 최근 행에 남김 (음수 미회수 유지)
  if (pool > TOL && order.length) {
    var last = records[order[order.length - 1]];
    last.collected += pool;
    if (last.remaining !== undefined) last.remaining = last.expected - last.collected;
  }

  var moved = 0;
  for (var m = 0; m < records.length; m++) if (Math.abs((records[m].collected || 0) - before[m]) > TOL) moved++;
  return { changed: moved > 0, moved: moved };
}

// 한 탭 파싱 → { records:[], note:'' }
function parseTab_(sh, cfg) {
  var values = sh.getDataRange().getValues();
  if (!values.length) return { records: [], note: '빈 시트' };

  // 헤더 행 찾기: expected 헤더가 들어있는 행 (상단 20행 내)
  var wantExp = norm_(cfg.expected);
  var headerRow = -1, colMap = {};
  for (var r = 0; r < Math.min(values.length, 20); r++) {
    var rowNorm = values[r].map(norm_);
    if (rowNorm.indexOf(wantExp) >= 0) {
      headerRow = r;
      FIELDS.forEach(function (f) {
        if (cfg[f]) { var ci = rowNorm.indexOf(norm_(cfg[f])); if (ci >= 0) colMap[f] = ci; }
      });
      break;
    }
  }
  if (headerRow < 0) return { records: [], note: '⚠ 헤더(예상회수액=' + cfg.expected + ') 못 찾음' };
  if (colMap.expected === undefined) return { records: [], note: '⚠ 예상회수액 열 못 찾음' };

  var records = [];
  for (var i = headerRow + 1; i < values.length; i++) {
    var row = values[i];
    // ── (옵트인) 키워드 제외: config의 excludeKeywords 중 하나라도 행에 있으면 제외 ──
    //   예: CNA의 '통관경비'(매출 아님) 행 제외. 다른 탭엔 영향 없음.
    if (cfg.excludeKeywords && rowHasKeyword_(row, cfg.excludeKeywords)) continue;
    if (isSummaryRow_(row)) continue;
    // start 열이 있으면 비어있는 행(누적/공백) 제외
    if (colMap.start !== undefined && !String(row[colMap.start] || '').trim()) continue;

    var expected = num_(row[colMap.expected]);
    var collected = colMap.collected !== undefined ? num_(row[colMap.collected]) : 0;
    // ── (옵트인) 발행가액 미반영: 발행가액이 지정값(±tol)인 행은 expected=0, 실제입금액만 반영 ──
    //   예: CNA 통관경비 정산행(발행가액 763,759.7) → expected=0, collected(실제입금액)은 유지.
    //   소수점·날짜 형식과 무관하게 값으로 유일 식별.
    if (cfg.zeroExpectedNearValues) {
      for (var z = 0; z < cfg.zeroExpectedNearValues.length; z++) {
        if (Math.abs(expected - cfg.zeroExpectedNearValues[z]) <= 2) { expected = 0; break; }
      }
    }
    if (expected === 0 && collected === 0) continue; // 빈 행 제외

    var rec = {
      _id: '',
      partner: sh.getName(),
      start: colMap.start !== undefined ? fmtDate_(row[colMap.start]) : '',
      expected: expected,
      collected: collected,
      due_date: colMap.due !== undefined ? fmtDate_(row[colMap.due]) : '',
      collect_date: colMap.collect !== undefined ? fmtDate_(row[colMap.collect]) : '',
      note: '',
    };
    // 회수액 없는 행(미회수)에 실제 입금일이 잘못 찍혀 있으면 공란 (입금 없으면 입금일도 없음).
    // FIFO 2단 정렬 전에 정리해야 stray 회수일이 '회수일 있는 행'으로 잘못 우선순위 먹지 않음 (예: 팬텀).
    if (!(rec.collected > 0)) rec.collect_date = '';
    // 미회수 열이 있는 탭만 remaining 전달(없으면 Edge가 예상-회수로 계산)
    if (colMap.remaining !== undefined) rec.remaining = num_(row[colMap.remaining]);
    records.push(rec);
  }

  // 과입금 감지 시 오래된 채권부터 예상액 상한으로 회수액 FIFO 재배분 (감지 안 되면 원본 그대로)
  var fifo = allocateFifoIfOvercollected_(records);

  // 불변식 재적용: 재배분으로 회수액이 0이 된 행은 실제 입금일 공란
  for (var ci = 0; ci < records.length; ci++) { if (!(records[ci].collected > 0)) records[ci].collect_date = ''; }

  var foundCols = FIELDS.filter(function (f) { return colMap[f] !== undefined; });
  return {
    records: records,
    fifo: fifo,
    note: 'OK (헤더 ' + (headerRow + 1) + '행, 매핑: ' + foundCols.join(',') + ')' +
          (fifo.changed ? ' ⚙과입금 FIFO 재배분(' + fifo.moved + '행 조정)' : '')
  };
}

// 전체 탭 파싱 → { records:[], report:[], skipped:[] }
function parseAll_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var records = [], report = [], skipped = [], fifoTabs = [];
  var configured = {};

  sheets.forEach(function (sh) {
    var name = sh.getName();
    if (EXCLUDE_TABS.indexOf(name) >= 0) return;
    var cfg = TAB_CONFIG[name];
    if (!cfg) { skipped.push(name); report.push('· ' + name + ' : (설정 없음 — 건너뜀)'); return; }
    configured[name] = true;
    var res = parseTab_(sh, cfg);
    if (res.fifo && res.fifo.changed) fifoTabs.push(name + '(' + res.fifo.moved + '행)');
    var sumE = res.records.reduce(function (s, r) { return s + r.expected; }, 0);
    var sumC = res.records.reduce(function (s, r) { return s + r.collected; }, 0);
    report.push('· ' + name + ' : ' + res.records.length + '건, 예상 ' + Math.round(sumE).toLocaleString() + ' / 회수 ' + Math.round(sumC).toLocaleString() + ' — ' + res.note);
    records = records.concat(res.records);
  });

  // 설정엔 있는데 탭이 없는 경우 경고
  Object.keys(TAB_CONFIG).forEach(function (k) {
    if (!configured[k]) report.push('⚠ 설정에 있으나 탭 못 찾음: ' + k + ' (탭 이름 확인 필요)');
  });

  return { records: records, report: report, skipped: skipped, fifoTabs: fifoTabs };
}

// ① 미리보기(검증) — 대시보드 변경 없이 파싱 결과 표시
function previewSync() {
  var ui = SpreadsheetApp.getUi();
  var out = parseAll_();
  // AR_preview 시트에 파싱 결과 기록
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('AR_preview');
  if (!sh) sh = ss.insertSheet('AR_preview');
  sh.clearContents();
  var HEAD = ['거래처', '시작일', '예상회수액', '회수액', '미회수(또는 자동)', '회수예정일', '실제입금일'];
  sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold');
  if (out.records.length) {
    var rows = out.records.map(function (r) {
      return [r.partner, r.start, r.expected, r.collected,
              (r.remaining !== undefined ? r.remaining : (r.expected - r.collected)),
              r.due_date, r.collect_date];
    });
    sh.getRange(2, 1, rows.length, HEAD.length).setValues(rows);
  }
  var totalE = out.records.reduce(function (s, r) { return s + r.expected; }, 0);
  var totalC = out.records.reduce(function (s, r) { return s + r.collected; }, 0);
  var warn = out.skipped && out.skipped.length
    ? '⚠ 설정이 없어 대시보드에서 빠지는 탭: ' + out.skipped.join(', ') +
      '\n   → TAB_CONFIG에 추가해야 반영됩니다.\n\n'
    : '';
  var fifoMsg = out.fifoTabs && out.fifoTabs.length
    ? '⚙ 과입금 감지 → FIFO 재배분된 탭: ' + out.fifoTabs.join(', ') +
      '\n   회수액을 오래된 채권부터 예상액 상한으로 재분배(총액 불변). AR_preview에서 행별 확인하세요.\n\n'
    : '';
  ui.alert(
    warn + fifoMsg +
    '미리보기 (대시보드 변경 없음)\n\n' +
    '총 ' + out.records.length + '건\n예상회수 합계: ' + Math.round(totalE).toLocaleString() + '\n회수 합계: ' + Math.round(totalC).toLocaleString() +
    '\n\n[탭별]\n' + out.report.join('\n') +
    '\n\n※ 결과는 AR_preview 시트에서 행단위로 확인하세요. 이상 없으면 ②동기화 실행.'
  );
}

// ② 대시보드로 동기화 (실제 교체)
function pushToDashboard() {
  var ui = SpreadsheetApp.getUi();
  var out = parseAll_();
  if (!out.records.length) { ui.alert('파싱된 데이터가 없습니다. 먼저 ①미리보기로 확인하세요.'); return; }

  // ── 안전가드 ①: 설정 없는 탭이 있으면 중단 (그 거래처가 통째로 사라짐) ──
  if (out.skipped && out.skipped.length) {
    ui.alert('⛔ 동기화 중단 (데이터 보호)\n\n' +
      '설정(TAB_CONFIG)이 없어 빠지는 탭: ' + out.skipped.join(', ') + '\n\n' +
      '이대로 진행하면 이 거래처들이 대시보드에서 사라집니다.\n' +
      '· 반영하려면 → TAB_CONFIG에 해당 탭을 추가 후 다시 시도\n' +
      '· 원래 제외 대상이면 → EXCLUDE_TABS에 추가');
    return;
  }

  // ── 안전가드 ②: 직전 성공 대비 건수 급감 방지 (매핑 실패로 인한 누락 차단) ──
  var props = PropertiesService.getScriptProperties();
  var lastCount = parseInt(props.getProperty('AR_LAST_COUNT') || '0', 10);
  var now = out.records.length;
  if (lastCount > 0 && now < lastCount * 0.8) {
    var okDrop = ui.alert('⚠ 건수 급감 감지 (데이터 보호)\n\n' +
      '직전 동기화 ' + lastCount + '건 → 이번 ' + now + '건 (' +
      Math.round((1 - now / lastCount) * 100) + '% 감소)\n\n' +
      '탭 매핑 실패로 데이터가 누락됐을 수 있습니다.\n' +
      '①미리보기의 탭별 건수를 먼저 확인하세요.\n\n그래도 이 건수로 교체할까요?',
      ui.ButtonSet.YES_NO);
    if (okDrop !== ui.Button.YES) return;
  }

  var ok = ui.alert(
    '시트의 ' + now + '건으로 대시보드 매출채권을 통째 교체합니다.\n(되돌릴 수 없습니다. ①미리보기로 확인하셨나요?)\n계속할까요?',
    ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;

  var res = UrlFetchApp.fetch(EDGE_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ secret: getSecret_(), action: 'push', rows: out.records }),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var body = {};
  try { body = JSON.parse(res.getContentText() || '{}'); } catch (e) {}
  if (code !== 200 || body.error) {
    ui.alert('동기화 실패 (' + code + '): ' + (body.error || res.getContentText()));
    return;
  }
  // 성공 시 기준 건수 갱신 (다음 급감 감지용)
  props.setProperty('AR_LAST_COUNT', String(now));
  ui.alert('완료: ' + body.count + '건을 대시보드에 반영했습니다. 대시보드를 새로고침하면 반영됩니다.');
}

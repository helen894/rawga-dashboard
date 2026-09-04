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
  /* 2026-08-22: CNA 의 due 헤더가 '입금예정일' → '입금예정일 (D+45)' 로 바뀌어 41건 전부
     회수예정일이 빈 값이 됐다(경고로 발견). 예전 이름도 후보로 남긴다. */
  'CNA':            { expected: '세금계산서 발행가액', collected: '실제 입금액',  remaining: '',       start: '송금날짜', due: ['입금예정일 (D+45)', '입금예정일'], collect: '실제 입금날짜', zeroExpectedNearValues: [763760], keepNoEvidenceRows: true },
  '핀다':           { expected: '부가세 포함금액',     collected: '최종 회수액',  remaining: '미회수액', start: '송금날짜', due: '예상회수일', collect: '회수일' },
  'JHT':            { expected: '예상입금액',         collected: '실제 입금액',  remaining: '',       start: '송금일',   due: '예상 입금일', collect: '입금일' },
  '팬텀':           { expected: '총 회수예정액',       collected: '최종 회수액',  remaining: '',       start: '송금날짜', due: '예상회수일', collect: '회수일' },
  '천대표':         { expected: '총 회수예정액',       collected: '실제 회수액',  remaining: '미회수액', start: '송금날짜', due: '예상회수일', collect: '회수일' },
  /* 2026-08-21: 시트 헤더가 '최종 회수액(1)/최종회수일(1)' → 'P열 최종회수액/O열 최종회수일' 로
     바뀌었다. 예전 이름도 후보로 남겨 둔다(옛 사본 시트에서도 돌아가게). */
  '천대표(부산영업)': { expected: '예상회수액',         collected: ['최종회수액', '최종 회수액(1)'], remaining: '',      start: '송금일',   due: '예상회수일', collect: ['최종회수일', '최종회수일(1)'] },
  /* 동이식품 (2026-09-04) — remaining 매핑 제거(예상-회수 자동계산). 시트의 '미회수금액' 열이
     stale 하다: 태성수산 행이 500,000,000 중 400,000,000 회수 상태로 미회수 100,000,000 이
     적혀 있는데, 그 잔액을 갚은 2026-08-31 회수 100,000,000 이 아래 별도 행으로 들어와 있어
     총 회수 = 총 예상 = 900,000,000(전액 회수)인데 열 값만 1억으로 남았다.
     전체현황 시트도 미회수 0 으로 잡는다. 세진식품과 같은 유형.
     ※ 핀다·천대표의 미회수액 열은 예상-회수와 일치해서 그대로 쓴다(전탭 일괄 제거 아님). */
  '동이식품':       { expected: '매출액',             collected: '현재 회수액',  remaining: '',       start: '송금일',   due: '예상회수일', collect: '실제회수일' },
  //  지앤원: excludeFutureStart — 지출일자가 미래인 행은 아직 돈이 안 나갔으므로 채권이 아니다.
  //          표2의 26-08-20~26-11-20 지출 예정 4행(475,200,000)이 그 경우이고, 시트 자체 합계도
  //          이 4행을 빼고 907,748,592(과거 9행 합과 원 단위 일치)로 잡혀 있다.
  //          ⚠ keepNoEvidenceRows 는 켜지 않는다(2026-08-21 최종 확인). 표1 하단 449·450행
  //          (81,659,977 + 74,236,343)은 데이터 행이지만 지출일자가 없어 = 아직 송금 전이므로
  //          채권으로 계상하지 않는다. 그 위 446행은 두 행의 소계라 판정 ⑸ 로도 걸린다.
  //          원칙: **실제 송금이 나간 건만 채권**(지출일자 없음 = 제외 / 미래 = excludeFutureStart).
  '지앤원':         { expected: '입금예정액(vat포함)', collected: '입금액',      remaining: '',       start: '지출일자', due: '예정입금일', collect: '입금일자', excludeFutureStart: true },
  '숯':             { expected: '양도금액(원화)',      collected: '수금액(원화)', remaining: '',       start: '송금일',   due: '',         collect: '수금일' },
  /* 2026-09 신설 '숯 (확장)' — 라오스 원물수입 건. 기존 '숯' 탭과 헤더가 완전히 다르다
     (연도/차수/라오스 송금일/BL양도금액…). 탭 이름의 공백까지 정확히 일치해야 매칭된다.
     ⚠ 002~005 행은 금액이 비고 ETD/ETA 만 1900-01-02 같은 더미 날짜가 박힌 서식 행이라
       expected=0·collected=0 으로 자동 제외된다(현재 실데이터는 001 한 건뿐). */
  '숯 (확장)':       { expected: 'BL양도금액(한화)',    collected: 'BL양도 회수액', remaining: '',      start: '라오스 송금일', due: 'BL양도금액 입금 예정일', collect: 'BL양도금액 수취일' },
  '로가온':         { expected: '금액',               collected: '회수금액',     remaining: '',       start: '날짜',     due: '회수예정일', collect: '회수일자' },
  '디앤비푸드':      { expected: '매출액',             collected: '현재 회수액',  remaining: '',       start: '귀속월',   due: '회수예정일', collect: '' },
  /* 세진식품 (2026-09-04 사용자 확정) — 한 표에 성격이 다른 두 종류가 섞여 있다:
       · 실제 채권 2건  : 송금 2026-04-29 / 05-22, 각 5억, 회수예상금액 5억
       · 회수 예정 5건  : 송금날짜 칸에 **회수 예정일**(08-26 1억 · 09-30 2억 · 10-31 2억 ·
                          11-30 2억 · 12-31 3억)이 들어가고 '회수금액' 열에 예정액이 적혀 있다.
     그래서 예정 스케줄이 이미 걷힌 돈으로 집계돼 회수액이 9억 부풀었다(지앤원과 같은 구조 문제).
     → excludeFutureStart: 회수 예정일이 미래인 행 제외. 지난 08-26 건 1억만 회수로 잡힌다.
     → remaining 매핑 제거(예상-회수 자동계산). 시트의 '미회수금액' 열이 1억 회수를 반영하지
        않아 5억+5억=10억 으로 남아 있어서, 그 값을 쓰면 예상-회수(9억)와 어긋난다.
        자동계산은 전체현황 시트(예상 10억 / 회수 1억 / 미회수 9억)와 3항목 모두 일치한다. */
  '세진식품':       { expected: '회수예상금액',       collected: '회수금액',     remaining: '',       start: '송금날짜', due: '회수일정', collect: '', excludeFutureStart: true },
  '기타대여금':      { expected: '예상회수액',         collected: '회수액',       remaining: '',       start: '날짜',     due: '',         collect: '' },
};

var FIELDS = ['expected', 'collected', 'remaining', 'start', 'due', 'collect'];

/* 한 행의 금액이 이 값을 넘으면 파싱 오류로 본다 (안전가드 ③).
   전체 채권 규모가 300억대(3e10)이고 최대 행이 4억 수준이므로 1조는 30배 이상 여유가 있다.
   열이 밀려 날짜·계좌번호 같은 게 금액으로 읽히면 최소 1e14 대가 나오므로 확실히 걸린다. */
var MAX_SANE_AMOUNT = 1e12;

/* 헤더 행(정규화된 문자열 배열)에서 필드별 열 위치를 찾는다.
   같은 탭에 표가 여러 개면 표마다 다시 호출해 열 위치를 새로 잡는다(parseTab_ 참고). */
/* 필드마다 헤더 이름 후보를 여러 개 받는다(문자열 하나도 그대로 동작).
   ⚠⚠ 헤더 이름이 바뀌면 그 열을 못 찾고 **조용히 0** 이 된다 — 2026-08-21 에 천대표(부산영업)
     탭의 '최종 회수액(1)' 이 '최종회수액' 으로 바뀌면서 회수액 55건이 전부 0 이 되고 미회수가
     10.5억 부풀었다(입금은 실제로 들어와 있었다). 이름이 또 바뀌어도 예전 이름으로 계속
     잡히도록 후보 목록을 쓰고, 못 찾으면 아래 parseTab_ 이 경고를 남긴다. */
function mapCols_(rowNorm, cfg) {
  var cm = {};
  FIELDS.forEach(function (f) {
    var want = cfg[f];
    if (!want) return;
    var list = (Object.prototype.toString.call(want) === '[object Array]') ? want : [want];
    for (var i = 0; i < list.length; i++) {
      if (!list[i]) continue;
      var ci = rowNorm.indexOf(norm_(list[i]));
      if (ci >= 0) { cm[f] = ci; break; }
    }
  });
  return cm;
}
/* 한 행의 미회수액 — 미회수 열이 있는 탭은 그 값, 없으면 (예상-회수).
   AR_preview 시트에 쓰는 값과 같은 규칙이라 미리보기 요약과 시트가 항상 일치한다. */
function recRemaining_(r) {
  return (r.remaining !== undefined) ? r.remaining : (r.expected - r.collected);
}

/* 탭 이름 → 설정 찾기. 정확히 일치를 먼저 보고, 없으면 공백·대소문자를 무시해 다시 찾는다.
   ⚠⚠ 2026-09-04: '숯 (확장)' 은 TAB_CONFIG 에 넣었는데도 '설정 없음' 으로 건너뛰어졌다.
     TAB_CONFIG[name] 은 완전 일치라, 눈에 안 보이는 차이(괄호 앞 공백 유무, 줄바꿈 없는 공백
     U+00A0, 전각 괄호 등) 하나로 거래처가 통째 누락된다. 조용한 누락이 이 스크립트의 최악
     실패라(안전가드 ①이 있는 이유) 공백·대소문자는 무시하고 찾는다.
     ※ norm_ 은 \s 로 지우므로 U+00A0 도 함께 제거된다. 전각 괄호처럼 글자가 다르면 여전히
       못 찾고 '설정 없음' 으로 남으니, 그때는 안전가드 ①이 동기화를 막아 준다. */
function findCfg_(name) {
  if (TAB_CONFIG[name]) return { cfg: TAB_CONFIG[name], key: name, exact: true };
  var n = norm_(name), keys = Object.keys(TAB_CONFIG);
  for (var i = 0; i < keys.length; i++) {
    if (norm_(keys[i]) === n) return { cfg: TAB_CONFIG[keys[i]], key: keys[i], exact: false };
  }
  return null;
}

/* cfg 필드의 첫 후보 이름(경고 문구·헤더 행 탐색에 쓴다) */
function cfgNames_(want) {
  if (!want) return [];
  return (Object.prototype.toString.call(want) === '[object Array]') ? want : [want];
}

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
  /* ⚠⚠ 날짜 셀 방어 (2026-08-15 지앤원 사고) — Date 객체를 문자열로 만들면
     "Sat Jan 10 2026 00:00:00 GMT+0900 (…)" 이 되고, 아래 '숫자만 남기기'가 이걸
     "1020260000000900" = 1,020조 짜리 금액으로 바꿔 놓는다. 실제로 지앤원 탭에서
     금액 열 자리에 날짜가 들어와 예상회수 합계가 19,163조로 찍혔다.
     금액 칸에 날짜가 오는 건 예외 없이 열 매핑 오류이므로 0으로 죽인다 —
     조용히 거대 숫자로 합계를 오염시키는 것보다 0이 훨씬 안전하고, 아래
     MAX_SANE_AMOUNT 가드가 원인을 따로 잡아 준다. */
  if (Object.prototype.toString.call(v) === '[object Date]') return 0;
  var neg = /^\(.*\)$/.test(String(v).trim());
  var s = String(v).replace(/[^0-9.\-]/g, '');
  var n = parseFloat(s);
  if (isNaN(n)) return 0;
  return neg ? -Math.abs(n) : n;
}

// 오늘(스크립트 표준시) 'yyyy-MM-dd' — excludeFutureStart 판정 기준
function today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
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
  /* 2자리 연도 텍스트 날짜 (2026-09-04 추가) — '26-9-10' 처럼 월·일에 0 이 없는 것도 있다.
     날짜 셀로 입력된 것은 위 [object Date] 분기에서 처리되지만, 사람이 문자열로 치면 여기로 온다.
     정규화하지 않으면 두 곳이 조용히 깨진다:
       ① excludeFutureStart 가 'yyyy-MM-dd' 모양만 판정하므로 미래 건을 채권으로 잡는다
          (지앤원 표1의 26-9-10 두 행 82,581,954 원이 실제로 이렇게 새어 들어왔다)
       ② 대시보드는 날짜를 문자열로 비교하는데 '2026-09-04' > '26-9-10' 이 false 라
          기일이 지나도 영원히 '정상' 으로 남는다. */
  m = s.match(/^(\d{2})[.\-\/]\s*(\d{1,2})[.\-\/]\s*(\d{1,2})$/);
  if (m) return '20' + m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
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

/* 이 행 다음(빈 행은 건너뜀)이 헤더 행이면 true.
   → 그 사이에 낀 행은 '다음 표의 총계 행'이다. 지앤원 표2 총계(예상 907,748,592 /
   회수 336,632,378)가 표2 헤더 바로 위에 있어서 표1 데이터로 집계됐고, 기존 rule ⑶ 은
   회수액이 0 일 때만 걸러 이 행을 막지 못했다(회수액이 있어서 '근거 있음'으로 통과). */
// 정규화된 행에 expected 헤더 후보 중 하나라도 있으면 헤더 행이다.
// (cfgNames_ 로 헤더 이름이 복수 후보가 된 뒤 필요해졌다 — 단일 문자열 비교는 더 이상 안 통한다.)
function rowIsHeader_(rowNorm, expNames) {
  for (var e = 0; e < expNames.length; e++) if (rowNorm.indexOf(expNames[e]) >= 0) return true;
  return false;
}

function nextNonBlankIsHeader_(values, from, expNames) {
  for (var j = from; j < values.length; j++) {
    var r = values[j], blank = true;
    for (var q = 0; q < r.length; q++) {
      if (String(r[q] == null ? '' : r[q]).trim() !== '') { blank = false; break; }
    }
    if (blank) continue;
    return rowIsHeader_(r.map(norm_), expNames);
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

  // 헤더 행 찾기: expected 헤더 후보 중 하나가 들어있는 행 (상단 20행 내)
  var expNames = cfgNames_(cfg.expected).map(norm_);
  var headerRow = -1, colMap = {};
  for (var r = 0; r < Math.min(values.length, 20); r++) {
    var rowNorm = values[r].map(norm_);
    var found = false;
    for (var e = 0; e < expNames.length; e++) if (rowNorm.indexOf(expNames[e]) >= 0) { found = true; break; }
    if (found) { headerRow = r; colMap = mapCols_(rowNorm, cfg); break; }
  }
  if (headerRow < 0) return { records: [], note: '⚠ 헤더(예상회수액=' + cfgNames_(cfg.expected).join('/') + ') 못 찾음', anomalies: [] };
  if (colMap.expected === undefined) return { records: [], note: '⚠ 예상회수액 열 못 찾음', anomalies: [] };
  /* ⚠ 설정엔 있는데 헤더에서 못 찾은 열을 경고로 남긴다 — 이게 없어서 회수액이 조용히 0 이 됐다 */
  var missCols = [];
  ['collected', 'remaining', 'start', 'due', 'collect'].forEach(function (f) {
    if (cfg[f] && colMap[f] === undefined) missCols.push(f + '(' + cfgNames_(cfg[f]).join('/') + ')');
  });

  // ── 1차 스캔: 후보 행 수집 (송금일 빈 행도 일단 보류로 담음) ─────────────
  //   종전에는 '송금일 빈 행 = 합계/공백'으로 보고 전부 버렸으나, 병합셀 연속행
  //   (같은 매입 건의 추가 매출/분할 회수 행)까지 사라져 금액이 누락됐음(동이식품 1억).
  var anomalies = [];
  var cand = [];
  var tableCount = 1, block = 0, blockFirst = true, futureRows = 0;
  var TODAY = today_();
  for (var i = headerRow + 1; i < values.length; i++) {
    var row = values[i];

    /* ⚠⚠ 한 탭에 표가 여러 개 있고 열 구조가 서로 다를 수 있다 (2026-08-15 지앤원 사고).
       지앤원 탭은 표가 둘인데 **둘째 표에만 '차수' 열이 있어 이후 열이 한 칸씩 밀린다.**
       첫 헤더의 열 위치를 끝까지 그대로 쓰면 둘째 표에서 '입금예정액' 자리의 '지출일자'(날짜)를
       금액으로 읽고, num_ 가 날짜를 15~16자리 숫자로 바꿔 합계가 19,163조로 찍혔다
       (예상 871,999,773 → 19,163,380,872,011,470. 날짜 13개 합으로 오차 0 재현 확인).
       → 헤더 행을 다시 만나면 그 아래 행부터는 새 열 위치로 읽는다. */
    if (rowIsHeader_(row.map(norm_), expNames)) {
      colMap = mapCols_(row.map(norm_), cfg);
      tableCount++; block++; blockFirst = true;
      continue;                                  // 헤더 자체는 데이터가 아니다
    }

    // ── (옵트인) 키워드 제외: config의 excludeKeywords 중 하나라도 행에 있으면 제외 ──
    //   예: CNA의 '통관경비'(매출 아님) 행 제외. 다른 탭엔 영향 없음.
    if (cfg.excludeKeywords && rowHasKeyword_(row, cfg.excludeKeywords)) continue;
    if (isSummaryRow_(row)) continue;

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

    /* ── 안전가드 ③ — 한 행 금액이 상식 범위를 넘으면 파싱 오류다 ──
       전체 채권이 300억대인데 1조를 넘는 행이 나왔다면 열이 밀려 날짜·번호를 금액으로
       읽은 것이다. 조용히 합계에 섞이면 대시보드가 통째 오염되므로 기록해 두고
       ②동기화를 막는다(pushToDashboard). */
    if (Math.abs(expected) > MAX_SANE_AMOUNT || Math.abs(collected) > MAX_SANE_AMOUNT) {
      anomalies.push({ tab: sh.getName(), row: i + 1, expected: expected, collected: collected });
    }

    // 송금일 열이 없는 탭은 이 판정을 적용하지 않음(종전 동작 유지)
    var hasStartCol = colMap.start !== undefined;
    var hasStart = hasStartCol ? String(row[colMap.start] || '').trim() !== '' : true;

    /* ── (옵트인) 미래 지출 제외 — 아직 돈이 안 나갔으면 채권이 아니다 ──
       지앤원 표2의 지출일자 26-08-20~26-11-20 4행(118,800,000×4 = 475,200,000)이 이 경우다.
       시트 자체 합계도 이 4행을 빼고 907,748,592 로 잡혀 있고, 과거 9행 합과 원 단위까지 일치한다.
       ⚠ 날짜 모양(yyyy-MM-dd)으로 확정되는 것만 제외한다 — 텍스트 날짜는 판정이 안 되므로
         남기는 쪽(fail-open)으로 간다. 조용히 채권을 지우는 것이 더 위험하기 때문. */
    if (cfg.excludeFutureStart && hasStart && hasStartCol) {
      var sd = fmtDate_(row[colMap.start]);
      if (/^\d{4}-\d{2}-\d{2}$/.test(sd) && sd > TODAY) { futureRows++; continue; }
    }
    /* cm: 이 행을 읽을 때 쓴 열 매핑을 그대로 들고 간다 — 표마다 열 위치가 다르므로
       2차 판정에서 colMap 을 다시 참조하면 마지막 표의 매핑으로 전부 읽어 버린다. */
    /* 날짜 3종(송금일·회수예정일·실제회수일)과 '바로 뒤가 헤더인가' 를 1차에서 확정해 둔다 —
       2차 판정과 아래 소계 감지가 같은 값을 봐야 하고, 표마다 열 위치가 달라 나중에 다시
       읽으면 마지막 표의 매핑으로 읽히기 때문. */
    var dueV  = colMap.due     !== undefined ? String(row[colMap.due]     || '').trim() : '';
    var colV  = colMap.collect !== undefined ? String(row[colMap.collect] || '').trim() : '';
    var dateless = !hasStart && !dueV && !colV;
    cand.push({ row: row, cm: colMap, block: block, srcRow: i, expected: expected, collected: collected,
                hasStart: hasStart, first: blockFirst, dueV: dueV, colV: colV, dateless: dateless,
                nextHdr: dateless ? nextNonBlankIsHeader_(values, i + 1, expNames) : false });
    blockFirst = false;
  }

  // ── 2차: 합계 행만 걸러내고 나머지는 살림 ──────────────────────────────
  //   송금일 빈 행은 아래 중 하나면 제외:
  //     ⑴ 헤더 바로 아래 첫 행(대부분 탭의 총계 위치)
  //     ⑵ 예상액이 '나머지 전 행의 합'과 일치(총계 행 고유 특징 — 하단 총계도 감지)
  //     ⑶ 회수예정일·실제회수일·회수액이 모두 없음 = 근거 없는 참고/잔여 행
  //        (지앤원 하단 2행처럼 시트 자체 합계에서도 빠져 있는 행)
  //        ⚠ config 에 keepNoEvidenceRows: true 인 탭은 ⑶을 적용하지 않는다.
  //          CNA 59행처럼 날짜가 하나도 없어도 시트 누적액에 잡히는 '실제 채권'이 있어서
  //          (2026-08-07 사용자 확인, 30,757,119원). ⑴⑵(총계 행 판정)는 그대로 살아 있다.
  //   나머지 = 병합셀 연속행(같은 매입 건의 추가 매출/분할 회수) → 직전 행의 송금일 승계해 유지
  //   ⚠ 총계 일치 판정 ⑵ 는 **같은 표(block) 안의 합**과 비교한다 — 표가 둘인 탭에서
  //     전체 합과 비교하면 어느 표의 총계 행도 걸리지 않는다.
  var blockExp = {}, skippedTotalRows = 0;
  for (var t = 0; t < cand.length; t++) blockExp[cand[t].block] = (blockExp[cand[t].block] || 0) + cand[t].expected;

  /* ── 판정 ⑸ 소계 행 감지 (2026-08-21) ──────────────────────────────────
     날짜가 하나도 없는 행들 중 '나머지의 합' 과 일치하는 가장 큰 행은 소계다.
     지앤원 표1 하단이 그 모양: 446행 155,896,319 = 449행 81,659,977 + 450행 74,236,343.
     합이 실제로 맞을 때만 발동하므로 진짜 채권을 잘못 지울 위험이 없다. 3행 이상일 때만
     보는 이유는, 2행뿐이면 값이 같은 두 행이 서로를 소계로 지목해 둘 다 사라지기 때문. */
  var dl = {};
  for (var d = 0; d < cand.length; d++) {
    var cd = cand[d];
    if (!cd.dateless || cd.nextHdr) continue;      // 총계 행(⑷)은 대상에서 뺀다
    (dl[cd.block] = dl[cd.block] || []).push(cd);
  }
  var subtotalDropped = 0;
  Object.keys(dl).forEach(function (bk) {
    var g = dl[bk];
    if (g.length < 3) return;
    var tot = 0, mx = g[0];
    for (var q = 0; q < g.length; q++) { tot += g[q].expected; if (g[q].expected > mx.expected) mx = g[q]; }
    if (Math.abs(mx.expected - (tot - mx.expected)) <= 2) { mx.isSubtotal = true; subtotalDropped++; }
  });

  var records = [], lastStart = '', lastBlock = -1, totalRowsDropped = 0;
  for (var k = 0; k < cand.length; k++) {
    var c = cand[k], cm = c.cm;
    // 송금일 승계(병합셀 연속행)는 같은 표 안에서만 유효 — 표가 바뀌면 초기화한다
    if (c.block !== lastBlock) { lastStart = ''; lastBlock = c.block; }
    var hasStartCol = cm.start !== undefined;
    if (!c.hasStart) {
      var dueVal = c.dueV, collectVal = c.colV;
      var noEvidence = !cfg.keepNoEvidenceRows && !dueVal && !collectVal && !(c.collected > 0); // 회수 근거 전무
      /* ⑷ 날짜가 하나도 없고 바로 뒤에 헤더가 오는 행 = 다음 표의 총계 행 (2026-08-21 추가).
         회수액이 있어도 걸러야 한다 — 지앤원 표2 총계가 이 모양이라 예상 907,748,592 ·
         회수 336,632,378 이 통째로 이중계상됐다. 날짜 3종이 전부 없는 것이 총계 행의 특징이고,
         병합셀 연속행은 보통 회수예정일이나 실제회수일이 있어 여기 걸리지 않는다. */
      var isNextTotal = c.dateless && c.nextHdr;
      var isDropRow  = c.first || Math.abs(2 * c.expected - (blockExp[c.block] || 0)) <= 2
                       || noEvidence || isNextTotal || c.isSubtotal;
      if (isDropRow) { skippedTotalRows++; if (isNextTotal) totalRowsDropped++; continue; }
    }
    var startStr = c.hasStart && hasStartCol ? fmtDate_(c.row[cm.start]) : (hasStartCol ? lastStart : '');
    if (c.hasStart && hasStartCol) lastStart = startStr;

    var rec = {
      _id: '',
      partner: sh.getName(),
      start: startStr,
      expected: c.expected,
      collected: c.collected,
      due_date: cm.due !== undefined ? fmtDate_(c.row[cm.due]) : '',
      collect_date: cm.collect !== undefined ? fmtDate_(c.row[cm.collect]) : '',
      note: '',
    };
    // 회수액 없는 행(미회수)에 실제 입금일이 잘못 찍혀 있으면 공란 (입금 없으면 입금일도 없음).
    // FIFO 2단 정렬 전에 정리해야 stray 회수일이 '회수일 있는 행'으로 잘못 우선순위 먹지 않음 (예: 팬텀).
    if (!(rec.collected > 0)) rec.collect_date = '';
    // 미회수 열이 있는 탭만 remaining 전달(없으면 Edge가 예상-회수로 계산)
    if (cm.remaining !== undefined) rec.remaining = num_(c.row[cm.remaining]);
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
    anomalies: anomalies,
    note: (missCols.length ? '⚠ 열 못 찾음: ' + missCols.join(', ') + ' — 그 값은 0 으로 들어갑니다! ' : '') +
          'OK (헤더 ' + (headerRow + 1) + '행' + (tableCount > 1 ? ' · 표 ' + tableCount + '개(열 재매핑)' : '') +
          ', 매핑: ' + foundCols.join(',') + ')' +
          (totalRowsDropped ? ' 🧮총계 행 ' + totalRowsDropped + '개 제외' : '') +
          (subtotalDropped ? ' ➗소계 행 ' + subtotalDropped + '개 제외' : '') +
          (futureRows ? ' ⏭미래 지출 ' + futureRows + '행 제외(아직 채권 아님)' : '') +
          (fifo.changed ? ' ⚙과입금 FIFO 재배분(' + fifo.moved + '행 조정)' : '') +
          (anomalies.length ? ' ⛔비정상 금액 ' + anomalies.length + '행' : '')
  };
}

// 전체 탭 파싱 → { records:[], report:[], skipped:[] }
function parseAll_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var records = [], report = [], skipped = [], fifoTabs = [], anomalies = [];
  var configured = {};

  sheets.forEach(function (sh) {
    var name = sh.getName();
    if (EXCLUDE_TABS.indexOf(name) >= 0) return;
    var found = findCfg_(name);
    if (!found) { skipped.push(name); report.push('· ' + name + ' : (설정 없음 — 건너뜀)'); return; }
    var cfg = found.cfg;
    configured[found.key] = true;
    var res = parseTab_(sh, cfg);
    if (res.fifo && res.fifo.changed) fifoTabs.push(name + '(' + res.fifo.moved + '행)');
    if (res.anomalies && res.anomalies.length) anomalies = anomalies.concat(res.anomalies);
    var sumE = res.records.reduce(function (s, r) { return s + r.expected; }, 0);
    var sumC = res.records.reduce(function (s, r) { return s + r.collected; }, 0);
    var sumR = res.records.reduce(function (s, r) { return s + recRemaining_(r); }, 0);
    report.push('· ' + name + ' : ' + res.records.length + '건, 예상 ' + Math.round(sumE).toLocaleString() +
                ' / 회수 ' + Math.round(sumC).toLocaleString() +
                ' / 미회수 ' + Math.round(sumR).toLocaleString() + ' — ' + res.note +
                (found.exact ? '' : ' 🔤탭 이름 불일치(공백 무시해 매칭): 시트 "' + name + '" ↔ 설정 "' + found.key + '"'));
    records = records.concat(res.records);
  });

  // 설정엔 있는데 탭이 없는 경우 경고
  Object.keys(TAB_CONFIG).forEach(function (k) {
    if (!configured[k]) report.push('⚠ 설정에 있으나 탭 못 찾음: ' + k + ' (탭 이름 확인 필요)');
  });

  return { records: records, report: report, skipped: skipped, fifoTabs: fifoTabs, anomalies: anomalies };
}

/* 비정상 금액(안전가드 ③) 안내문 — 미리보기·동기화 중단 메시지에서 같이 쓴다 */
function anomalyText_(anoms) {
  var won = function (n) { return Math.round(n).toLocaleString(); };
  var lines = anoms.slice(0, 5).map(function (a) {
    return '   · ' + a.tab + ' ' + a.row + '행 : 예상 ' + won(a.expected) + ' / 회수 ' + won(a.collected);
  });
  if (anoms.length > 5) lines.push('   · … 외 ' + (anoms.length - 5) + '행');
  return lines.join('\n');
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
              recRemaining_(r),
              r.due_date, r.collect_date];
    });
    sh.getRange(2, 1, rows.length, HEAD.length).setValues(rows);
  }
  var totalE = out.records.reduce(function (s, r) { return s + r.expected; }, 0);
  var totalC = out.records.reduce(function (s, r) { return s + r.collected; }, 0);
  var totalR = out.records.reduce(function (s, r) { return s + recRemaining_(r); }, 0);
  var warn = out.skipped && out.skipped.length
    ? '⚠ 설정이 없어 대시보드에서 빠지는 탭: ' + out.skipped.join(', ') +
      '\n   → TAB_CONFIG에 추가해야 반영됩니다.\n\n'
    : '';
  var fifoMsg = out.fifoTabs && out.fifoTabs.length
    ? '⚙ 과입금 감지 → FIFO 재배분된 탭: ' + out.fifoTabs.join(', ') +
      '\n   회수액을 오래된 채권부터 예상액 상한으로 재분배(총액 불변). AR_preview에서 행별 확인하세요.\n\n'
    : '';
  var anomMsg = out.anomalies && out.anomalies.length
    ? '⛔ 비정상 금액 ' + out.anomalies.length + '행 — 열 매핑 오류입니다 (②동기화가 차단됩니다)\n' +
      anomalyText_(out.anomalies) +
      '\n   → 해당 탭에 열 구조가 다른 표가 섞여 있거나 헤더 이름이 바뀐 것입니다.\n\n'
    : '';
  ui.alert(
    anomMsg + warn + fifoMsg +
    '미리보기 (대시보드 변경 없음)\n\n' +
    '총 ' + out.records.length + '건\n예상회수 합계: ' + Math.round(totalE).toLocaleString() + '\n회수 합계: ' + Math.round(totalC).toLocaleString() +
    '\n미회수 합계: ' + Math.round(totalR).toLocaleString() +
    '\n\n[탭별]\n' + out.report.join('\n') +
    '\n\n※ 결과는 AR_preview 시트에서 행단위로 확인하세요. 이상 없으면 ②동기화 실행.'
  );
}

// ② 대시보드로 동기화 (실제 교체)
function pushToDashboard() {
  var ui = SpreadsheetApp.getUi();
  var out = parseAll_();
  if (!out.records.length) { ui.alert('파싱된 데이터가 없습니다. 먼저 ①미리보기로 확인하세요.'); return; }

  /* ── 안전가드 ③: 비정상 금액이 있으면 중단 (열 매핑 오류) ──
     2026-08-15 지앤원 사고 — 열이 한 칸 밀려 날짜가 금액으로 읽혀 예상회수 합계가
     19,163조로 찍혔다. 그대로 ②동기화를 눌렀다면 ar_data 가 통째 오염됐다.
     건수는 정상이라 기존 '건수 급감' 가드(②)로는 절대 안 걸리는 유형이다. */
  if (out.anomalies && out.anomalies.length) {
    ui.alert('⛔ 동기화 중단 (데이터 보호)\n\n' +
      '상식 범위(1조)를 넘는 금액이 ' + out.anomalies.length + '행 파싱됐습니다 — 열 매핑 오류입니다.\n' +
      anomalyText_(out.anomalies) + '\n\n' +
      '이대로 진행하면 대시보드 매출채권이 통째로 오염됩니다.\n' +
      '· 해당 탭에 열 구조가 다른 표가 섞여 있는지 확인 (표마다 헤더 행이 있어야 자동 인식됩니다)\n' +
      '· 헤더 이름이 바뀌었는지 확인 → TAB_CONFIG 수정\n' +
      '①미리보기로 탭별 합계를 먼저 확인하세요.');
    return;
  }

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

/**
 * ar-sheet-sync.gs — 전체현황 전용 거래처(OVERVIEW_ROWS) 회귀 테스트
 *
 * 왜 노드 스텁인가: 이 파일의 단골 사고는 문법 오류가 아니라 **런타임 오류**다
 * (공유 헬퍼 이름이 바뀌었는데 참조가 남아 미리보기가 통째로 실패한 적이 있다 — 65f2316).
 * `node --check` 로는 절대 안 잡히므로, Apps Script API 를 목업해 실제로 한 번 돌린다.
 *
 * 픽스처는 '인오가닉사업 전체현황' 탭 모양만 최소로 재현한 것이다. 실제 시트 스냅샷을
 * 박아 두면 시트가 편집될 때마다 낡아서 못 쓴다 — 여기서 검증하는 건 '숫자가 맞는지'가
 * 아니라 '전체현황 전용 행을 놓치지 않는지'다.
 *
 *   실행: node scripts/test-ar-overview-rows.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GS = path.join(HERE, '..', 'apps-script', 'ar-sheet-sync.gs');

/* 전체현황 탭 픽스처 — 위쪽 병합 제목/날짜 행, 헤더, 합계, 거래처들, 빈 줄, 메모 블록.
   실제 시트의 구조적 함정을 그대로 담았다:
     · 헤더가 1행이 아니다(병합 제목 아래)         → 헤더 행 탐색이 필요
     · 헤더 셀이 '구   분' 처럼 띄어져 있다          → norm_ 로 공백 무시
     · 표 아래 빈 줄 다음에 메모 블록이 이어진다     → 첫 빈 구분에서 멈춰야 함
     · 전체현황 표기가 탭 이름과 다르다(CNA(중계무역)) → OVERVIEW_ROWS 대응표가 필요 */
const OVERVIEW_FIXTURE = [
  ['', '인오가닉 사업 및 채권현황', '', '', '', ''],
  ['', '', '', '', '', '(2026-09-16)'],
  ['', '구   분', '예상회수액', '현재 회수액', '미회수액', '예상최종 회수일'],
  ['', '합  계', 3000, 1000, 2100, ''],
  ['', 'CNA(중계무역)', 3000, 1000, 2000, ''],
  ['', '숯 (보증금)', '', '', 100, ''],
  ['', '라오스 (원물수입)', '', '', '', ''],
  ['', '', '', '', '', ''],
  ['', 'Review & History', '', '', '', ''],
  ['', '회수모델_CNA', '물건 대금 미지급으로 홀딩', '', '', ''],
];

function loadGs(sheets) {
  const sandbox = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheets: () => sheets,
        getSheetByName: (n) => sheets.find((s) => s.getName() === n) || null,
      }),
      getUi: () => { throw new Error('테스트에서 UI 는 쓰지 않는다'); },
    },
    Utilities: { formatDate: () => '' },
    Session: { getScriptTimeZone: () => 'Asia/Seoul' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) },
    UrlFetchApp: { fetch: () => { throw new Error('테스트에서 네트워크 호출 금지'); } },
  };
  Object.assign(globalThis, sandbox);
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(GS, 'utf8'));
}

const sheet = (name, values) => ({
  getName: () => name,
  getDataRange: () => ({ getValues: () => values }),
});

let fail = 0;
const check = (label, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: ${got}${ok ? '' : `   (기대 ${want})`}`);
};

// ── 1. 전용 탭 없는 거래처가 레코드로 나오는가 ──────────────────────────────
console.log('■ 전체현황 전용 거래처 파싱');
loadGs([sheet('인오가닉사업 전체현황', OVERVIEW_FIXTURE)]);
let out = parseOverview_();
out.report.forEach((r) => console.log('   ' + r));
check('레코드 수', out.records.length, 1);
check('거래처', out.records[0].partner, '숯 (보증금)');
/* ⚠ 핵심 — 미회수를 명시적으로 넘겨야 한다. 전체현황 행은 집계라 (예상-회수) 와 다르고,
   '숯 (보증금)' 은 예상·회수가 비어 있어 자동계산에 맡기면 1억이 0 이 된다. */
check('미회수 명시 전달', out.records[0].remaining, 100);
check('recRemaining_', recRemaining_(out.records[0]), 100);
check('탭 있는 CNA 는 중복 생성 안 함', out.records.filter((r) => /CNA/.test(r.partner)).length, 0);
check('빈 줄 아래 메모 블록을 거래처로 오해 안 함', out.warn.length, 0);

// ── 2. 새 거래처가 금액을 달고 나타나면 경고하는가 ──────────────────────────
console.log('\n■ 미설정 거래처 경고');
const withNew = OVERVIEW_FIXTURE.map((r) => r.slice());
withNew.splice(7, 0, ['', '신규거래처', '', '', 500, '']);
loadGs([sheet('인오가닉사업 전체현황', withNew)]);
out = parseOverview_();
out.warn.forEach((w) => console.log('   ⚠ ' + w));
check('경고 1건', out.warn.length, 1);
check('경고에 거래처명 포함', /신규거래처/.test(out.warn.join('|')), true);

// ── 3. 금액 없는 자리 행은 조용한가 (오탐 방지) ─────────────────────────────
console.log('\n■ 자리 행(placeholder) 오탐 방지 / 금액 생기면 경고');
const withMoney = OVERVIEW_FIXTURE.map((r) => r.slice());
withMoney[6] = ['', '라오스 (원물수입)', '', '', 700, ''];
loadGs([sheet('인오가닉사업 전체현황', withMoney)]);
out = parseOverview_();
out.warn.forEach((w) => console.log('   ⚠ ' + w));
check('금액 생기면 경고 1건', out.warn.length, 1);
check('경고에 라오스 포함', /라오스/.test(out.warn.join('|')), true);

// ── 4. fromOverview 행이 사라지면 조용히 넘어가지 않는가 ────────────────────
console.log('\n■ 설정된 전체현황 행 소실 감지');
loadGs([sheet('인오가닉사업 전체현황', OVERVIEW_FIXTURE.filter((r) => r[1] !== '숯 (보증금)'))]);
out = parseOverview_();
out.warn.forEach((w) => console.log('   ⚠ ' + w));
check('소실 경고', out.warn.length, 1);
check('레코드 0건', out.records.length, 0);

// ── 5. parseAll_ 배선 (런타임 오류 탐지) ────────────────────────────────────
console.log('\n■ parseAll_ 배선');
loadGs([sheet('인오가닉사업 전체현황', OVERVIEW_FIXTURE), sheet('AR_preview', [['']])]);
const all = parseAll_();
check('전체현황 레코드가 parseAll_ 에 합쳐짐', all.records.length, 1);
check('overviewWarn 전달됨', Array.isArray(all.overviewWarn), true);
check('전체현황 탭이 설정없는 탭으로 안 잡힘', all.skipped.length, 0);

console.log(fail ? `\n❌ 실패 ${fail}건` : '\n✅ 전부 통과');
process.exit(fail ? 1 : 0);

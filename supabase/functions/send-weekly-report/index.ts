/**
 * send-weekly-report — Supabase Edge Function
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  배포 전 Supabase Secrets 등록 필수                                    │
 * │                                                                     │
 * │  자동 제공 (등록 불필요):                                               │
 * │    SUPABASE_URL                — 프로젝트 URL                         │
 * │    SUPABASE_SERVICE_ROLE_KEY   — service_role JWT                   │
 * │                                                                     │
 * │  수동 등록 필요:                                                        │
 * │    GMAIL_USER                  — 발신 Gmail 계정 (예: helen@rawga.com) │
 * │    GMAIL_APP_PASSWORD          — Google 앱 비밀번호 (16자리)            │
 * │    CRON_SECRET                 — auto 실발송 인증용 (cron 측과 공유)    │
 * │    APP_PUBLISHABLE_KEY         — sb_publishable_* 키 (앱 HTML과 동일) │
 * │                                                                     │
 * │  선택 등록:                                                             │
 * │    DASHBOARD_URL               — 이메일 내 "대시보드에서 확인" 링크 URL   │
 * │                                  미등록 시 텍스트 안내만 표시              │
 * │                                  예: https://your-dashboard-url.com  │
 * └─────────────────────────────────────────────────────────────────────┘
 */
import { serve }        from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import nodemailer       from 'npm:nodemailer';

/* ── 환경변수 읽기 (핸들러 내에서 null 체크 별도 수행) ─────────────────── */
const SUPABASE_URL_RAW              = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY_RAW = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const GMAIL_USER_RAW                = Deno.env.get('GMAIL_USER');
const GMAIL_APP_PASSWORD_RAW        = Deno.env.get('GMAIL_APP_PASSWORD');
const CRON_SECRET                   = Deno.env.get('CRON_SECRET')               || '';
const PUBLISHABLE_KEY               = Deno.env.get('APP_PUBLISHABLE_KEY')        || '';
const DASHBOARD_URL                 = Deno.env.get('DASHBOARD_URL')              || '';

const FUNCTION_VERSION = 'weekly-summary-debug-20260606-01';

/* ── CORS / 응답 헬퍼 ─────────────────────────────────────────────────── */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-cron-secret',
};
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

/* ── 날짜 헬퍼 ────────────────────────────────────────────────────────── */
// Date → 'YYYY-MM-DD' (서버 로컬 기준 — toISOString UTC 변환 우회)
function toDateStr(d: Date): string {
  const y   = d.getFullYear();
  const m   = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

// index.html getWeekRange()와 동일한 로직 (월요일 시작, 로컬 기준)
function getWeekRange(dateStr: string) {
  const d   = new Date(dateStr + 'T00:00:00');
  const mon = d.getDate() - ((d.getDay() + 6) % 7);
  d.setDate(mon);
  const base = toDateStr(d);           // 이번 주 월요일
  return {
    wStart  : base,
    wEnd    : addDays(base,  6),       // 이번 주 일
    pwStart : addDays(base, -7),       // 전주 월
    pwEnd   : addDays(base, -1),       // 전주 일
    nwStart : addDays(base,  7),       // 차주 월
    nwEnd   : addDays(base, 13),       // 차주 일
  };
}

// index.html getWeekNumByThursday()와 동일한 로직
// 해당 월의 첫 번째 목요일을 1주차로 삼아 주어진 날짜(목요일)가 몇 번째 주인지 반환
// 예: 2026-05-01 → thu=05-07 → 5월 1주차 / 2026-04-30 → thu=04-30 → 4월 5주차
function getWeekNumByThursday(thuDateStr: string): number {
  const thu            = new Date(thuDateStr + 'T00:00:00');
  const year           = thu.getFullYear();
  const month          = thu.getMonth();
  const firstDay       = new Date(year, month, 1);
  const daysToFirstThu = (4 - firstDay.getDay() + 7) % 7; // 0이면 1일 자체가 목요일
  const firstThu       = new Date(year, month, 1 + daysToFirstThu);
  return Math.round((thu.getTime() - firstThu.getTime()) / (7 * 86400000)) + 1;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDateStr(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00');
  return !isNaN(d.getTime());
}

// UTC 대신 Asia/Seoul 기준 오늘 날짜 반환
// 'sv-SE' 로케일은 YYYY-MM-DD 형식을 보장함
function todaySeoul(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

/* ── CF 행 정규화 (Edge Function 전용) ───────────────────────────────── */
// index.html normalizeCFRow()와 동일한 역할.
// 브라우저 전용인 excelDateToStr() 없이 순수 문자열 처리로 구현.
function normalizeCFRowServer(row: Record<string, unknown>): Record<string, unknown> {
  // date: 앞뒤 공백 제거 → '/' '.' → '-' 치환 → 앞 10자만 사용
  const rawDate = String(row.date ?? '').replace(/[./]/g, '-').trim();
  const date    = rawDate.slice(0, 10);

  // in / out: 쉼표 제거 후 숫자 변환
  const inAmt  = Number(String(row.in  ?? '').replace(/,/g, '')) || 0;
  const outAmt = Number(String(row.out ?? '').replace(/,/g, '')) || 0;

  // type
  const type = inAmt > 0 ? '입금' : '지출';

  // status: 다중 공백 → 단일 공백 → trim → 비표준값 매핑
  const STATUS_MAP: Record<string, string> = {
    '실제 출금': '실제 지출', '출금 예정': '지출 예정',
    '실제입금':  '실제 입금', '실제지출':  '실제 지출',
    '입금예정':  '입금 예정', '지출예정':  '지출 예정',
  };
  const VALID_STATUSES = ['실제 입금', '실제 지출', '입금 예정', '지출 예정'];

  let status = String(row.status ?? '').replace(/\s+/g, ' ').trim();
  if (STATUS_MAP[status]) status = STATUS_MAP[status];

  // 여전히 유효하지 않으면 날짜 / type 기준 자동 생성
  if (!VALID_STATUSES.includes(status)) {
    const today = todaySeoul();
    status = type === '입금'
      ? (date <= today ? '실제 입금' : '입금 예정')
      : (date <= today ? '실제 지출' : '지출 예정');
  }

  return { ...row, date, in: inAmt, out: outAmt, type, status };
}

/* ── 주간 요약 파싱 / HTML 유틸 ──────────────────────────────────────── */

/** cat_data.data 컬럼의 다양한 저장 형태를 안전하게 파싱.
 *  저장 구조: { summary, updated_at } | { text, updatedAt } | 문자열 | JSON 문자열 */
function parseWeeklySummary(value: unknown): { summary: string; updated_at: string | null } {
  // 문자열인 경우: JSON 파싱 시도 → 실패하면 그대로 summary 처리
  let parsed: unknown = value;
  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { parsed = JSON.parse(trimmed); } catch { return { summary: trimmed, updated_at: null }; }
    } else {
      return { summary: trimmed, updated_at: null };
    }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const d = parsed as Record<string, unknown>;
    const summary = String(d.summary ?? d.text ?? d.content ?? '').trim();
    const updated_at =
      typeof d.updated_at === 'string' ? d.updated_at :
      typeof d.updatedAt  === 'string' ? d.updatedAt  : null;
    return { summary, updated_at };
  }
  return { summary: '', updated_at: null };
}

/** HTML 특수문자 escape (사용자 입력을 이메일 HTML에 삽입할 때 XSS 방지) */
function escapeHtml(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** ISO 문자열 → 'YYYY-MM-DD HH:mm' (Asia/Seoul 기준)
 *  유효하지 않거나 null이면 '-' 반환 */
function formatUpdatedAtSeoul(iso: string | null): string {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    const opts: Intl.DateTimeFormatOptions = {
      timeZone: 'Asia/Seoul',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    };
    return d.toLocaleString('ko-KR', opts)
      .replace(/\./g, '-').replace(/-\s*/g, '-').replace(/\s+/g, ' ').trim();
  } catch { return '-'; }
}

/* ── 숫자 포맷 ────────────────────────────────────────────────────────── */
// Math.round() 적용 → 소수점 이하 반올림 후 한국 원 단위 포맷
function fmt(n: number): string {
  return Math.round(Number(n) || 0).toLocaleString('ko-KR');
}

/* ═══ 일별 현금 잔액 추이·궤적 (메일용) ═══════════════════════════════════
 * ⚠⚠ 이 두 함수는 index.html 의 computeWeeklyCashSeries / buildWeeklyTrajBlockHTML 과
 *   **같은 내용의 사본**이다. 메일 HTML 이 미리보기(index.html)와 실제 발송(여기) 두 벌로
 *   관리되는 구조라서다. 한쪽만 고치면 미리보기와 실제 메일이 다른 숫자를 말한다.
 * ⚠ 메일에서는 canvas 를 못 그리므로 같은 숫자를 표와 막대(중첩 table 폭)로 표현한다.
 *   이미지·SVG 는 Gmail 등이 막거나 지운다.
 * ⚠ 확정/궤적의 경계는 **오늘**이지 선택 주차의 끝이 아니다. 연체 예정(기한 지난 예정)은
 *   오늘 시점에 한꺼번에 얹는다 — 돈이 아직 안 나갔으므로 과거로 그리면 확정을 왜곡한다. */
const WKRPT_HORIZON_DAYS = 56;   // 8주 — 화면(대시보드·리포팅)과 같은 지평

function computeWeeklyCashSeries(
  wStart: string, rows: Record<string, unknown>[], initCash: number, today: string, horizonDays: number,
) {
  const from = wStart;
  const to   = addDays(wStart, horizonDays - 1);
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);

  const actDelta: Record<string, number> = {}, planAll: Record<string, number> = {};
  let overdueSum = 0;
  let beforeFrom = initCash;      // from 직전까지의 확정 잔액 (initCash 에 환산손익 포함)
  let cashToday  = initCash;      // 오늘까지의 확정 잔액

  for (const r of (rows || [])) {
    const d = String(r.date || '');
    if (!d) continue;
    const st = String(r.status || '');
    if (st === '실제 입금' || st === '실제 지출') {
      const v = st === '실제 입금' ? (Number(r.in) || 0) : -(Number(r.out) || 0);
      if (d <  from)  beforeFrom += v;
      if (d <= today) cashToday  += v;
      if (d >= from && d <= to) actDelta[d] = (actDelta[d] || 0) + v;
    } else if (st === '입금 예정' || st === '지출 예정') {
      const v = st === '입금 예정' ? (Number(r.in) || 0) : -(Number(r.out) || 0);
      if (d <= today) { overdueSum += v; continue; }   // 연체 → 오늘로
      planAll[d] = (planAll[d] || 0) + v;              // to 로 자르지 않는다(미래 주차에 필요)
    }
  }

  const actVals: (number | null)[] = [];
  let run = beforeFrom, lastActual: number | null = null, lastActualIdx = -1;
  dates.forEach((d, i) => {
    if (d <= today) { run += (actDelta[d] || 0); actVals.push(run); lastActual = run; lastActualIdx = i; }
    else actVals.push(null);
  });

  let prun = (lastActual === null ? cashToday : lastActual) + overdueSum;
  if (from > today) {
    for (const d of Object.keys(planAll).sort()) if (d < from) prun += planAll[d];
  }
  const hasProjection = to > today;
  const projVals: (number | null)[] = [];
  dates.forEach((d, i) => {
    if (d <= today) { projVals.push((hasProjection && i === lastActualIdx) ? actVals[i] : null); return; }
    prun += (planAll[d] || 0);
    projVals.push(prun);
  });

  return { dates, actVals, projVals };
}

function buildWeeklyTrajBlockHTML(
  wStart: string, cfArr: Record<string, unknown>[], initCash: number, floor: number,
  C: Record<string, string>, horizonDays: number, today: string,
): string {
  const { dates, actVals, projVals } = computeWeeklyCashSeries(wStart, cfArr, initCash, today, horizonDays);
  const line = dates.map((_d, i) => (actVals[i] !== null ? actVals[i] : projVals[i]));
  const known = line.filter((v): v is number => v !== null);
  if (!known.length) return '';

  const hi  = Math.max(...known, floor > 0 ? floor : 0);   // 안전선이 최고치보다 높을 수 있다
  const eok = (v: number) => (Number(v || 0) / 1e8).toFixed(2);
  const md  = (d: string) => d.slice(5).replace('-', '/');
  /* ⚠ 구간이 전부 미래거나 전부 과거일 수 있다 — 그때 '오늘까지는 확정' 은 거짓이다 */
  const basisNote = dates[0] > today
    ? '전 구간 예정 반영 (선택 주차가 미래)'
    : (dates[dates.length - 1] <= today ? '전 구간 확정' : `오늘(${today})까지는 확정, 이후는 예정 반영`);

  const H = 150;
  const px = (v: number) => Math.max(0, Math.round((Math.max(0, v) / (hi || 1)) * H));
  const floorPx = floor > 0 ? px(floor) : 0;

  /* ── 일별 계단 선 차트 ──────────────────────────────────────────────
     메일에서는 canvas 를 못 쓰고 inline SVG 는 Gmail 이 지운다. PNG 는 Edge(Deno)에
     canvas·FFI 가 없어 만들 수 없고, 외부 렌더 서비스는 회사 잔액이 URL 로 나가므로
     쓸 수 없다. → 표 셀 + div 로 직접 그린다.
     처음엔 열(막대) 차트였는데 가독성이 떨어져 선 차트로 바꿨다(2026-08-21). 잔액은 거래가
     있는 날만 바뀌는 **계단 함수**라, 대각선을 못 그리는 표 기반 방식과 오히려 잘 맞는다.
     평평한 구간은 가로선, 바뀌는 날은 수직 연결선 + 점으로 그린다.
     ⚠ 색칠은 반드시 div 로 한다 — 중첩 table 은 width 가 없으면 폭이 0 으로 접혀
       차트가 통째로 사라진다(2026-08-21 실측).
     ⚠ 안전선은 별도 레이어를 못 만드니 열마다 1px 눈금을 찍어 점선처럼 보이게 한다. */
  type Mark = { top: number; h: number; bg: string; w?: number; round?: boolean; ring?: boolean; txt?: string };
  const LW = 2;                                     // 선 두께
  const DOT = 5;                                    // 변화점 점 크기
  const RING = 4;                                   // 속 빈 마커 내경(테두리 2px 포함 8px)
  const LBL = 12;                                   // 값 라벨 줄높이
  const yTop = (v: number) => H - px(v);                      // 위에서부터의 거리
  const COL_ACT  = C.blue;      // 확정 · 정상 (RAWGA DEEP GREEN)
  const COL_PRJ  = '#8AA093';   // 궤적 · 정상
  const COL_ACTB = C.red;       // 확정 · 미달
  const COL_PRJB = '#E0A99E';   // 궤적 · 미달
  const COL_FLOOR= '#E8BDB4';   // 안전선 눈금

  const colW = (100 / dates.length).toFixed(3);
  /* ⚠ 이 문자열이 열마다 여러 번 반복돼 메일 크기를 좌우한다. div 는 내용이 없으니
     font-size/line-height 만으로 충분하고, Outlook 용 mso 규칙은 td 에만 준다
     (그것까지 div 마다 붙였다가 31KB → 필요 없는 7KB 를 실었다). */
  const Z  = 'font-size:0;line-height:0';
  const ZT = Z + ';mso-line-height-rule:exactly';
  const sp  = (h: number) => `<div style="height:${h}px;${Z}"></div>`;
  /* w 를 주면 가운데 정렬된 좁은 조각이 된다(수직 연결선·점). 안 주면 셀 폭 전체를 채워
     가로선이 옆 칸과 이어진다.
     ⚠ 수직 연결선을 셀 폭 전체로 그렸다가 **막대처럼 보여 선이 두껍다는 지적을 받았다**
       (2026-08-21). 연결선은 선 두께만큼만 좁게 그려야 선으로 읽힌다. */
  const bar = (h: number, bg: string, w?: number, round?: boolean) => `<div style="height:${h}px;background:${bg};${Z}${w ? `;width:${w}px;margin:0 auto` : ''}${round ? `;border-radius:${DOT}px` : ''}"></div>`;
  /* 속 빈 원 마커 — 첨부 예시(주가 차트)의 마커 모양. Outlook 은 border-radius 를 무시해
     작은 사각형으로 보이지만 위치·크기는 같아 정보 손실이 없다. */
  const ring = (col: string) => `<div style="width:${RING}px;height:${RING}px;border:2px solid ${col};background:${C.card};border-radius:${RING + 4}px;margin:0 auto;${Z}"></div>`;
  /* 값 라벨 — width:0 이라 열 폭을 늘리지 않고 오른쪽으로 흘러 넘친다(옆 칸은 비어 있다).
     텍스트라 모든 클라이언트에서 보인다 — 이게 가독성 개선의 핵심이다. */
  const label = (txt: string, col: string) => `<div style="height:${LBL}px;width:0;overflow:visible;white-space:nowrap;font-size:9.5px;line-height:${LBL}px;color:${col};font-weight:700;mso-line-height-rule:exactly">${txt}</div>`;
  /* 마크를 y 순서로 쌓는다 — 겹치면 붙어 나오지만 1~3px 라 눈에 안 띈다.
     td 가 고정 높이 + valign="top" 이라 **아래쪽 여백 div 는 넣지 않는다**(크기 절약). */
  /* 마크 하나를 배치할 자리를 정한다.
     ⚠⚠ 겹치면 앞 요소가 뒤 요소를 아래로 밀어낸다(일반 문서 흐름). 그래서 겹치는 만큼
       **잘라내** 모든 요소가 제 높이에 오게 한다 — 잘리는 쪽은 1~2px 선이라 안 보인다.
     ⚠⚠ 단 라벨·링은 높이가 CSS 로 고정돼 있어 **자를 수 없다**(자른 h 를 줘도 렌더 높이는
       그대로다). 그걸 모르고 자른 값으로 계산했다가 안전선이 8px 밀렸다(2026-08-21).
       고정 높이 요소는 자르지 않고 앞 요소 바로 뒤로 밀되, 그 사실을 계산에 반영한다. */
  const place = (m: Mark, cur: number) => {
    let top = Math.round(m.top), h = Math.round(m.h);
    const fixed = m.txt !== undefined || m.ring;
    if (top < cur) {
      if (fixed) top = cur;                       // 높이는 그대로, 자리만 뒤로
      else { h -= (cur - top); top = cur; }       // 겹친 만큼 잘라 위치를 지킨다
    }
    return { top, h, skip: h <= 0 };
  };
  const sortMarks = (marks: Mark[]) => marks.filter(x => x.h > 0).sort((a, b) => a.top - b.top);
  /* 실제 배치 결과의 마지막 바닥 — 안전선 눈금을 어디 둘지 판정할 때 쓴다 */
  const layoutEnd = (marks: Mark[]) => {
    let cur = 0;
    for (const m of sortMarks(marks)) {
      const r = place(m, cur);
      if (!r.skip) cur = r.top + r.h;
    }
    return cur;
  };
  const stack = (marks: Mark[]) => {
    let cur = 0; const out: string[] = [];
    for (const m of sortMarks(marks)) {
      const r = place(m, cur);
      if (r.skip) continue;
      if (r.top > cur) out.push(sp(r.top - cur));
      out.push(m.txt !== undefined ? label(m.txt, m.bg)
             : m.ring ? ring(m.bg)
             : bar(r.h, m.bg, m.w, m.round));
      cur = r.top + r.h;
    }
    return out.join('');
  };

  /* ── 값 라벨을 붙일 칸 고르기 ────────────────────────────────────────
     56칸 전부에 라벨을 달면 겹쳐서 못 읽는다. 중요한 것부터 넣고, 이미 넣은 라벨과
     6칸 안에 붙으면 건너뛴다. 우선순위: 최저점 → 마지막 날 → 첫날 → 변동액이 큰 날.
     최저점을 1순위로 두는 이유는 이 차트를 보는 목적이 '언제 얼마까지 떨어지나' 라서다. */
  const chg: { i: number; d: number }[] = [];
  for (let i = 1; i < line.length; i++)
    if (line[i] !== null && line[i - 1] !== null && line[i] !== line[i - 1])
      chg.push({ i, d: Math.abs(line[i] - line[i - 1]) });
  let lowI = -1, lowV = Infinity;
  line.forEach((v, i) => { if (v !== null && v < lowV) { lowV = v; lowI = i; } });
  const cand = [lowI, line.length - 1, 0, ...chg.sort((a, b) => b.d - a.d).map(x => x.i)];
  const labelAt = new Set<number>();
  for (const i of cand) {
    if (i < 0 || line[i] === null || labelAt.size >= 8) continue;
    if ([...labelAt].some(j => Math.abs(j - i) < 6)) continue;
    labelAt.add(i);
  }

  const cols = dates.map((_d, i) => {
    const v = line[i];
    if (v === null) return `<td width="${colW}%" style="${ZT}">&nbsp;</td>`;
    const isAct = actVals[i] !== null;
    const below = floor > 0 && v < floor;
    const col = below ? (isAct ? COL_ACTB : COL_PRJB) : (isAct ? COL_ACT : COL_PRJ);
    const prev = i > 0 ? line[i - 1] : null;
    const changed = prev !== null && prev !== v;

    const marks: Mark[] = [];
    if (changed) {
      /* 수직 연결선 — 이전 값과 현재 값 사이를 잇는다. 선 두께만큼만 좁게(가운데 정렬). */
      const a = yTop(prev), b = yTop(v);
      marks.push({ top: Math.min(a, b), h: Math.abs(a - b) + LW, bg: col, w: LW });
      /* 값 라벨이 붙는 칸은 속 빈 원(예시 이미지 모양), 아니면 작은 점 */
      if (labelAt.has(i)) marks.push({ top: yTop(v) - 3, h: RING + 4, bg: col, ring: true });
      else marks.push({ top: yTop(v) - Math.round((DOT - LW) / 2), h: DOT, bg: col, w: DOT, round: true });
    } else {
      marks.push({ top: yTop(v), h: LW, bg: col });   // 가로선은 셀 폭 전체 → 옆 칸과 이어진다
    }
    /* 값 라벨 — 선 위쪽에 억 단위로. 라벨 칸인데 변화가 없는 날이면 링도 같이 찍는다. */
    if (labelAt.has(i)) {
      if (!changed) marks.push({ top: yTop(v) - 3, h: RING + 4, bg: col, ring: true });
      /* 위에 자리가 없으면 아래로 뒤집는다 — 억지로 0 에 붙이면 링과 겹쳐 배치가 밀린다.
         실제 차트도 축에 붙은 점의 라벨은 반대쪽에 그린다. */
      const above = yTop(v) - LBL - 6;
      const lt = above >= 0 ? above : yTop(v) + RING + 6;
      marks.push({ top: lt, h: LBL, bg: col, txt: `${(v / 1e8).toFixed(2)}억` });
    }
    /* 안전선 눈금 — 두 칸마다 찍어 점선처럼 보이게 한다(선과 헷갈리지 않게 1px).
       ⚠⚠ stack() 은 위에서부터 쌓으므로 앞 요소와 겹치면 눈금이 아래로 밀려 **안전선이
         흔들려 보였다**(2026-08-21). 명목 위치로 겹침을 판정했더니 라벨이 차트 위쪽에서
         잘릴 때 연쇄로 밀리는 경우를 놓쳤다.
       → **실제 배치 결과(layoutEnd)** 를 기준으로, 눈금이 다른 마크보다 확실히 위이거나
         확실히 아래일 때만 찍는다. 그 두 경우는 여백 계산이 정확해 위치가 딱 맞는다.
         사이에 끼면 생략한다 — 이미 점선이라 빈 칸이 자연스럽고, 틀린 높이보다 낫다. */
    if (floor > 0 && i % 2 === 0) {
      const ft = yTop(floor);
      const topMost = Math.min(...marks.map(m => Math.round(m.top)));
      const end = layoutEnd(marks);
      if (ft + 1 < topMost || ft > end) marks.push({ top: ft, h: 1, bg: COL_FLOOR });
    }
    /* 커서를 올리면 그날 잔액이 보인다 — 메일에서 :hover 는 못 믿지만 title 속성은
       웹메일(브라우저)에서 그대로 동작한다. 열 전체를 대상으로 해 잡기 쉽게 한다. */
    const tip = `${dates[i]} 잔액 ${fmt(v)}${isAct ? ' (확정)' : ' (궤적)'}${below ? ' · 안전선 미달' : ''}`;
    return `<td width="${colW}%" valign="top" height="${H}" title="${tip}" style="${ZT}">${stack(marks)}</td>`;
  }).join('');   // Edge 는 html`` 태그드 템플릿이 없어 배열을 직접 넣으면 콤마가 섞인다

  /* x축 — 주 시작일마다 눈금 */
  const ticks = dates.map((d, i) => (i % 7 === 0)
    ? `<td colspan="7" style="font-size:9.5px;color:${C.t3};padding-top:4px;white-space:nowrap">${md(d)}</td>`
    : '').join('');

  return `
<tr><td style="background:${C.card};padding:0 18px"><div style="height:1px;background:${C.border}"></div></td></tr>
<tr><td style="background:${C.card};padding:18px 18px 14px">
  <div style="font-size:13px;font-weight:700;color:${C.text};margin-bottom:3px">📈 일별 현금 잔액 추이 · 궤적</div>
  <div style="font-size:11px;color:${C.t3};margin-bottom:12px">${dates[0]} ~ ${dates[dates.length - 1]} (${Math.round(horizonDays / 7)}주) · ${basisNote}</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
    <tr>
      <!-- y축 라벨 -->
      <td width="46" valign="top" style="font-size:9.5px;color:${C.t3};line-height:1">
        <table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">
          <tr><td height="${Math.max(0, H - floorPx)}" valign="top" style="font-size:9.5px;color:${C.t3}">${eok(hi)}억</td></tr>
          ${floor > 0 ? `<tr><td height="${floorPx}" valign="top" style="font-size:9.5px;color:${C.red}">${eok(floor)}억</td></tr>` : ''}
        </table>
      </td>
      <td valign="bottom" style="border-left:1px solid ${C.border};border-bottom:1px solid ${C.border}">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>${cols}</tr></table>
      </td>
    </tr>
    <tr><td></td><td><table width="100%" cellpadding="0" cellspacing="0"><tr>${ticks}</tr></table></td></tr>
  </table>
  <div style="margin-top:8px;font-size:10.5px;color:${C.t3}">
    <span style="display:inline-block;width:14px;height:2px;background:${COL_ACT};vertical-align:middle"></span> 확정 &nbsp;
    <span style="display:inline-block;width:14px;height:2px;background:${COL_PRJ};vertical-align:middle"></span> 궤적 &nbsp;
    ${floor > 0 ? `&nbsp;|&nbsp; <span style="display:inline-block;width:14px;height:2px;background:${COL_ACTB};vertical-align:middle"></span> 안전선 미달(확정) &nbsp;
    <span style="display:inline-block;width:14px;height:2px;background:${COL_PRJB};vertical-align:middle"></span> 미달(궤적) &nbsp;
    <span style="display:inline-block;width:14px;height:1px;background:${COL_FLOOR};vertical-align:middle"></span> 안전선` : ''}
    &nbsp;· 점 = 잔액이 바뀐 날
  </div>
</td></tr>`;
}

/* ═══ 차주 입출금 예정 + 잔액 (메일용) ════════════════════════════════════
 * 궤적 차트는 "언제 얼마까지 떨어지나" 를 보여주지만 무엇 때문인지는 안 보여준다.
 * 차주 한 주만 건별로 펼쳐 잔액이 어떻게 깎여 가는지 같이 본다.
 * ⚠⚠ index.html 의 buildNextWeekPlanHTML 과 같은 내용의 사본이다 — 메일 HTML 이 미리보기와
 *   실제 발송 두 벌로 관리되는 구조라서다. 한쪽만 고치면 다른 숫자가 나간다.
 * ⚠ 잔액 기준을 차트와 똑같이 맞춘다 — 확정은 오늘까지, 그 뒤는 예정 누적, 연체 예정은
 *   오늘 시점에 한꺼번에. 여기서 다르게 계산하면 차트의 그 날 값과 표의 잔액이 어긋난다. */
function buildNextWeekPlanHTML(
  from: string, to: string, cfArr: Record<string, unknown>[], initCash: number,
  floor: number, C: Record<string, string>, today: string,
): string {
  const nwStart = from, nwEnd = to;   // 이름만 유지 — 구간은 호출부가 정한다(당일+10일)
  const rows = Array.isArray(cfArr) ? cfArr : [];
  const eok = (v: number) => (Number(v || 0) / 1e8).toFixed(2);
  const md  = (d: string) => d.slice(5).replace('-', '/');
  const DOW = ['일','월','화','수','목','금','토'];
  const dow = (d: string) => DOW[new Date(d + 'T00:00:00').getDay()];
  const num = (v: unknown) => Number(v) || 0;

  /* 어떤 날짜 시점의 잔액 — 차트(computeWeeklyCashSeries)와 같은 규칙 */
  const dayVal = (d: string) => {
    let v = initCash, overdue = 0;
    for (const r of rows) {
      const rd = String(r.date || ''); if (!rd) continue;
      const st = String(r.status || '');
      if (st === '실제 입금')      { if (rd <= d) v += num(r.in); }
      else if (st === '실제 지출') { if (rd <= d) v -= num(r.out); }
      else if (st === '입금 예정' || st === '지출 예정') {
        const dv = st === '입금 예정' ? num(r.in) : -num(r.out);
        if (rd <= today) overdue += dv;          // 연체 → 오늘로 몰아 얹는다
        else if (rd <= d) v += dv;
      }
    }
    return v + (d >= today ? overdue : 0);
  };

  /* 시작 잔액 = 당일 시점 잔액(차트의 오늘 값과 같다).
     ⚠ 연체 예정은 오늘 값에 이미 접혀 있으므로 행은 **오늘 다음날부터** — 오늘자 예정을
       행으로 또 세면 이중계상이다. 대신 연체가 있으면 아래 줄에 밝힌다. */
  const open = dayVal(today);
  const overdue = rows.filter(r => {
    const st = String(r.status || '');
    return (st === '입금 예정' || st === '지출 예정') && String(r.date || '')
        && String(r.date) <= today && (num(r.in) > 0 || num(r.out) > 0);
  });
  const overdueSum = overdue.reduce((s2, r) => s2 + (num(r.in) - num(r.out)), 0);
  const wk = rows.filter(r => String(r.date || '') > today && String(r.date || '') <= nwEnd
                          && (num(r.in) > 0 || num(r.out) > 0))
                 .sort((a, b) => String(a.date).localeCompare(String(b.date))
                              || (Math.abs(num(b.in) || num(b.out)) - Math.abs(num(a.in) || num(a.out))));

  const CAP = 30;
  const shown = wk.slice(0, CAP);
  let run = open;
  const trs = shown.map(r => {
    const st = String(r.status || '');
    const isIn = st === '입금 예정' || st === '실제 입금';
    const amt  = isIn ? num(r.in) : -num(r.out);
    run += amt;
    const planned = st === '입금 예정' || st === '지출 예정';
    const low = floor > 0 && run < floor;
    const bt = `border-top:1px solid ${C.border}`;
    return `<tr>
      <td style="padding:5px 6px;font-size:11.5px;color:${C.t2};white-space:nowrap;${bt}">${md(String(r.date))}(${dow(String(r.date))})</td>
      <td style="padding:5px 6px;font-size:11px;color:${planned ? C.t3 : C.text};white-space:nowrap;${bt}">${planned ? '예정' : '실제'}</td>
      <td style="padding:5px 6px;font-size:11.5px;color:${C.text};${bt}">${escapeHtml(String(r.desc || r.mid_cat || '—'))}</td>
      <td style="padding:5px 6px;font-size:11.5px;color:${amt >= 0 ? C.green : C.red};text-align:right;white-space:nowrap;${bt}">${amt >= 0 ? '+' : ''}${fmt(amt)}</td>
      <td style="padding:5px 6px;font-size:11.5px;font-weight:${low ? '700' : '400'};color:${low ? C.red : C.text};text-align:right;white-space:nowrap;${bt}">${fmt(run)}</td>
    </tr>`;
  }).join('');
  const rest = wk.slice(CAP);
  const restSum = rest.reduce((s, r) => s + (num(r.in) - num(r.out)), 0);
  const endBal = open + wk.reduce((s, r) => s + (num(r.in) - num(r.out)), 0);
  const inSum  = wk.reduce((s, r) => s + num(r.in), 0);
  const outSum = wk.reduce((s, r) => s + num(r.out), 0);
  const endLow = floor > 0 && endBal < floor;
  const bt2 = `border-top:2px solid ${C.border}`;

  return `
<tr><td style="background:${C.card};padding:0 18px"><div style="height:1px;background:${C.border}"></div></td></tr>
<tr><td style="background:${C.card};padding:18px 18px 14px">
  <div style="font-size:13px;font-weight:700;color:${C.text};margin-bottom:3px">📅 입출금 예정 (당일 잔액 기준 · 향후 10일)</div>
  <div style="font-size:11px;color:${C.t3};margin-bottom:10px">${addDays(today, 1)} ~ ${nwEnd} · 입금 ${fmt(inSum)} · 지출 ${fmt(outSum)} · ${wk.length}건</div>
  ${wk.length === 0
    ? `<div style="font-size:12.5px;color:${C.t3};padding:10px 0">등록된 예정이 없습니다.</div>`
    : `<table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 6px 6px;font-size:10.5px;color:${C.t3};white-space:nowrap">날짜</td>
        <td style="padding:0 6px 6px;font-size:10.5px;color:${C.t3}">구분</td>
        <td style="padding:0 6px 6px;font-size:10.5px;color:${C.t3}">내용</td>
        <td style="padding:0 6px 6px;font-size:10.5px;color:${C.t3};text-align:right">금액</td>
        <td style="padding:0 6px 6px;font-size:10.5px;color:${C.t3};text-align:right">잔액</td>
      </tr>
      <tr>
        <td colspan="4" style="padding:5px 6px;font-size:11.5px;color:${C.t2};background:${C.bg3}">시작 잔액 (당일 ${md(today)} 기준)${overdue.length ? `<span style="font-size:10.5px;color:${C.t3}"> · 연체 예정 ${overdue.length}건 ${fmt(overdueSum)} 포함</span>` : ''}</td>
        <td style="padding:5px 6px;font-size:11.5px;color:${C.text};text-align:right;white-space:nowrap;background:${C.bg3}">${fmt(open)}</td>
      </tr>
      ${trs}
      ${rest.length ? `<tr>
        <td colspan="4" style="padding:5px 6px;font-size:11px;color:${C.t3};border-top:1px solid ${C.border}">… 외 ${rest.length}건 (합계 ${restSum >= 0 ? '+' : ''}${fmt(restSum)})</td>
        <td style="border-top:1px solid ${C.border}"></td>
      </tr>` : ''}
      <tr>
        <td colspan="4" style="padding:7px 6px;font-size:12px;font-weight:700;color:${C.text};${bt2}">${md(nwEnd)} 잔액</td>
        <td style="padding:7px 6px;font-size:13px;font-weight:700;color:${endLow ? C.red : C.text};text-align:right;white-space:nowrap;${bt2}">${fmt(endBal)}</td>
      </tr>
    </table>
    ${floor > 0 && endLow ? `<div style="margin-top:8px;font-size:11px;color:${C.red}">${md(nwEnd)} 잔액이 안전선 ${eok(floor)}억을 ${eok(floor - endBal)}억 밑돕니다.</div>` : ''}`}
</td></tr>`;
}

/* ── HTML 이메일 빌더 ─────────────────────────────────────────────────── */
// index.html buildWeeklyReportHTML()과 동일한 계산 로직
// KPI: 전주 기말 / 주간 입금 / 주간 지출 / 금주 기말 (화면과 동일)
// 입금·지출 표 세 번째 컬럼: 중분류 (거래처가 아닌 mid_cat 값)
function buildWeeklyReportHTML(
  targetDate    : string,
  cfArr         : Record<string, unknown>[],
  arArr         : Record<string, unknown>[],
  initCash      : number,
  dashboardUrl  : string = '',
  weeklySummary : { summary: string; updated_at: string | null } = { summary: '', updated_at: null },
  floor         : number = 0,          // 안전선 — 궤적 블록의 '하회' 판정용
): { html: string; subject: string; weekKey: string; startDate: string; endDate: string } {

  const C = {
    green:'#2A7F57', red:'#C24A38', red2:'#F7E4DE',
    amber:'#9E6A15', blue:'#314840', /* RAWGA DEEP GREEN — Brand Identity Guidelines V2.0 */
    text:'#1B2B30', t2:'#55655D', t3:'#94A296',
    bg:'#F2F5F1', bg3:'#E9EFE7', card:'#ffffff', border:'#DDE6DA',
  };

  /* 주간 범위 & 주차 계산 */
  const { wStart, wEnd, pwStart, pwEnd, nwStart, nwEnd } = getWeekRange(targetDate);
  const thuStr  = addDays(wStart, 3);
  const thuDate = new Date(thuStr + 'T00:00:00');
  const wYear   = thuDate.getFullYear();
  const wMon    = thuDate.getMonth() + 1;
  const wNum    = getWeekNumByThursday(thuStr);
  const fmtMD   = (s: string) => (s || '').slice(5).replace('-', '/');

  /* CF 집계 */
  const wCF  = cfArr.filter(r => (r.date as string) >= wStart && (r.date as string) <= wEnd);
  const isInterAccount = (r: Record<string, unknown>) => ((r.mid_cat as string) || '').trim() === '계좌간이체'; // [계좌간이체 제외]
  const wIn  = wCF.filter(r => r.status === '실제 입금' && !isInterAccount(r)).reduce((s, r) => s + ((r.in  as number) || 0), 0); // [계좌간이체 제외]
  const wOut = wCF.filter(r => r.status === '실제 지출' && !isInterAccount(r)).reduce((s, r) => s + ((r.out as number) || 0), 0); // [계좌간이체 제외]
  const wNet = wIn - wOut;

  /* 기말 잔액 + 월간 대시보드 요약용 계산 */
  // dashboardKpiDate: 월간 대시보드 요약 전용 기준일 = wEnd(해당 주 일요일)
  // targetDate가 월요일(wStart)인 경우에도 화~일 거래가 포함되도록 wEnd를 사용
  const dashboardKpiDate = wEnd;
  let pwEndCash = initCash, wkEndCash = initCash, cash = initCash;
  let nwIn = 0, nwOut = 0;
  for (const r of cfArr) {
    if (r.status === '실제 입금' && (r.date as string) <= pwEnd)             pwEndCash += (r.in  as number) || 0;
    if (r.status === '실제 지출' && (r.date as string) <= pwEnd)             pwEndCash -= (r.out as number) || 0;
    if (r.status === '실제 입금' && (r.date as string) <= wEnd)              wkEndCash += (r.in  as number) || 0;
    if (r.status === '실제 지출' && (r.date as string) <= wEnd)              wkEndCash -= (r.out as number) || 0;
    // 월간 대시보드 요약: wEnd(해당 주 일요일) 기준 — 화~일 거래 포함 보장
    if (r.status === '실제 입금' && (r.date as string) <= dashboardKpiDate)  cash += (r.in  as number) || 0;
    if (r.status === '실제 지출' && (r.date as string) <= dashboardKpiDate)  cash -= (r.out as number) || 0;
    // 차주 예상 기말현금: 입금예정+실제, 지출예정+실제 (calcKPIs의 nextCash와 동일 기준)
    if ((r.status === '입금 예정' || r.status === '실제 입금') && (r.date as string) >= nwStart && (r.date as string) <= nwEnd) nwIn  += (r.in  as number) || 0;
    if ((r.status === '지출 예정' || r.status === '실제 지출') && (r.date as string) >= nwStart && (r.date as string) <= nwEnd) nwOut += (r.out as number) || 0;
  }
  const nextCash = cash + nwIn - nwOut;

  /* 입금/지출 상위 내역 (KPI와 동일: 실제 거래만) */
  const inRows  = wCF.filter(r => r.status === '실제 입금' && !isInterAccount(r) && ((r.in  as number) || 0) > 0) // [계좌간이체 제외]
                     .sort((a, b) => (b.in  as number) - (a.in  as number));
  const outRows = wCF.filter(r => r.status === '실제 지출' && !isInterAccount(r) && ((r.out as number) || 0) > 0) // [계좌간이체 제외]
                     .sort((a, b) => (b.out as number) - (a.out as number));

  /* 중분류별 그룹 집계 */
  const groupWeeklyRowsByMid = (
    rows: Record<string, unknown>[],
    amtField: 'in' | 'out',
  ): { mid_cat: string; big_cat: string; amount: number; conflict: boolean }[] => {
    const map: Record<string, { big_cat: string; amount: number; bigCats: Set<string> }> = {};
    rows.forEach(r => {
      const key = ((r.mid_cat as string) || '').trim() || '(미분류)';
      if (!map[key]) map[key] = { big_cat: (r.big_cat as string) || '', amount: 0, bigCats: new Set() };
      map[key].amount += (r[amtField] as number) || 0;
      const bc = ((r.big_cat as string) || '').trim();
      if (bc) map[key].bigCats.add(bc);
    });
    return Object.entries(map)
      .map(([mid_cat, g]) => ({
        mid_cat,
        big_cat: g.bigCats.size > 1 ? [...g.bigCats].join(' / ') : (g.big_cat || '—'),
        amount: g.amount,
        conflict: g.bigCats.size > 1,
      }))
      .sort((a, b) => b.amount - a.amount);
  };
  const groupedIn  = groupWeeklyRowsByMid(inRows,  'in');
  const groupedOut = groupWeeklyRowsByMid(outRows, 'out');
  const wkLabel = `${fmtMD(wStart)}~${fmtMD(wEnd)}`;

  /* 대분류별 집계 (big_cat 기준, 실제 거래만, 입금+지출 합계 내림차순) */
  const bigCatMap: Record<string, { in: number; out: number }> = {};
  wCF.forEach(r => {
    if (r.status !== '실제 입금' && r.status !== '실제 지출') return;
    if (isInterAccount(r)) return; // [계좌간이체 제외]
    const k = ((r.big_cat as string) || '').trim() || '(미분류)';
    if (!bigCatMap[k]) bigCatMap[k] = { in: 0, out: 0 };
    bigCatMap[k].in  += (r.in  as number) || 0;
    bigCatMap[k].out += (r.out as number) || 0;
  });
  const bigCatRows = Object.entries(bigCatMap)
    .map(([cat, v]) => ({ cat, in: v.in, out: v.out }))
    .filter(x => x.in > 0 || x.out > 0)
    .sort((a, b) => (b.in + b.out) - (a.in + a.out));

  /* AR 집계 — 상태/위험등급 실시간 재계산: targetDate 기준 */
  const calcARStatusAndRiskTS = (
    ar: Record<string, unknown>,
    base: string,
  ): { status: string; riskLevel: string; basisDays: number } => {
    const remaining = Number(ar.remaining || 0);
    const due   = (ar.due_date   as string) || '';
    const start = (ar.start      as string) || '';
    const daysB = (s: string, e: string) => {
      if (!s || !e) return 0;
      return Math.max(0, Math.floor(
        (new Date(e + 'T00:00:00').getTime() - new Date(s + 'T00:00:00').getTime()) / 86400000,
      ));
    };
    if (remaining <= 0) return { status: '완료', riskLevel: '',    basisDays: 0 };
    if (!due)           { const d = start ? daysB(start, base) : 0;
                          return { status: '미정', riskLevel: d > 30 ? '위험' : '보통', basisDays: d }; }
    if (base > due)     { const d = daysB(due, base);
                          return { status: '지연', riskLevel: d > 30 ? '위험' : '보통', basisDays: d }; }
    return               { status: '정상', riskLevel: '보통', basisDays: 0 };
  };
  const arView  = arArr.map(a => ({ ...a, ...calcARStatusAndRiskTS(a, targetDate) }));
  const wNewAR    = arView.filter(a => (a.start as string) >= wStart && (a.start as string) <= wEnd);
  const wNewAmt   = wNewAR.reduce((s, a) => s + ((a.expected as number) || 0), 0);
  const wColCF    = cfArr.filter(r =>
    r.ar_applied === '완료' &&
    (r.ar_applied_date as string) >= wStart &&
    (r.ar_applied_date as string) <= wEnd,
  );
  const wColAmt   = wColCF.reduce((s, r) => s + ((r.in as number) || 0), 0);
  const remAll    = arView.filter(a => ((a.remaining as number) || 0) > 0);
  const remTotal  = remAll.reduce((s, a) => s + ((a.remaining as number) || 0), 0);
  const highRisk  = arView
    .filter(a => a.riskLevel === '위험')
    .sort((a, b) => {
      const ed = ((b.basisDays as number) || 0) - ((a.basisDays as number) || 0);
      return ed !== 0 ? ed : ((b.remaining as number) || 0) - ((a.remaining as number) || 0);
    });
  const highRiskAmt = highRisk.reduce((s, a) => s + ((a.remaining as number) || 0), 0);

  // 지연+미정 AR 요약 (대시보드 매출채권 잔액 하단 표시 — 리포팅 주간 지연 카드와 동일 기준)
  const dlyAR      = arView.filter(a => ((a.remaining as number) || 0) > 0 && (a.status === '지연' || a.status === '미정'));
  const dlyAmt     = dlyAR.reduce((s, a) => s + ((a.remaining as number) || 0), 0);
  const dlyTotal   = dlyAR.length;
  const dlyNormal  = dlyAR.filter(a => a.riskLevel === '보통').length;
  const dlyDanger  = dlyAR.filter(a => a.riskLevel === '위험').length;
  const dlyNrRate  = dlyTotal ? Math.round(dlyNormal / dlyTotal * 100) : 0;
  const dlyDrRate  = dlyTotal ? Math.round(dlyDanger / dlyTotal * 100) : 0;
  const dlySub     = `지연 총 ${dlyTotal}건(보통 ${dlyNormal}건(${dlyNrRate}%) · 위험 ${dlyDanger}건(${dlyDrRate}%))`;
  // 매출채권 잔액 카드 sub: 전체 미회수(remaining>0) 기준 정상/보통/위험 건수
  const arActive    = arView.filter(a => Number((a.remaining as number) || 0) > 0);
  const arActTotal  = arActive.length;
  const arActNormal = arActive.filter(a => a.status === '정상').length;
  const arActOrd    = arActive.filter(a => (a.status === '지연' || a.status === '미정') && a.riskLevel === '보통').length;
  const arActDanger = arActive.filter(a => (a.status === '지연' || a.status === '미정') && a.riskLevel === '위험').length;
  const _pB = (n: number) => arActTotal ? Math.round(n / arActTotal * 100) : 0;
  const arBalanceSub = `전체 ${arActTotal}건(정상 ${arActNormal}건(${_pB(arActNormal)}%) · 보통 ${arActOrd}건(${_pB(arActOrd)}%) · 위험 ${arActDanger}건(${_pB(arActDanger)}%))`;

  /* 월간 대시보드 요약 KPI (calcKPIs와 동일 계산 기준) */
  const totalAR         = remTotal;          // 매출채권 잔액 = 전체 미회수 합계
  const highRiskARCount = highRisk.length;   // 고위험 AR 건수 (elapsed≥60 or 지연)
  const totalLiquid     = cash + totalAR;    // 총 유동자산 = 현금 + 채권
  const sejongTotal = cfArr
    .filter(r => r.big_cat === '세종시' && (r.status === '실제 지출' || r.status === '지출 예정'))
    .reduce((s, r) => s + ((r.out as number) || 0), 0);
  const sejongCount = cfArr.filter(r => r.big_cat === '세종시').length;
  const laosTotal   = cfArr
    .filter(r => r.big_cat === '라오스' && (r.status === '실제 지출' || r.status === '지출 예정'))
    .reduce((s, r) => s + ((r.out as number) || 0), 0);
  const laosCount   = cfArr.filter(r => r.big_cat === '라오스').length;
  const totalPhysical   = sejongTotal + laosTotal;  // 총 현물자산 = 세종F2 + 라오스
  const totalAsset      = totalLiquid + totalPhysical; // 총 자산 합계 = 유동 + 현물
  const refYear  = parseInt(dashboardKpiDate.slice(0, 4));
  const refMonth = parseInt(dashboardKpiDate.slice(5, 7));

  /* HTML 조각 헬퍼 */
  const B   = C.border;
  const TDS = `padding:6px 8px;font-size:12px;border-bottom:1px solid ${B};`;
  const THS = `padding:7px 8px;font-size:11px;font-weight:600;color:${C.t2};background:${C.bg3};text-align:`;

  // kpi 카드 — 균일 높이(110px, box-sizing:border-box) + vertical-align:top
  const kpi = (label: string, val: string, color: string, sub: string) =>
    `<td width="25%" style="padding:0 5px 8px;vertical-align:top">
      <div style="background:${C.card};border:1px solid ${B};border-radius:8px;padding:14px 10px;text-align:center;height:110px;box-sizing:border-box;overflow:hidden">
        <div style="font-size:10px;color:${C.t2};text-transform:uppercase;letter-spacing:.3px;margin-bottom:6px">${label}</div>
        <div style="font-size:18px;font-weight:700;color:${color};font-family:monospace">${val}</div>
        <div style="font-size:10px;color:${C.t3};margin-top:4px">${sub}</div>
      </div>
    </td>`;

  // ── 이메일 HTML 렌더링 방침 ──────────────────────────────────────────────
  // Gmail/Outlook 등 이메일 클라이언트 제약:
  //  • JavaScript 완전 차단 → 클릭 토글 불가
  //  • overflow-y:auto / position:sticky → Outlook 데스크탑·iOS Mail 등 무시됨
  // 표별 표시 방침:
  //  • 입금 내역    : 금액 큰 순 상위 EMAIL_MAX_ROWS건 + 전체 건수·합계 배지 + 전체 보기 행
  //  • 지출 내역    : 금액 큰 순 상위 EMAIL_MAX_ROWS건 + 전체 건수·합계 배지 + 전체 보기 행
  //  • 대분류 현황  : 전체 행 표시 (건수 제한 없음, 스크롤 없음)
  //  • 고위험 AR   : 경과일↓·미회수↓ 상위 EMAIL_MAX_ROWS건 + 전체 건수·합계 배지 + 전체 보기 행
  // Dry-run 미리보기(index.html buildWeeklyReportHTML)는 브라우저 new window에서
  //   overflow:auto + position:sticky 헤더로 개별 스크롤 지원 (이 파일과 별개)
  // ─────────────────────────────────────────────────────────────────────────
  const EMAIL_MAX_ROWS = 10;
  const EMAIL_DETAIL_MIN_AMOUNT = 1_000_000; // 이메일 입금/출금 내역 표시 최소 금액 (중분류 합산 기준)
  const empty4 = `<tr><td colspan="4" style="text-align:center;color:${C.t3};padding:14px;font-size:12px">내역 없음</td></tr>`;

  // 이메일 표시용 필터 — 100만원 미만 중분류 그룹 제외
  // groupedIn / groupedOut 원본은 유지 (KPI 합계 계산과 무관)
  const displayGroupedIn  = groupedIn.filter(g => g.amount >= EMAIL_DETAIL_MIN_AMOUNT);
  const displayGroupedOut = groupedOut.filter(g => g.amount >= EMAIL_DETAIL_MIN_AMOUNT);

  // ── URL 유효성 검증: http:// 또는 https://로 시작하는 값만 링크에 사용 ──
  // 잘못된 URL(빈 문자열, 공백, 상대경로 등)은 텍스트 안내로 폴백
  const safeUrl = /^https?:\/\/.+/i.test(dashboardUrl) ? dashboardUrl : '';

  // 딥링크 URL: hash·query·trailing slash 제거 후 /#reporting-weekly 추가
  // GitHub Pages 안정성을 위해 항상 rawga-dashboard/#reporting-weekly 형태로 정규화
  // 예: https://helen894.github.io/rawga-dashboard/#reporting-weekly
  const baseDashboardUrl = safeUrl
    ? safeUrl.replace(/#.*$/, '').replace(/\?.*$/, '').replace(/\/$/, '')
    : '';
  const safeUrlWeekly = baseDashboardUrl
    ? `${baseDashboardUrl}/#reporting-weekly`
    : '';

  // 대시보드 링크 행 — 입금/지출/고위험AR 섹션 하단에 항상 표시
  // • safeUrlWeekly 있음 : 클릭 가능한 <a> 링크 → 리포팅 > 주간 탭 딥링크
  // • safeUrlWeekly 없음 : 텍스트 안내만 표시 (링크 없음)
  // ※ 건수 10건 초과 여부와 무관하게 항상 호출됨 (링크 누락 방지)
  const dashboardLinkRow = (cols: number): string =>
    safeUrlWeekly
      ? `<tr><td colspan="${cols}" style="text-align:center;padding:9px 8px;font-size:11px;color:${C.t3};border-top:1px solid ${B}">전체 내역은 <a href="${safeUrlWeekly}" target="_blank" style="color:${C.blue};text-decoration:none;font-weight:600">대시보드에서 확인</a>하세요</td></tr>`
      : `<tr><td colspan="${cols}" style="text-align:center;padding:9px 8px;font-size:11px;color:${C.t3};border-top:1px solid ${B}">전체 내역은 대시보드에서 확인하세요</td></tr>`;

  // 입금 내역 — 100만원 이상 중분류 그룹만 표시 + 하단 링크 행(항상)
  const emptyIn4  = `<tr><td colspan="4" style="text-align:center;color:${C.t3};padding:14px;font-size:12px">100만원 이상 입금 내역 없음</td></tr>`;
  const emptyOut4 = `<tr><td colspan="4" style="text-align:center;color:${C.t3};padding:14px;font-size:12px">100만원 이상 출금 내역 없음</td></tr>`;
  const inHtml = (displayGroupedIn.length
    ? displayGroupedIn.map(g =>
        `<tr>
          <td style="${TDS}color:${C.t2}">${wkLabel}</td>
          <td style="${TDS}">${escapeHtml(g.mid_cat)}</td>
          <td style="${TDS}color:${g.conflict ? C.amber : C.t2}">${escapeHtml(g.big_cat)}</td>
          <td style="${TDS}text-align:right;color:${C.green};font-family:monospace">+${fmt(g.amount)}</td>
        </tr>`).join('')
    : emptyIn4)
    + dashboardLinkRow(4); // 링크 행: 표시 대상 0건이어도 항상 표시

  // 지출 내역 — 100만원 이상 중분류 그룹만 표시 + 하단 링크 행(항상)
  const outHtml = (displayGroupedOut.length
    ? displayGroupedOut.map(g =>
        `<tr>
          <td style="${TDS}color:${C.t2}">${wkLabel}</td>
          <td style="${TDS}">${escapeHtml(g.mid_cat)}</td>
          <td style="${TDS}color:${g.conflict ? C.amber : C.t2}">${escapeHtml(g.big_cat)}</td>
          <td style="${TDS}text-align:right;color:${C.red};font-family:monospace">-${fmt(g.amount)}</td>
        </tr>`).join('')
    : emptyOut4)
    + dashboardLinkRow(4); // 링크 행: 표시 대상 0건이어도 항상 표시

  // 대분류별 현황 — 전체 행 표시 (건수 제한 없음, 스크롤 없음, 링크 행 없음)
  const bigCatHtml = bigCatRows.length
    ? bigCatRows.map(x =>
        `<tr>
          <td style="${TDS}font-weight:500">${escapeHtml(x.cat)}</td>
          <td style="${TDS}text-align:right;color:${x.in  > 0 ? C.green : C.t3};font-family:monospace">${x.in  > 0 ? '+' + fmt(x.in)  : '—'}</td>
          <td style="${TDS}text-align:right;color:${x.out > 0 ? C.red   : C.t3};font-family:monospace">${x.out > 0 ? '-' + fmt(x.out) : '—'}</td>
        </tr>`).join('')
    : `<tr><td colspan="3" style="text-align:center;color:${C.t3};padding:14px;font-size:12px">이번 주 거래 없음</td></tr>`;

  // highRiskTopRows / highRiskHtml 제거 — ⚠️ 고위험 매출채권 섹션 이메일에서 제거됨

  const subject = `[RAWGA] ${wYear}년 ${wMon}월 ${wNum}주차 주간 자금 리포트 (${fmtMD(wStart)}~${fmtMD(wEnd)})`;
  const sentAt  = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${subject}</title></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:24px 0">
<tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%">

<!-- 헤더 -->
<tr><td style="background:${C.blue};border-radius:12px 12px 0 0;padding:26px 24px 20px">
  <div style="font-size:12px;color:rgba(255,255,255,.65);letter-spacing:.5px;margin-bottom:4px">RAWGA 주간 자금 리포트</div>
  <div style="font-size:22px;font-weight:700;color:#fff;margin-bottom:6px">${wYear}년 ${wMon}월 ${wNum}주차</div>
  <div style="font-size:13px;color:rgba(255,255,255,.65)">${wStart} (월) ~ ${wEnd} (일)</div>
</td></tr>

<!-- 📝 주간 요약 — **헤더 바로 아래**(2026-08-21 이동).
     사람이 직접 쓴 판단이 이 메일에서 가장 중요한 내용이라 숫자보다 먼저 읽히게 한다. -->
<tr><td style="background:${C.card};padding:18px 18px 12px">
  <div style="font-size:13px;font-weight:600;color:${C.text};margin-bottom:8px">📝 주간 요약</div>
  <div style="font-size:13px;color:${C.t2};line-height:1.7">${
    weeklySummary.summary
      ? escapeHtml(weeklySummary.summary).replace(/\r?\n/g, '<br>')
      : '등록된 주간 요약이 없습니다.'
  }</div>
  <div style="font-size:11px;color:${C.t3};margin-top:8px">마지막 수정일: ${formatUpdatedAtSeoul(weeklySummary.updated_at)}</div>
</td></tr>
<tr><td style="background:${C.card};padding:0 18px"><div style="height:1px;background:${C.border}"></div></td></tr>
<!-- 📊 월간 대시보드 요약 -->
<tr><td style="background:${C.card};padding:18px 18px 8px">
  <div style="font-size:13px;font-weight:700;color:${C.text};margin-bottom:3px">📊 월간 대시보드 요약</div>
  <div style="font-size:11px;color:${C.t3};margin-bottom:12px">기준월: ${refYear}년 ${refMonth}월 &nbsp;·&nbsp; 기준일: ${dashboardKpiDate}</div>
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    ${kpi('현재 현금잔액', fmt(cash), cash >= 0 ? C.green : C.red, `기준: ${dashboardKpiDate}`)}
    ${kpi('매출채권 잔액', fmt(totalAR), C.amber, arBalanceSub)}
    ${kpi('총 유동자산', fmt(totalLiquid), totalLiquid >= 0 ? C.blue : C.red, `현금 ${fmt(cash)} + 채권 ${fmt(totalAR)}`)}
    ${kpi('총 자산 합계', fmt(totalAsset), totalAsset >= 0 ? C.green : C.red, `유동 ${fmt(totalLiquid)} + 현물 ${fmt(totalPhysical)}`)}
  </tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px"><tr>
    ${kpi('세종F2', fmt(sejongTotal), C.red, `세종시 ${sejongCount}건 (예정 포함)`)}
    ${kpi('라오스', fmt(laosTotal), C.red, `라오스 ${laosCount}건 (예정 포함)`)}
    ${kpi('총 현물자산', fmt(totalPhysical), C.amber, `세종 ${fmt(sejongTotal)} + 라오스 ${fmt(laosTotal)}`)}
    ${kpi('차주 예상기말현금', fmt(nextCash), nextCash >= 0 ? C.blue : C.red, `${fmtMD(nwStart)}~${fmtMD(nwEnd)} (예정+실제)`)}
  </tr></table>
</td></tr>
<tr><td style="background:${C.card};padding:0 18px"><div style="height:1px;background:${C.border}"></div></td></tr>

<!-- 📅 주간 자금 요약 -->
<tr><td style="background:${C.card};padding:18px 18px 12px">
  <div style="font-size:13px;font-weight:700;color:${C.text};margin-bottom:10px">📅 주간 자금 요약</div>
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    ${kpi('전주 기말잔액', fmt(pwEndCash), pwEndCash >= 0 ? C.green : C.red, `기준: ${fmtMD(pwEnd)}`)}
    ${kpi('주간 입금',     fmt(wIn),       C.green, `${fmtMD(wStart)}~${fmtMD(wEnd)}`)}
    ${kpi('주간 지출',     fmt(wOut),      C.red,   `${fmtMD(wStart)}~${fmtMD(wEnd)}`)}
    ${kpi('당주 기말잔액', fmt(wkEndCash), wkEndCash >= 0 ? C.green : C.red, `기준: ${fmtMD(wEnd)}`)}
  </tr></table>
  <div style="margin-top:10px;padding:10px 12px;background:${C.bg3};border-radius:6px;font-size:13px;color:${C.t2}">
    전주 대비 현금흐름
    <span style="font-weight:700;color:${wNet >= 0 ? C.green : C.red};margin-left:6px">${wNet >= 0 ? '+' : ''}${fmt(wNet)}</span>
    <span style="font-size:11px;color:${C.t3};margin-left:8px">입금 ${fmt(wIn)} − 지출 ${fmt(wOut)}</span>
  </div>
</td></tr>
${buildWeeklyTrajBlockHTML(wStart, cfArr, initCash, floor, C, WKRPT_HORIZON_DAYS, todaySeoul())}
${buildNextWeekPlanHTML(todaySeoul(), addDays(todaySeoul(), 10), cfArr, initCash, floor, C, todaySeoul())}
<tr><td style="background:${C.card};padding:0 18px"><div style="height:1px;background:${C.border}"></div></td></tr>

<!-- 💰 주간 입금 내역 -->
<tr><td style="background:${C.card};padding:18px 18px 0">
  <div style="font-size:13px;font-weight:600;color:${C.green};margin-bottom:8px">💰 주간 입금 내역${groupedIn.length > 0
    ? ` <span style="font-size:11px;font-weight:400;color:${C.t2}">총 ${groupedIn.length}개 중분류 중 100만원 이상 ${displayGroupedIn.length}개 표시 · 전체 입금액 ${fmt(wIn)}원</span>`
    : ''}</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${B};border-radius:6px;overflow:hidden">
    <tr><th style="${THS}left">날짜</th><th style="${THS}left">중분류</th><th style="${THS}left">대분류</th><th style="${THS}right">금액</th></tr>
    ${inHtml}
  </table>
</td></tr>

<!-- 💸 주간 지출 내역 -->
<tr><td style="background:${C.card};padding:18px 18px 0">
  <div style="font-size:13px;font-weight:600;color:${C.red};margin-bottom:8px">💸 주간 지출 내역${groupedOut.length > 0
    ? ` <span style="font-size:11px;font-weight:400;color:${C.t2}">총 ${groupedOut.length}개 중분류 중 100만원 이상 ${displayGroupedOut.length}개 표시 · 전체 지출액 ${fmt(wOut)}원</span>`
    : ''}</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${B};border-radius:6px;overflow:hidden">
    <tr><th style="${THS}left">날짜</th><th style="${THS}left">중분류</th><th style="${THS}left">대분류</th><th style="${THS}right">금액</th></tr>
    ${outHtml}
  </table>
</td></tr>

<!-- 🏢 대분류별 주간 현황 (전체 행 표시) -->
<tr><td style="background:${C.card};padding:18px 18px 0">
  <div style="font-size:13px;font-weight:600;color:${C.text};margin-bottom:8px">🏢 대분류별 주간 현황${bigCatRows.length > 0 ? ` <span style="font-size:11px;font-weight:400;color:${C.t2}">총 ${bigCatRows.length}개 대분류</span>` : ''}</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${B};border-radius:6px;overflow:hidden">
    <tr><th style="${THS}left">대분류</th><th style="${THS}right">입금</th><th style="${THS}right">지출</th></tr>
    ${bigCatHtml}
  </table>
</td></tr>

<!-- 📊 매출채권 요약 -->
<tr><td style="background:${C.card};padding:18px 18px 0">
  <div style="font-size:13px;font-weight:600;color:${C.text};margin-bottom:10px">📊 매출채권 요약</div>
  <table width="100%" cellpadding="0" cellspacing="0"><tr>
    ${(
      [
        ['주간 신규',   fmt(wNewAmt),  C.text,  `${wNewAR.length}건`],
        ['주간 회수',   fmt(wColAmt),  C.green, `${wColCF.length}건`],
        ['전체 미회수', fmt(remTotal), C.amber, arBalanceSub],
        ['지연',        fmt(dlyAmt),   C.red,   dlySub],
      ] as [string, string, string, string][]
    ).map(([l, v, co, s]) =>
      `<td width="25%" style="padding:0 5px;vertical-align:top"><div style="background:${C.bg3};border-radius:8px;padding:12px 10px;text-align:center;min-height:120px;box-sizing:border-box">` +
      `<div style="font-size:10px;color:${C.t2};margin-bottom:5px">${l}</div>` +
      `<div style="font-size:16px;font-weight:700;color:${co};font-family:monospace;margin-bottom:3px">${v}</div>` +
      `<div style="font-size:10px;color:${co};line-height:1.45;word-break:keep-all;overflow-wrap:anywhere">${s}</div>` +
      `</div></td>`
    ).join('')}
  </tr></table>
</td></tr>

<!-- 푸터 -->
<tr><td style="background:${C.bg3};border-radius:0 0 12px 12px;padding:14px 18px;text-align:center">
  <div style="font-size:11px;color:${C.t3}">RAWGA 자금 대시보드 · 자동 발송 리포트 · ${sentAt}</div>
</td></tr>

</table></td></tr></table>
</body></html>`;

  return { html, subject, weekKey: wStart, startDate: wStart, endDate: wEnd };
}

/* ── 메인 핸들러 ──────────────────────────────────────────────────────── */
serve(async (req: Request) => {

  /* CORS preflight */
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  /* ① 필수 Supabase 환경변수 확인 */
  if (!SUPABASE_URL_RAW || !SUPABASE_SERVICE_ROLE_KEY_RAW) {
    return json({ error: 'Server configuration error: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set' }, 500);
  }

  /* ② body 파싱 */
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const sendType:          string          = (body.send_type          as string)   || 'auto';
  const dryRun:            boolean         = !!body.dry_run;
  const recipientOverride: string[] | null = (body.recipient_override as string[]) || null;

  const isActualAutoSend = sendType === 'auto' && !dryRun;

  /* ③ 인증 ─────────────────────────────────────────────────────────────
   *  [auto + !dry_run] 외부 cron 전용  → X-Cron-Secret === CRON_SECRET
   *  [auto + dry_run / test / manual]  프론트엔드 → PUBLISHABLE_KEY 검증
   *
   *  보안 원칙:
   *  - CRON_SECRET / GMAIL_APP_PASSWORD / SUPABASE_SERVICE_ROLE_KEY 는 프론트엔드 미노출
   *  - PUBLISHABLE_KEY 는 sb_publishable_* (앱 HTML에 이미 공개된 값)
   *  - PUBLISHABLE_KEY 미설정 시 fallback 없이 명확한 설정 오류 반환
   * ────────────────────────────────────────────────────────────────── */
  if (isActualAutoSend) {
    // auto 실발송: CRON_SECRET 설정 확인 후 헤더 비교
    if (!CRON_SECRET) {
      return json({ error: 'Server configuration error: CRON_SECRET is not set' }, 500);
    }
    const cronHeader = req.headers.get('x-cron-secret') || '';
    if (cronHeader !== CRON_SECRET) {
      return json({ error: 'Unauthorized' }, 401);
    }
  } else {
    // dry_run / test / manual: PUBLISHABLE_KEY 설정 확인 후 Bearer/apikey 헤더 비교
    if (!PUBLISHABLE_KEY) {
      return json({
        error: 'Server configuration error: APP_PUBLISHABLE_KEY is not set. ' +
               'Add it to Edge Function Secrets (value = sb_publishable_* from your app).',
      }, 500);
    }
    const authHeader   = req.headers.get('authorization') || '';
    const apikeyHeader = req.headers.get('apikey')        || '';
    const bearerToken  = authHeader.replace(/^Bearer\s+/i, '');
    if (bearerToken !== PUBLISHABLE_KEY && apikeyHeader !== PUBLISHABLE_KEY) {
      return json({ error: 'Unauthorized' }, 401);
    }
  }

  /* ④ Supabase 클라이언트 (service_role) */
  const supa = createClient(SUPABASE_URL_RAW, SUPABASE_SERVICE_ROLE_KEY_RAW);

  /* ⑤ targetDate 결정
   *
   *  우선순위:
   *  1) body.target_date        — 모든 발송 타입에서 최우선 (명시적 지정)
   *  2) sendType === 'auto'     — cat_data.report_base_date 를 읽지 않고 todaySeoul()
   *                               앱에서 과거 주차를 조회해 저장된 값에 영향받지 않도록 분리
   *  3) sendType !== 'auto'     — cat_data.report_base_date → todaySeoul() fallback
   *                               (수동·테스트·Dry-run: 사용자가 선택한 기준일 반영)
   */
  let targetDate = (body.target_date as string) || '';

  if (targetDate && !isValidDateStr(targetDate)) {
    return json({ error: `Invalid target_date format: "${targetDate}". Expected YYYY-MM-DD.` }, 400);
  }

  if (!targetDate) {
    if (sendType === 'auto') {
      // 자동 발송: 항상 오늘(Asia/Seoul) 기준
      // → cat_data.report_base_date 를 읽지 않음
      //   (사용자가 앱에서 과거 주차를 조회해 둔 값이 남아 있어도 무시)
      targetDate = todaySeoul();
    } else {
      // 수동·테스트·Dry-run: 사용자가 저장한 보고기준일 우선 사용
      const { data: baseDateRow } = await supa
        .from('cat_data').select('data').eq('key', 'report_base_date').single();
      const baseDate = (baseDateRow?.data as string) || '';
      if (baseDate && isValidDateStr(baseDate)) {
        targetDate = baseDate;
      } else {
        // 최종 fallback: 오늘 (Asia/Seoul 기준)
        targetDate = todaySeoul();
      }
    }
  }

  /* ⑥ 이메일 설정 조회 */
  const { data: settingsRow } = await supa
    .from('cat_data').select('data').eq('key', 'weekly_email_settings').single();
  const emailSettings = (settingsRow?.data as Record<string, unknown>) || {};
  let   recipients: string[] = recipientOverride
    || (emailSettings.recipients as string[])
    || [];

  // test 발송은 첫 번째 수신자만
  if (sendType === 'test' && !recipientOverride) {
    recipients = ((emailSettings.recipients as string[]) || []).slice(0, 1);
  }
  if (!dryRun && recipients.length === 0) {
    return json({ error: 'No recipients configured. Add recipients in email settings.' }, 400);
  }

  /* ⑦ 데이터 조회 (cf_data / ar_data / cat_data.settings) */
  const [cfRes, arRes, initRes, snapRes, fxBaseRes, dlRes] = await Promise.all([
    supa.from('cf_data').select('data').limit(1).single(),
    supa.from('ar_data').select('data').limit(1).single(),
    supa.from('cat_data').select('data').eq('key', 'settings').single(),
    supa.from('cat_data').select('data').eq('key', 'bank_snapshot').single(),
    supa.from('cat_data').select('data').eq('key', 'fx_adjust_base').single(),
    /* 안전선 — 궤적 블록이 '몇 일 하회' 를 말하려면 필요하다. 대시보드·일간 리포트와
       같은 설정을 쓴다(cat_data.daily_settings.floor). 없으면 15억(앱 기본값). */
    supa.from('cat_data').select('data').eq('key', 'daily_settings').single(),
  ]);

  if (cfRes.error) {
    return json({ error: `Failed to load cf_data: ${cfRes.error.message}` }, 500);
  }
  if (arRes.error) {
    return json({ error: `Failed to load ar_data: ${arRes.error.message}` }, 500);
  }

  let cfArr: Record<string, unknown>[];
  let arArr: Record<string, unknown>[];
  try {
    cfArr = Array.isArray(cfRes.data?.data)         ? cfRes.data!.data
          : typeof cfRes.data?.data === 'string'    ? JSON.parse(cfRes.data!.data) : [];
    arArr = Array.isArray(arRes.data?.data)         ? arRes.data!.data
          : typeof arRes.data?.data === 'string'    ? JSON.parse(arRes.data!.data) : [];
  } catch (e: unknown) {
    return json({ error: `Failed to parse data: ${(e as Error).message}` }, 500);
  }

  // status 공백·비표준값 / date HH:mm:ss 잔재 / in·out 문자열 타입 정규화
  // Supabase 원본을 수정하지 않고 계산용 배열만 정규화
  cfArr = cfArr.map(normalizeCFRowServer);

  // INIT_CASH: cat_data.settings.init_cash → 기본값 134838617 (앱과 동일)
  const initCashRaw = Number(
    (initRes.data?.data as Record<string, unknown>)?.init_cash ?? 134838617,
  );

  /* 외화 환산손익 — 대시보드(index.html computeFxAdj)와 같은 정의를 서버에서도 계산한다.
   * cf_data 는 외화를 '거래일 환율'로 원화 환산해 기록하는데 은행 실잔액의 외화는
   * '현재 평가환율' 기준이라, 반영하지 않으면 리포트의 현금이 실제와 어긋난다.
   *   환산손익 = 외화 실잔액(평가) − ( fx_adjust_base.pre_krw + Σ fx_usd 행의 in−out )
   * ⚠ 대시보드와 정의가 갈리면 리포트와 화면 숫자가 달라진다. 한쪽만 고치지 말 것. */
  const snap = snapRes.data?.data as Record<string, unknown> | undefined;
  let fxAdj = 0;
  if (snap) {
    const spot = Number(snap.fxKrw) || 0;
    let book = Number((fxBaseRes.data?.data as Record<string, unknown>)?.pre_krw) || 0;
    for (const r of cfArr) {
      if ((r as Record<string, unknown>).fx_usd) {
        book += (Number((r as Record<string, unknown>).in) || 0) - (Number((r as Record<string, unknown>).out) || 0);
      }
    }
    fxAdj = Math.round(spot - book);
  }
  const initCash = initCashRaw + fxAdj;
  const dlFloor = Number((dlRes.data?.data as Record<string, unknown>)?.floor) || 1500000000;

  /* ⑧ 주간 요약 — body 우선 → Supabase fallback
   *
   *  우선순위:
   *  ① request body.weekly_summary (즉시/테스트 발송 시 프론트엔드가 localStorage 값을 전달)
   *  ② Supabase cat_data 조회 (자동 발송 또는 body에 없을 때)
   *  ③ 모두 없으면 빈 문자열 + 안내문 표시 */
  const { wStart: _wkSumStart } = getWeekRange(targetDate);
  const summaryKey = `weekly_summary_${_wkSumStart}`;
  let weeklySummary: { summary: string; updated_at: string | null } = { summary: '', updated_at: null };
  let summarySrc: 'request_body' | 'supabase' | 'fallback' = 'fallback';

  // ① request body 확인 + 진단 로그
  const rawBodyWS = (body as Record<string, unknown>).weekly_summary;
  const bodyWS = rawBodyWS as Record<string, unknown> | undefined;
  console.log('[weekly-summary:edge-body]', {
    function_version: FUNCTION_VERSION,
    summaryKey,
    targetDate,
    bodyWeeklySummaryType: typeof rawBodyWS,
    bodyWeeklySummaryExists: rawBodyWS !== undefined && rawBodyWS !== null,
    bodyWeeklySummaryIsObject: rawBodyWS !== null && typeof rawBodyWS === 'object',
    rawBodyWSPreview: rawBodyWS !== null && typeof rawBodyWS === 'object'
      ? JSON.stringify(rawBodyWS).slice(0, 120)
      : typeof rawBodyWS === 'string' ? rawBodyWS.slice(0, 120) : String(rawBodyWS ?? ''),
  });

  if (bodyWS !== undefined && bodyWS !== null && typeof bodyWS === 'object') {
    const parsed = parseWeeklySummary(bodyWS);
    if (parsed.summary) { weeklySummary = parsed; summarySrc = 'request_body'; }
  }

  // ② Supabase fallback (body에 없거나 비어 있는 경우)
  if (!weeklySummary.summary) {
    try {
      const { data: sumRow, error: sumErr } = await supa
        .from('cat_data').select('key, data').eq('key', summaryKey).maybeSingle();
      // ── 진단 로그: Supabase 조회 결과
      console.log('[weekly-summary:edge-supabase]', {
        summaryKey,
        found: !!sumRow,
        error: sumErr ? sumErr.message : null,
        dataType: typeof sumRow?.data,
        dataPreview: sumRow?.data !== undefined
          ? (typeof sumRow.data === 'string'
              ? sumRow.data.slice(0, 120)
              : JSON.stringify(sumRow.data).slice(0, 120))
          : null,
        summaryInData: sumRow?.data?.summary?.slice(0, 30) ?? null,
        updatedAtInData: sumRow?.data?.updated_at ?? null,
      });
      if (sumErr) {
        console.warn('[⑧] weekly summary Supabase 조회 실패:', { summaryKey, message: sumErr.message });
      } else if (sumRow) {
        const sbParsed = parseWeeklySummary(sumRow.data);
        if (sbParsed.summary) { weeklySummary = sbParsed; summarySrc = 'supabase'; }
      }
    } catch (e) { console.warn('[⑧] weekly summary 예외 (발송 계속):', e); }
  }

  console.log('[⑧] weekly summary resolved:', {
    function_version: FUNCTION_VERSION,
    summaryKey, source: summarySrc,
    found: Boolean(weeklySummary.summary),
    summary_length: weeklySummary.summary.length,
    updated_at_exists: Boolean(weeklySummary.updated_at),
  });

  /* ⑨ 리포트 생성 */
  // ── 진단 로그: buildWeeklyReportHTML 직전
  console.log('[weekly-summary:before-html]', {
    function_version: FUNCTION_VERSION,
    targetDate,
    summaryKey,
    source: summarySrc,
    summaryLength: weeklySummary.summary.length,
    summaryPreview: weeklySummary.summary.slice(0, 30),
    updatedAt: weeklySummary.updated_at,
  });
  const { html, subject, weekKey, startDate, endDate } =
    buildWeeklyReportHTML(targetDate, cfArr, arArr, initCash, DASHBOARD_URL, weeklySummary, dlFloor);

  /* ⑨ Dry-run: 전송 없음, email_log 기록 없음 — 메타데이터만 반환 */
  if (dryRun) {
    // dashboard_url_exists   : DASHBOARD_URL Secret 등록 여부 (URL 값 비노출)
    // deeplink_hash          : 이메일 링크에 삽입되는 딥링크 해시 (고정값)
    const dashboardUrlExists = /^https?:\/\/.+/i.test(DASHBOARD_URL);
    return json({
      function_version:     FUNCTION_VERSION,
      subject,
      recipients,
      html_byte_size:       new TextEncoder().encode(html).length,
      week_key:             weekKey,
      target_date:          targetDate,
      report_start_date:    startDate,
      report_end_date:      endDate,
      dashboard_url_exists: dashboardUrlExists,
      deeplink_hash:        '#reporting-weekly',
      // 주간 요약 진단 정보 (요약 본문 비노출)
      weekly_summary_debug: {
        function_version:  FUNCTION_VERSION,
        target_date:       targetDate,
        week_key:          weekKey,
        summary_key:       summaryKey,
        source:            summarySrc,
        found:             Boolean(weeklySummary.summary),
        summary_length:    weeklySummary.summary.length,
        updated_at_exists: Boolean(weeklySummary.updated_at),
      },
    });
  }

  /* ⑩ Gmail SMTP 자격증명 확인 (실제 발송에서만) */
  if (!GMAIL_USER_RAW || !GMAIL_APP_PASSWORD_RAW) {
    return json({
      error: 'Server configuration error: GMAIL_USER or GMAIL_APP_PASSWORD is not configured.',
    }, 500);
  }

  /* ⑪ auto 중복 발송 방지
   *  같은 week_key에 send_type=auto, status=sent 기록이 있으면 건너뜀 */
  if (sendType === 'auto') {
    const { data: existing, error: dedupErr } = await supa
      .from('email_log')
      .select('id')
      .eq('report_type', 'weekly')
      .eq('week_key', weekKey)
      .eq('send_type', 'auto')
      .eq('status', 'sent')
      .limit(1);
    if (!dedupErr && existing && existing.length > 0) {
      return json({ skipped: true, reason: 'already_sent', week_key: weekKey });
    }
  }

  /* ⑫ email_log INSERT (pending) */
  const now = new Date().toISOString();
  const { data: logRow, error: logInsertErr } = await supa
    .from('email_log')
    .insert({
      report_type:        'weekly',
      send_type:          sendType,
      week_key:           weekKey,
      report_start_date:  startDate,
      report_end_date:    endDate,
      target_date:        targetDate,
      recipients,
      scheduled_at:       now,
      status:             'pending',
    })
    .select('id')
    .single();

  // insert 실패 시 발송은 계속 진행하되 응답에 경고 포함
  const logId          = logRow?.id as string | undefined;
  const logInsertWarn  = logInsertErr
    ? `email_log insert failed: ${logInsertErr.message}`
    : undefined;

  /* ⑬ Gmail SMTP 발송 (nodemailer) */
  let sendStatus:   'sent' | 'failed' = 'sent';
  let errorMessage: string | null     = null;
  let sentAt:       string | null     = null;

  try {
    const transporter = nodemailer.createTransport({
      host:   'smtp.gmail.com',
      port:   587,
      secure: false,          // STARTTLS (포트 587)
      auth: {
        user: GMAIL_USER_RAW,
        pass: GMAIL_APP_PASSWORD_RAW,
      },
    });

    await transporter.sendMail({
      from:    `"RAWGA 리포트" <${GMAIL_USER_RAW}>`,
      to:      recipients,
      subject,
      html,
    });

    sentAt = new Date().toISOString();
  } catch (e: unknown) {
    sendStatus   = 'failed';
    errorMessage = (e as Error).message || String(e);
  }

  /* ⑭ email_log 업데이트 */
  if (logId) {
    await supa
      .from('email_log')
      .update({ status: sendStatus, error_message: errorMessage, sent_at: sentAt })
      .eq('id', logId);
  }

  /* ⑮ 결과 반환 */
  if (sendStatus === 'failed') {
    return json(
      {
        function_version: FUNCTION_VERSION,
        error:        errorMessage,
        log_warning:  logInsertWarn,
      },
      500,
    );
  }

  return json({
    function_version: FUNCTION_VERSION,
    success:      true,
    recipients,
    subject,
    week_key:     weekKey,
    log_warning:  logInsertWarn,   // email_log insert 실패 경고 (발송은 성공)
  });
});

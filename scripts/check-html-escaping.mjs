#!/usr/bin/env node
/**
 * check-html-escaping.mjs — 이스케이프 안 된 사용자 데이터가 HTML 에 들어가는 곳을 찾는다.
 *
 * 왜: 2026-08-17 입출금 표 거래내용(desc)에서 저장형 XSS 가 나왔다. escapeHtml() 은
 * 이미 있었지만 40여 곳에서 빠져 있었다. cf_data 는 모든 사용자에게 공유되고 은행 적요는
 * 우리가 통제하지 못하는 값이라, "다음에 표를 추가할 때 또 빠뜨리는 것"이 진짜 위험이다.
 * 사람 기억 대신 이 스크립트가 잡는다.
 *
 * 무엇을 보는가:
 *   HTML 을 담은 템플릿 리터럴 안의 ${...} 중,
 *     · 알려진 데이터 필드(desc·mid_cat·partner·merchant …)를 참조하고
 *     · escapeHtml() 류로 감싸지 않았고
 *     · 감싸는 템플릿이 html`` 태그드 템플릿이 아닌 것
 *   을 위반으로 보고한다. html`` 안이면 자동 이스케이프되므로 통과시킨다.
 *
 * 실행:
 *   node scripts/check-html-escaping.mjs           # 위반 있으면 exit 1
 *   node scripts/check-html-escaping.mjs --audit   # raw() 사용처까지 같이 출력
 *
 * 한계(정직하게):
 *   · 정규식이 아니라 문자 단위 스캐너지만, JS 정규식 리터럴은 파싱하지 않는다.
 *     백틱이 든 정규식이 있으면 오탐이 날 수 있다(현재 대상 파일엔 없음).
 *   · 필드 목록 기반이라 새 필드명은 DATA_FIELDS 에 추가해야 잡힌다.
 *   · innerHTML 이 아닌 경로(setAttribute 등)는 보지 않는다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  'index.html',
  'supabase/functions/send-weekly-report/index.ts',
];

/** 사용자가 값을 넣을 수 있는 필드 — 새 필드가 생기면 여기에 추가한다 */
const DATA_FIELDS = [
  'desc', 'memo', 'mid_cat', 'big_cat', 'partner', 'merchant', 'note',
  'card_no', 'card_alias', 'error_message', 'status', 'type', 'cat',
  'use_date', 'due_date', 'collect_date', 'start', 'date',
  'purpose', 'risk', 'label', 'rawVal', 'summary', 'recipients', 'expected',
];

/** 이미 안전하게 감싼 것으로 인정하는 호출 */
const ESCAPERS = ['escapeHtml', 'esc', '_acEsc', 'safeText', 'raw', 'fmt', 'Number', 'dlWon', 'chkWon'];

const fieldRe = new RegExp(`\\.\\s*(?:${DATA_FIELDS.join('|')})\\b`, 'g');

/**
 * 위반 판정 — "가공 없이 그대로 꽂힌 데이터 필드"만 잡는다.
 *
 * 이 좁힘은 의도적이다. 처음엔 필드가 등장하기만 하면 잡았더니 36건이 나왔는데
 * 대부분 ${dayLabel(r.date)}·${safeDesc}·${cond ? 'a' : 'b'} 같은 오탐이었다.
 * 오탐이 많은 검사는 그냥 무시당하고, 그러면 진짜 위반이 그 속에 묻힌다.
 * 실제 사고(${r.desc})의 모양 — 함수도 안 거치고 조건도 아닌 직접 삽입 — 에 맞춘다.
 */
function isViolation(expr) {
  // 1) 함수를 거치면 그 함수 책임 (escapeHtml·fmt·dayLabel·statusBadge …)
  if (expr.includes('(')) return false;

  // 2) 삼항의 "조건"에만 등장하면 출력물이 아니다:
  //    ${r.collect_date ? 'var(--green)' : 'var(--text3)'} → 출력은 색상 리터럴
  const q = topLevelIndex(expr, '?');
  if (q >= 0) {
    const cond = expr.slice(0, q);
    const branches = expr.slice(q + 1);
    fieldRe.lastIndex = 0;
    if (!fieldRe.test(branches)) return false;   // 조건부에만 등장 → 안전
  }

  fieldRe.lastIndex = 0;
  return fieldRe.test(expr);
}

/** 괄호·대괄호 밖(깊이 0)에 있는 첫 ch 위치 — 삼항 판별용 */
function topLevelIndex(s, ch) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

/**
 * 문자 단위 스캐너. 주석·문자열·템플릿 리터럴 상태를 추적하면서
 * 템플릿 안의 ${...} 를 모아 반환한다.
 */
/** `/` 가 정규식 리터럴의 시작인지(나눗셈이 아니라) 판단 — 앞 토큰으로 결정 */
const REGEX_PREV_CHARS = /[(,=:[!&|?{};+\-*%~^<>\n]/;
const REGEX_PREV_WORDS = /\b(?:return|typeof|instanceof|case|in|of|delete|void|new|do|else|yield|await)$/;

function scanTemplates(src) {
  const templates = [];   // {tagged, htmlish, exprs:[{text,line}]}
  const stack = [];       // 템플릿/표현식 컨텍스트
  let line = 1;
  const N = src.length;
  let prevSig = '';       // 코드 영역에서 마지막으로 본 의미 있는 문자
  let prevIdx = -1;       // 그 위치(앞 단어 검사용)

  const curTpl = () => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k].kind === 'tpl') return stack[k];
    return null;
  };
  const inExpr = () => stack.length && stack[stack.length - 1].kind === 'expr';

  for (let i = 0; i < N; i++) {
    const c = src[i], c2 = src[i + 1];
    if (c === '\n') { line++; continue; }

    const tpl = curTpl();
    const inTplLiteral = tpl && !inExpr();

    // 템플릿 리터럴 본문(문자 영역) 안에서는 ` 와 ${ 만 의미가 있다
    if (inTplLiteral) {
      if (c === '\\') { i++; continue; }
      if (c === '`') { const t = stack.pop(); templates.push(t); continue; }
      if (c === '$' && c2 === '{') {
        stack.push({ kind: 'expr', depth: 0, start: i + 2, line });
        i++; continue;
      }
      tpl.literal += c;
      continue;
    }

    // ── 코드 영역(템플릿 밖 또는 ${} 안) ──
    if (/\s/.test(c)) continue;

    if (c === '/' && c2 === '/') { while (i < N && src[i] !== '\n') i++; line++; continue; }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < N && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i++; continue;
    }
    // 정규식 리터럴 — 이걸 건너뛰지 않으면 /"/g 같은 패턴이 문자열 시작으로 오인돼
    // 스캐너 전체가 어긋난다(실제로 겪음: .ts 템플릿을 하나도 못 찾았다).
    if (c === '/') {
      const before = src.slice(Math.max(0, prevIdx - 12), prevIdx + 1);
      if (prevIdx < 0 || REGEX_PREV_CHARS.test(prevSig) || REGEX_PREV_WORDS.test(before)) {
        i++;
        let inClass = false;
        while (i < N) {
          const ch = src[i];
          if (ch === '\\') i++;
          else if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) break;
          else if (ch === '\n') { line++; break; }
          i++;
        }
        prevSig = '/'; prevIdx = i;
        continue;
      }
    }
    if (c === "'" || c === '"') {
      const q = c; i++;
      while (i < N && src[i] !== q) { if (src[i] === '\\') i++; else if (src[i] === '\n') line++; i++; }
      prevSig = q; prevIdx = i;
      continue;
    }
    if (c === '`') {
      // 백틱 앞의 식별자를 보고 태그드 여부 판단
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j])) j--;
      let end = j + 1, st = end;
      while (st > 0 && /[A-Za-z0-9_$.]/.test(src[st - 1])) st--;
      const tag = src.slice(st, end);
      stack.push({ kind: 'tpl', tagged: tag === 'html', literal: '', exprs: [], line });
      prevSig = '`'; prevIdx = i;
      continue;
    }
    if (inExpr()) {
      const e = stack[stack.length - 1];
      if (c === '{') e.depth++;
      else if (c === '}') {
        if (e.depth === 0) {
          stack.pop();
          const t = curTpl();
          if (t) t.exprs.push({ text: src.slice(e.start, i), line: e.line });
          prevSig = '}'; prevIdx = i;
          continue;
        }
        e.depth--;
      }
    }
    prevSig = c; prevIdx = i;
  }
  return templates;
}

function check(file) {
  const abs = path.resolve(ROOT, file);   // 절대경로 인자도 그대로 처리
  const src = fs.readFileSync(abs, 'utf8');
  const templates = scanTemplates(src);
  const violations = [];

  for (const t of templates) {
    if (t.tagged) continue;                        // html`` → 자동 이스케이프
    if (!/<\/?[a-zA-Z]/.test(t.literal)) continue; // HTML 이 아닌 템플릿(로그·키 조립 등)은 대상 아님
    for (const e of t.exprs) {
      const txt = e.text.replace(/\s+/g, ' ').trim();
      if (!isViolation(txt)) continue;
      violations.push({ line: e.line, expr: txt.slice(0, 90) });
    }
  }
  return { file, violations, templates };
}

const audit = process.argv.includes('--audit');
const argFiles = process.argv.slice(2).filter(a => !a.startsWith('--'));
const files = argFiles.length ? argFiles : TARGETS;   // 인자로 특정 파일만 검사 가능
let total = 0;

for (const f of files) {
  const { file, violations, templates } = check(f);
  // 마크업을 담은 템플릿만 모수로 잡는다(로그·키 조립용 템플릿은 제외).
  // 태그드 비율은 "구조적 방어가 어디까지 퍼졌는가"를 보는 지표다.
  const markup = templates.filter(t => /<\/?[a-zA-Z]/.test(t.literal));
  const tagged = markup.filter(t => t.tagged).length;
  const pct = markup.length ? Math.round((tagged / markup.length) * 100) : 0;

  console.log(`\n■ ${file}`);
  console.log(`  마크업 템플릿 ${markup.length}개 · html\`\` 적용 ${tagged}개 (${pct}%)`);

  if (violations.length === 0) {
    console.log('  ✅ 이스케이프 누락 없음');
  } else {
    total += violations.length;
    console.log(`  ❌ 이스케이프 누락 ${violations.length}건`);
    for (const v of violations) console.log(`     ${file}:${v.line}  \${${v.expr}}`);
  }

  if (audit) {
    const raws = [...src_lines(path.resolve(ROOT, f))].filter(l => /\braw\s*\(/.test(l.text));
    if (raws.length) {
      console.log(`  ⚠ raw() 사용 ${raws.length}건 — 신뢰할 수 있는 값인지 확인할 것`);
      for (const l of raws) console.log(`     ${f}:${l.n}  ${l.text.trim().slice(0, 90)}`);
    }
  }
}

function* src_lines(abs) {
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) yield { n: i + 1, text: lines[i] };
}

if (total > 0) {
  console.log(`\n총 ${total}건 — 고치는 법: 해당 템플릿을 html\`\` 로 바꾸거나 \${escapeHtml(값)} 으로 감쌀 것.\n`);
  process.exit(1);
}
console.log('\n전부 통과.\n');

#!/usr/bin/env node
/**
 * find-recurring-candidates.mjs — 월간 반복되는 정기결제·고정비 후보를 찾는다.
 *
 * ⚠⚠ 이 스크립트가 존재하는 이유가 되는 두 가지 사고를 먼저 읽을 것.
 *
 * ① 거래처명이 잘려 그룹이 쪼개진다 (2026-09-18)
 *    은행 적요는 길이를 제각각 잘라 보낸다. 스파크플러스가 '스파크플러스' /
 *    '주식회사스파크플러' / '주식회사스파크' 세 그룹으로 갈려 **8개월 연속인 걸 3개월로**
 *    잘못 봤다. 법인 접두어를 털고 **앞 3글자**로 묶어야 잡힌다.
 *    2026-08-24 판관비 분석이 충북테크노관리비(9개월 전부 발생)를 통째로 놓친 것도 이 탓이다.
 *
 * ② 기존 예정 행을 안 보고 등록하면 이중계상된다 (2026-09-18)
 *    스파크플러스 임차료를 반복거래로 등록했는데, 이미 수기로 입력된 예정 행
 *    ('스파크플러스(임대료)_208~210호'·'_206호')이 있었다. 2027-06 까지 10건
 *    125,345,000원이 이중으로 잡혔다. 그래서 이 스크립트는 후보마다 **이미 예정 행이
 *    있는지**를 같이 찍는다. '예정있음' 이 뜬 후보는 등록하면 안 된다.
 *
 * 제외 대상 (사용자 확인 2026-08-24 / 09-18)
 *   · 인오가닉·세종시·라오스  — 건별 딜이라 반복 아님. 세종은 수기 반영
 *   · 금융비용(대출이자)      — generateLoanPlanned 가 이미 만든다
 *   · 판매관리비/법인카드 대금 — generateCardPlanned 가 이미 만든다
 *   · 자금이동·자금거래       — 계좌간 이체·대여금
 *   · 이미 등록된 반복거래     — recur_data 에서 읽어 자동 제외
 *
 * 알려진 공백 — 이상 신호가 아니다
 *   · 2026-06 4대보험 0원 : **5월에 선납했다**(2026-09-18 대표님 확인). 5월이 3,005만으로
 *     평월 2,000만의 1.5배인 게 그 때문이다. 적재 누락이 아니므로 다시 파지 말 것.
 *   · 2026-01~03 4대보험 없음 : 4월부터 납부가 시작됐다.
 *
 * 쓰는 법: node scripts/find-recurring-candidates.mjs [--min-months 4]
 */
import { readFileSync } from 'node:fs';

const PK = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const EP = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
const secret = readFileSync('C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret', 'utf8').trim();
const argv = process.argv.slice(2);
const MIN_MONTHS = Number((argv[argv.indexOf('--min-months') + 1]) || 4);

const post = async (b) => { for (let i = 1; i <= 3; i++) { try {
  const r = await fetch(EP, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: PK, Authorization: `Bearer ${PK}` }, body: JSON.stringify({ secret, ...b }) });
  const t = await r.text(); if (!t.trim().startsWith('{')) throw new Error(`HTTP ${r.status}`); return JSON.parse(t);
} catch (e) { if (i === 3) throw e; await new Promise(s => setTimeout(s, 700 * i)); } } };

const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const won = v => Math.round(v).toLocaleString('ko-KR');
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const mad = (a, m) => med(a.map(v => Math.abs(v - m)));

/* 월별로 나눠 받는다 — inspect 는 한 번에 500건에서 잘린다 */
const rows = [];
let meta = null;
for (let m = 1; m <= 12; m++) {
  const r = await post({ inspect: { from: `2026-${String(m).padStart(2, '0')}-01`,
                                   to: `2026-${String(m).padStart(2, '0')}-${lastDay(2026, m)}`,
                                   ...(meta ? {} : { meta: ['recur_data'] }) } });
  if (!meta && r.meta) meta = r.meta;
  if (r.matched > 500) console.warn(`⚠ 2026-${String(m).padStart(2, '0')} ${r.matched}건 — 500 에서 잘림`);
  rows.push(...(r.rows || []));
}
const TODAY = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const registered = (meta?.recur_data || []);

/* ⚠ 3글자로 묶는다. 위 ① 참고 — 더 길게 자르면 같은 거래처가 갈린다. */
const BANK = /^(기업|신한|국민|하나|농협|우리|KB|IBK|SC|씨티|카카오|토스)/;
const key = (t) => {
  let s = String(t || '').replace(/[\s\u3000]+/g, '');
  for (let i = 0; i < 2; i++) s = s.replace(BANK, '');
  s = s.replace(/주식회사|유한회사|㈜|\(주\)|주\)|\(유\)/g, '');
  s = s.replace(/[0-9０-９]+/g, '').replace(/\(.*?\)/g, '');
  return s.slice(0, 3);
};

const EXCL_BIG = new Set(['인오가닉', '세종시', '라오스', '자금이동', '자금거래', '금융비용']);
const EXCL_MID = new Set(['법인카드 대금', '이자비용', '보증료']);
const regKeys = new Set(registered.map(r => key(r.desc)));

const actual = rows.filter(r => r.status === '실제 지출' && r.date && r.date <= TODAY
  && !EXCL_BIG.has(r.big_cat || '') && !EXCL_MID.has(r.mid_cat || ''));
/* 기존 예정 행 — 후보가 이미 커버되는지 보려고 따로 모은다(위 ② 참고) */
const planned = rows.filter(r => (r.status === '지출 예정' || r.status === '입금 예정') && r.date >= TODAY);
const plannedKeys = new Map();
for (const p of planned) {
  const k = key(p.desc);
  const e = plannedKeys.get(k) || { n: 0, amt: 0, sample: '' };
  e.n++; e.amt += (p.out || 0); e.sample = e.sample || String(p.desc || '');
  plannedKeys.set(k, e);
}

const months = [...new Set(actual.map(r => r.date.slice(0, 7)))].sort();
const recent3 = [0, 1, 2].map(i => { const [y, m] = TODAY.split('-').map(Number); let mm = m - i, yy = y;
  while (mm < 1) { mm += 12; yy--; } return `${yy}-${String(mm).padStart(2, '0')}`; });

const g = {};
for (const r of actual) { const k = key(r.desc); if (!k) continue; (g[k] = g[k] || []).push(r); }

const out = [];
for (const [k, list] of Object.entries(g)) {
  const mos = [...new Set(list.map(r => r.date.slice(0, 7)))].sort();
  if (mos.length < MIN_MONTHS) continue;
  const alive = recent3.filter(m => mos.includes(m)).length;
  if (alive < 2) continue;
  /* 월별 합계로 본다 — 한 달에 여러 번 나눠 내는 거래처가 있다 */
  const per = months.map(m => list.filter(r => r.date.slice(0, 7) === m).reduce((s, r) => s + (r.out || 0), 0));
  const live = per.filter(v => v > 0);
  const aM = med(live), cv = aM ? mad(live, aM) / aM : 1;
  const days = list.map(r => Number(r.date.slice(8, 10)));
  const dM = med(days), dmad = mad(days, dM);
  const names = [...new Set(list.map(r => String(r.desc || '').slice(0, 16)))];
  const mids = [...new Set(list.map(r => r.mid_cat || '-'))];
  const grade = (cv <= 0.15 && dmad <= 4) ? 'A' : (cv <= 0.45 && dmad <= 8) ? 'B' : 'C';
  out.push({ k, names, mids, mo: mos.length, alive, amt: aM, cv, day: dM, dmad, per, grade,
             perMonth: list.reduce((s, r) => s + (r.out || 0), 0) / months.length,
             already: regKeys.has(k), plan: plannedKeys.get(k) || null });
}
out.sort((a, b) => (a.grade < b.grade ? -1 : a.grade > b.grade ? 1 : 0) || b.amt - a.amt);

console.log(`2026 실제 지출 ${actual.length}건 · ${months.length}개월 (${months[0]} ~ ${months.at(-1)})`);
console.log(`이미 등록된 반복거래 ${registered.length}건 · 미래 예정 행 ${planned.length}건`);
console.log(`그룹 기준: 법인접두어 제거 + 앞 3글자 / 최소 ${MIN_MONTHS}개월 + 최근 3개월 중 2개월 이상\n`);
console.log('등급 결제일 월중앙금액      변동 월수 상태        중분류        거래처');
for (const r of out) {
  const st = r.already ? '등록됨' : r.plan ? `예정있음(${r.plan.n})` : '후보';
  console.log(` ${r.grade}   ${String(r.day).padStart(2)}일 ${won(r.amt).padStart(12)} ${(r.cv * 100).toFixed(0).padStart(4)}% ${String(r.mo).padStart(3)} ${st.padEnd(11)} ${r.mids.join(',').slice(0, 12).padEnd(13)} ${r.names[0]}`);
}

const fresh = out.filter(r => !r.already && !r.plan && r.grade !== 'C');
console.log(`\n=== 새로 등록할 만한 것 (등록됨·예정있음·C등급 제외) : ${fresh.length}건 ===`);
if (!fresh.length) console.log('  없음');
for (const r of fresh) {
  console.log(`  ${r.grade} ${String(r.day).padStart(2)}일 ${won(r.amt).padStart(12)}  ${r.names.join(' / ').slice(0, 40)}`);
  console.log(`      ${r.per.map((v, i) => v ? `${months[i].slice(5)}:${Math.round(v / 1e4)}만` : '').filter(Boolean).join('  ')}`);
}
const dup = out.filter(r => !r.already && r.plan);
if (dup.length) {
  console.log(`\n=== ⚠ 예정 행이 이미 있어 등록하면 안 되는 것 : ${dup.length}건 ===`);
  for (const r of dup) console.log(`  ${r.names[0]}  →  예정 ${r.plan.n}건 ${won(r.plan.amt)} ("${r.plan.sample.slice(0, 28)}")`);
}

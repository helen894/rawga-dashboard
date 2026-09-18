#!/usr/bin/env node
/**
 * notify-pending-kakao.mjs — 입출금 예정 임박분을 카카오톡 '나에게 보내기' 로 알린다.
 *
 * 판정 규칙은 **index.html 의 collectPendingDue 를 그대로 떼어 와** 쓴다. 사본을 만들면
 *   대시보드 토스트와 카톡 문구가 갈린다 — 같은 회사 숫자가 두 군데서 다르면 아무도 안 믿는다.
 *   '지남' 을 미집행/확인 전으로 나누는 이유(적재 지연 = 가짜 경보)도 그 함수 주석에 있다.
 *
 * ⚠ 카카오 텍스트 템플릿은 text 가 **200자 제한**이다. 넘으면 400 이 난다 — 상세는 3건만
 *   싣고 나머지는 '외 N건' 으로 접는다.
 * ⚠ 보낼 게 없으면 **아무것도 보내지 않는다**. 매일 "이상 없음" 이 오면 곧 안 읽게 된다.
 * ⚠ 같은 내용은 하루 한 번만. 서명을 로컬 상태 파일에 남긴다(대시보드 토스트가 localStorage
 *   로 하는 것과 같은 방식).
 * ⚠ refresh_token 이 새로 오면 그때마다 시크릿 파일을 갱신한다. 안 하면 두 달 뒤 조용히 끊긴다.
 * ⚠ 토큰은 어디에도 찍지 않는다.
 *
 * 쓰는 법
 *   node scripts/notify-pending-kakao.mjs --dry     문구만 출력(발송 안 함)
 *   node scripts/notify-pending-kakao.mjs           발송
 *   node scripts/notify-pending-kakao.mjs --force   같은 내용이라도 다시 발송
 *
 * 최초 1회 토큰 발급은 scripts/kakao-setup.mjs 참고.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SECRET   = 'C:/Users/RAWGA/AppData/Local/rawga/kakao.secret';
const STATE    = 'C:/Users/RAWGA/AppData/Local/rawga/kakao-pending.state';
const BANK_SEC = 'C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret';
const PK       = 'sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const EP       = 'https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
const BOARD    = 'https://helen894.github.io/rawga-dashboard/';

const args = process.argv.slice(2);
const DRY = args.includes('--dry'), FORCE = args.includes('--force');

const addDays = (d, n) => {
  const [y, m, dd] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, dd + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
};
const todayKST = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const eok = (v) => (v / 1e8).toFixed(2) + '억';

/* ── index.html 에서 판정 함수와 임박 일수를 그대로 가져온다 ── */
const src = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`${name} 를 index.html 에서 못 찾음`);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error(`${name} 본문 끝을 못 찾음`);
};
const DUE_DAYS = Number((src.match(/const PENDING_DUE_DAYS\s*=\s*(\d+)/) || [])[1]);
if (!Number.isFinite(DUE_DAYS)) throw new Error('PENDING_DUE_DAYS 를 못 읽음');

/* ── cf_data 전량 (inspect 는 500건에서 잘려 구간을 쪼갠다) ── */
const bankSecret = readFileSync(BANK_SEC, 'utf8').trim();
const post = async (b) => {
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(EP, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: PK, Authorization: `Bearer ${PK}` },
        body: JSON.stringify({ secret: bankSecret, ...b }),
      });
      const t = await r.text();
      if (!t.trim().startsWith('{')) throw new Error(`HTTP ${r.status}`);
      return JSON.parse(t);
    } catch (e) {
      if (i === 3) throw e;
      await new Promise((s) => setTimeout(s, 700 * i));
    }
  }
};
const seen = new Map();
const pull = async (f, t, depth = 0) => {
  const r = await post({ inspect: { from: f, to: t } });
  if (r.matched > 500 && depth < 7) {
    const mid = addDays(f, Math.floor((Date.parse(t) - Date.parse(f)) / 86400000 / 2));
    await pull(f, mid, depth + 1);
    await pull(addDays(mid, 1), t, depth + 1);
    return;
  }
  for (const x of (r.rows || [])) seen.set(x._id, x);
};
for (const [f, t] of [['2020-01-01', '2025-12-31'], ['2026-01-01', '2026-06-30'], ['2026-07-01', '2027-12-31']]) {
  await pull(f, t);
}
const cfData = [...seen.values()];

const collect = new Function('addDays', 'getCf', 'getToday', 'PENDING_DUE_DAYS', `
  const todayKST = getToday;
  Object.defineProperty(globalThis, 'cfData', { get: getCf, configurable: true });
  ${grab('collectPendingDue')}
  return collectPendingDue;`)(addDays, () => cfData, todayKST, DUE_DAYS);
const p = collect();

const all = [...p.overdue, ...p.unconfirmed, ...p.soon];
if (!all.length) {
  console.log('보낼 내용 없음 — 발송하지 않습니다.');
  process.exit(0);
}

/* ── 문구 (200자 제한) ── */
const head = [];
if (p.overdue.length)     head.push(`미집행 ${p.overdue.length}건 ${eok(p.overdueNet)}`);
if (p.unconfirmed.length) head.push(`확인전 ${p.unconfirmed.length}건 ${eok(p.unconfirmedNet)}`);
if (p.soon.length)        head.push(`${DUE_DAYS}일내 ${p.soon.length}건 ${eok(p.soonNet)}`);

const net = (r) => (r.in || 0) - (r.out || 0);
const top = all.slice().sort((a, b) => Math.abs(net(b)) - Math.abs(net(a))).slice(0, 3);
const lines = top.map((r) => `· ${r.date.slice(5)} ${String(r.desc || '').slice(0, 14)} ${eok(net(r))}`);

let text = `${p.overdue.length ? '⚠️' : '📅'} 입출금 예정 (${p.today.slice(5)})\n${head.join('\n')}\n\n${lines.join('\n')}`;
if (all.length > top.length) text += `\n외 ${all.length - top.length}건`;
if (text.length > 200) text = text.slice(0, 197) + '...';

console.log(`판정 기준일 ${p.today} · 적재 커버리지 ${p.covered || '(없음)'}`);
console.log('-'.repeat(46));
console.log(text);
console.log('-'.repeat(46));
console.log(`${text.length}자 / 200자 제한`);

const sig = `${p.today}|${p.overdue.length}|${p.unconfirmed.length}|${p.soon.length}|${Math.round(p.overdueNet + p.unconfirmedNet + p.soonNet)}`;
if (!FORCE && existsSync(STATE) && readFileSync(STATE, 'utf8').trim() === sig) {
  console.log('\n같은 내용을 이미 보냈습니다 — 건너뜁니다 (--force 로 강제 발송).');
  process.exit(0);
}
if (DRY) {
  console.log('\n--dry 라 발송하지 않았습니다.');
  process.exit(0);
}

/* ── 발송 ── */
if (!existsSync(SECRET)) {
  console.error(`\n카카오 토큰이 없습니다: ${SECRET}`);
  console.error('먼저 node scripts/kakao-setup.mjs 로 발급하세요.');
  process.exit(2);
}
const conf = JSON.parse(readFileSync(SECRET, 'utf8'));
const tk = await fetch('https://kauth.kakao.com/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
  body: new URLSearchParams({ grant_type: 'refresh_token', client_id: conf.rest_key, refresh_token: conf.refresh_token }),
});
const tj = await tk.json().catch(() => ({}));
if (!tk.ok || !tj.access_token) {
  console.error(`토큰 갱신 실패 (HTTP ${tk.status}) ${tj.error || ''} ${tj.error_description || ''}`);
  console.error('→ refresh_token 이 만료됐을 수 있습니다. kakao-setup.mjs 로 다시 발급하세요.');
  process.exit(1);
}
/* 새 refresh_token 이 오면 갈아 끼운다 — 안 하면 두 달 뒤 조용히 끊긴다 */
if (tj.refresh_token && tj.refresh_token !== conf.refresh_token) {
  writeFileSync(SECRET, JSON.stringify({ ...conf, refresh_token: tj.refresh_token }), 'utf8');
  console.log('(refresh_token 갱신됨)');
}
const send = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${tj.access_token}`,
    'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
  },
  body: new URLSearchParams({
    template_object: JSON.stringify({
      object_type: 'text',
      text,
      link: { web_url: BOARD, mobile_web_url: BOARD },
      button_title: '대시보드 열기',
    }),
  }),
});
const sj = await send.json().catch(() => ({}));
if (!send.ok) {
  console.error(`발송 실패 (HTTP ${send.status}) code=${sj.code || '-'} ${sj.msg || ''}`);
  if (sj.code === -3) console.error('→ talk_message 동의가 없습니다. 콘솔 동의항목을 확인하세요.');
  process.exit(1);
}
writeFileSync(STATE, sig, 'utf8');
console.log('\n발송 완료.');

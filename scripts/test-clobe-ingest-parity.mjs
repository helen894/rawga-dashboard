#!/usr/bin/env node
/**
 * test-clobe-ingest-parity.mjs — 검증 로직을 공유 모듈로 뺀 뒤 **판정이 안 바뀌었는지** 증명한다.
 *
 * 왜 있는가 (2026-11-13)
 *   PC 가 꺼져도 적재가 돌게 하려고 검증을 Edge 로 옮겼다. 그 과정에서 로직을
 *   `supabase/functions/cf-clobe-ingest/clobe-validate.mjs` 로 추출했는데, 여기 담긴
 *   중단 조건 6개는 전부 **실제로 사고가 터진 뒤** 붙인 것이다(외화 원금이 원화로 섞임,
 *   계좌 단위 행 누락, 페이지 누락 등). 추출이 조금이라도 어긋나면 그 사고가 되돌아온다.
 *
 * 어떻게 증명하는가
 *   옛 스크립트(git HEAD 의 사본)와 새 스크립트를 **같은 실데이터 fixture** 에 --dry-run 으로
 *   돌려, 일자별 (건수·입금·출금) 표와 총 건수를 비교한다. 이 표가 같으면 적재될 행집합이 같다.
 *
 * 쓰는 법: node scripts/test-clobe-ingest-parity.mjs
 *   기준 스크립트는 git 에서 자동으로 꺼내 쓴다. 기준 커밋을 바꾸려면 BASE_REF=<ref>.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIX_DIR = 'C:/Users/RAWGA/AppData/Local/Temp';
/* 비교 대상(검증 분리 전 스크립트)은 git 에서 직접 꺼내 쓴다 — 수동 준비가 필요하면
   아무도 안 돌리게 된다. BASE_REF 로 기준 커밋을 바꿀 수 있다(기본: 분리 직전 커밋). */
const BASE_REF = process.env.BASE_REF || 'HEAD';
const OLD = join(tmpdir(), `clobe-ingest-base-${BASE_REF.replace(/[^\w.-]/g, '_')}.mjs`);
try {
  const src = execFileSync('git', ['show', `${BASE_REF}:scripts/clobe-cf-ingest.mjs`], { encoding: 'utf8' });
  const lines = src.split('\n');
  /* 적재 직전 rows 를 덤프하는 훅을 넣는다. 줄 번호로 넣는 이유: 그 줄의 템플릿 리터럴에
     역슬래시가 있어 문자열 매칭이 환경에 따라 깨진다(실제로 한 번 당했다). */
  const i = lines.findIndex(l => l.includes('dry-run] 적재하지'));
  if (i < 0) throw new Error('기준 스크립트에서 dry-run 분기를 못 찾음 — BASE_REF 가 맞는지 확인하세요');
  lines.splice(i, 0, 'if (process.env.DUMP_ROWS) writeFileSync(process.env.DUMP_ROWS, JSON.stringify(rows, null, 2));');
  writeFileSync(OLD, lines.join('\n'));
} catch (e) {
  console.error(`기준 스크립트를 꺼내지 못했습니다: ${e.message}`);
  process.exit(1);
}
const fixtures = readdirSync(FIX_DIR).filter(f => /^clobe-cf-\d{8}\.json$/.test(f)).sort();
if (!fixtures.length) { console.error('fixture 가 없습니다.'); process.exit(1); }

/* 일자별 표 + 합계 줄만 뽑는다 — 이게 같으면 적재될 행집합이 같다.
   ⚠ 로그 문구 비교는 쓰지 않는다. 문구는 리팩터링에서 당연히 바뀌고, 그걸로 실패하면
     진짜 회귀와 구분이 안 돼 테스트를 끄게 된다. 비교해야 하는 건 **숫자**다. */
const grab = (out) => (out.split('\n')
  .filter(l => /^\s{2}\d{4}-\d{2}-\d{2}\s/.test(l) || /^\s{2}합계\s/.test(l))
  .map(l => l.replace(/\s+/g, ' ').trim()));

const run = (script, fixture, dumpPath) => {
  try {
    return execFileSync(process.execPath, [script, join(FIX_DIR, fixture), '--dry-run',
        ...(dumpPath && script !== OLD ? ['--emit-json', dumpPath] : [])],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(dumpPath && script === OLD ? { DUMP_ROWS: dumpPath } : {}) } });
  } catch (e) { return (e.stdout || '') + (e.stderr || ''); }
};
/* 옛 스크립트는 rows 배열을, 새 스크립트는 {rows:[...]} 를 덤프한다 — 행 배열로 맞춘다 */
const readRows = (p) => {
  if (!existsSync(p)) return null;
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return Array.isArray(j) ? j : (j.rows || null);
};
const canon = (rows) => (rows || []).slice()
  .sort((a, b) => String(a.clobe_id).localeCompare(String(b.clobe_id)))
  .map(r => JSON.stringify(r));

let pass = 0, fail = 0;
console.log(`fixture ${fixtures.length}건으로 옛/새 스크립트 판정 대조\n`);
for (const f of fixtures) {
  const dumpA = join(tmpdir(), `parity-old-${f}`), dumpB = join(tmpdir(), `parity-new-${f}`);
  const a = grab(run(OLD, f, dumpA));
  const b = grab(run('scripts/clobe-cf-ingest.mjs', f, dumpB));
  const tableOk = JSON.stringify(a) === JSON.stringify(b);
  /* 일자별 표가 같아도 적요·clobe_id·tx_at·fx_usd 가 다를 수 있다 — 행 단위로 본다 */
  const ra = canon(readRows(dumpA)), rb = canon(readRows(dumpB));
  const rowsOk = JSON.stringify(ra) === JSON.stringify(rb);
  const ok = tableOk && rowsOk;
  console.log(`  ${ok ? '✅' : '❌'} ${f}  (일자표 ${a.length}줄 · 행 ${ra.length}건)`);
  if (!ok) {
    fail++;
    if (!tableOk) { console.log('     일자표 옛:', JSON.stringify(a)); console.log('     일자표 새:', JSON.stringify(b)); }
    if (!rowsOk) {
      const diff = ra.map((x, i) => (x === rb[i] ? null : [x, rb[i]])).filter(Boolean).slice(0, 2);
      console.log(`     행 불일치 ${Math.abs(ra.length - rb.length)}건 차이, 첫 사례:`, JSON.stringify(diff));
    }
  } else pass++;
  for (const d of [dumpA, dumpB]) { try { rmSync(d); } catch {} }
}
console.log(`\n${fail ? '❌' : '✅'} ${pass}/${pass + fail} 일치`);
process.exit(fail ? 1 : 0);

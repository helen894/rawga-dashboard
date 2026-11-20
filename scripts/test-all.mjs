#!/usr/bin/env node
/**
 * test-all.mjs — 저장소의 모든 검증 스크립트를 한 번에 돌린다.
 *
 * 왜 있는가 (2026-11-20)
 *   한 번에 돌리는 방법이 없어서 테스트가 깨져도 아무도 몰랐다. 2026-11-20 에 세어 보니
 *   4건이 빨간 채였고, 그중 ar-header-map 은 **63일**이었다. 하필 그게 "헤더 이름이 바뀌면
 *   그 열을 못 찾고 조용히 0 이 된다"를 잡으라고 만든 가드다 — 회수 55건이 0 이 되고 미회수가
 *   10.5억 부풀었던 그 사고. 가드가 꺼진 줄 모르는 게 가드가 없는 것보다 나쁘다.
 *   깨진 걸 **빨리 알아차리는 것** 자체가 이 파일의 목적이다.
 *
 * 쓰는 법
 *   node scripts/test-all.mjs            전부 실행 (기본 4개씩 병렬, 약 6초)
 *   node scripts/test-all.mjs ar card    이름에 'ar' 또는 'card' 가 든 것만
 *   node scripts/test-all.mjs --serial   한 번에 하나씩 (출력이 섞이면 곤란할 때)
 *   실패가 하나라도 있으면 **종료코드 1** — 훅이나 CI 에 그대로 물릴 수 있다.
 */
import { readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'scripts');
const SELF = path.basename(fileURLToPath(import.meta.url));

/* test-*.mjs 로 안 끝나지만 통과/실패를 종료코드로 말하는 검사들.
   이름만 보고 모으면 조용히 빠지므로 여기 명시한다. */
const ALSO = ['check-html-escaping.mjs'];
const TIMEOUT_MS = 120000;   // 멈춘 테스트가 러너를 붙잡지 않게

const argv = process.argv.slice(2);
const SERIAL = argv.includes('--serial');
const filters = argv.filter(a => !a.startsWith('--'));

/* ⚠ 자기 자신이 test-*.mjs 패턴에 걸린다. 빼지 않으면 무한 재귀로 돈다. */
let files = readdirSync(DIR)
  .filter(f => (/^test-.*\.mjs$/.test(f) && f !== SELF) || ALSO.includes(f))
  .sort();
if (filters.length) files = files.filter(f => filters.some(q => f.includes(q)));
if (!files.length) { console.error('실행할 테스트가 없습니다.'); process.exit(1); }

const run = (file) => new Promise((resolve) => {
  const t0 = Date.now();
  execFile(process.execPath, [path.join(DIR, file)],
    { cwd: ROOT, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    (err, stdout, stderr) => resolve({
      file, ms: Date.now() - t0, ok: !err,
      /* 시간초과는 종료코드가 아니라 err.killed 로 온다 — 그냥 '실패' 로 뭉개면
         "왜 깨졌지" 를 다시 파야 한다. */
      timedOut: !!(err && err.killed),
      out: ((stdout || '') + (stderr || '')).trimEnd(),
    }));
});

const line = (r) => `  ${r.ok ? '✅' : '❌'} ${r.file.padEnd(34)} ${String(r.ms).padStart(5)}ms`
  + (r.timedOut ? '  ⏱ 시간초과' : '');

console.log(`\n검증 ${files.length}건${SERIAL ? ' (순차)' : ' (4개씩 병렬)'}\n`);

const results = [];
if (SERIAL) {
  for (const f of files) { const r = await run(f); results.push(r); console.log(line(r)); }
} else {
  /* 끝나는 순서대로 찍으면 매번 순서가 달라 눈으로 비교가 안 된다 — 모아서 파일명 순으로 찍는다. */
  const queue = files.slice();
  const workers = Array.from({ length: Math.min(4, files.length) }, async () => {
    for (let f; (f = queue.shift()); ) results.push(await run(f));
  });
  await Promise.all(workers);
  results.sort((a, b) => a.file.localeCompare(b.file));
  results.forEach(r => console.log(line(r)));
}

const failed = results.filter(r => !r.ok);
if (failed.length) {
  /* 실패한 것의 출력을 여기서 보여 준다 — 따로 다시 돌리게 하면 그 한 번을 안 하게 된다. */
  for (const r of failed) {
    console.log(`\n${'─'.repeat(62)}\n❌ ${r.file}${r.timedOut ? `  (${TIMEOUT_MS / 1000}초 시간초과)` : ''}\n`);
    const tail = r.out.split('\n').slice(-25);
    console.log(tail.map(l => '  ' + l).join('\n') || '  (출력 없음)');
  }
}

const total = results.reduce((a, r) => a + r.ms, 0);
console.log(`\n${failed.length ? '❌' : '✅'} 통과 ${results.length - failed.length} · 실패 ${failed.length}`
  + `  (합계 ${(total / 1000).toFixed(1)}초)\n`);
process.exitCode = failed.length ? 1 : 0;

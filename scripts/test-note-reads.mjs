#!/usr/bin/env node
/**
 * test-note-reads.mjs — 메모 '읽음' 판별 규칙을 검증한다.
 *
 * 왜 있는가 (2026-11-17)
 *   읽음 처리는 **두 갈래**로 갈린다. 이 갈림이 기능 전체의 설계 의도다:
 *     · 그냥 새 메모        → 창을 여는 것만으로 읽음
 *     · **나에게 온** 메모   → '확인' 을 눌러야 읽음 (한 단계 더 둬서 놓치지 않게)
 *   '나에게 온' 은 두 경우다 — 나를 @멘션했거나, **내가 참여한 대화에 답글**이 달렸거나.
 *   어느 한쪽이 뒤집히면 둘 중 하나가 된다: 멘션·답글이 조용히 묻히거나,
 *   읽은 메모가 접속할 때마다 계속 팝업으로 돌아오거나. 둘 다 조용히 망가진다.
 *
 *   '메일을 봤는가' 는 애초에 알 수 없다(추적 픽셀은 쓰지 않는다). 그래서 기준은
 *   **'대시보드에서 확인했는가'** 이고, 그 상태는 cf_note_reads 에만 있다.
 *
 * ⚠ 화면(index.html)과 메일(note-notify)이 **같은 규칙**이어야 한다 — 메일은 왔는데 '확인' 이
 *   안 뜨거나 그 반대면 안 된다. 그래서 Edge 쪽 수신자 계산도 소스에서 같이 확인한다.
 *
 * ⚠ 이 테스트는 index.html 에서 함수를 꺼내 돌린다 — 사본을 만들지 않는다.
 *
 * 쓰는 법: node scripts/test-note-reads.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const edge = readFileSync(path.join(ROOT, 'supabase/functions/note-notify/index.ts'), 'utf8');

/* index.html 에서 함수 본문을 그대로 꺼낸다 (중괄호 균형으로 끝을 찾는다) */
function grab(name) {
  const i = html.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`index.html 에서 ${name} 을 못 찾았습니다`);
  let d = 0, started = false;
  for (let j = html.indexOf('{', i); j < html.length; j++) {
    if (html[j] === '{') { d++; started = true; }
    else if (html[j] === '}') { d--; if (started && d === 0) return html.slice(i, j + 1); }
  }
  throw new Error(`${name} 의 끝을 못 찾았습니다`);
}

/* 규칙이 소스에 살아 있는지 — 한 글자만 뒤집혀도 기능이 조용히 반대가 되는 자리들 */
const modalSrc  = grab('openNotesModal');
const threadSrc = grab('renderNotesThread');
const AUTO_RULE    = /\.filter\(n =>[\s\S]{0,160}!needsAck\(n\)\)/.test(modalSrc);
const NEEDACK_RULE = /needAck\s*=\s*n\s*=>\s*needsAck\(n\)\s*&&\s*!cfNoteReads\.has\(n\.id\)/.test(threadSrc);
const EDGE_THREAD  = /or=\(id\.eq\.\$\{parentId\},parent_id\.eq\.\$\{parentId\}\)/.test(edge);
const EDGE_DEDUPE  = /toReply\s*=\s*pick\(participants\)\.filter\(\(e\) => !mentionSet\.has\(e\)\)/.test(edge);
const EDGE_REPLY_CALL = /if \(mentions\.length \|\| data\.parent_id\)/.test(html);

const api = new Function(`
  ${grab('isMentionedMe')}
  ${grab('isReplyToMyThread')}
  ${grab('needsAck')}
  ${grab('unreadNotes')}
  return {
    isMentionedMe, isReplyToMyThread, needsAck, unreadNotes,
    set(me, notes, reads) {
      globalThis.currentUserEmail = me;
      globalThis.cfNotes = notes;
      globalThis.cfNoteReads = reads;
    },
  };
`)();

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✅ ' + name); } else { fail++; console.log('  ❌ ' + name); } };
const eq = (name, got, want) => ok(name + ` (${JSON.stringify(got)} === ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want));

const ME = 'helen@rawga.com', OTHER = 'soon@rawga.com', THIRD = 'peter_ha@rawga.com';
const n = (id, author, mentions, cfId, at, parent) =>
  ({ id, author_email: author, mentions: mentions || [], created_at: at, parent_id: parent || null, cf_id: cfId });

function build(list) {
  const m = new Map();
  for (const x of list) { if (!m.has(x.cf_id)) m.set(x.cf_id, []); m.get(x.cf_id).push(x); }
  return m;
}

console.log('\n── 규칙이 소스에 살아 있는가 ──');
ok('openNotesModal 은 !needsAck 인 메모만 자동 읽음 처리한다', AUTO_RULE);
ok('스레드의 확인 버튼은 needsAck + 안 읽음에만 뜬다',          NEEDACK_RULE);
ok('submitNote 는 답글이면 멘션이 없어도 알림을 부른다',        EDGE_REPLY_CALL);
ok('Edge 는 원글+같은부모 답글로 스레드 참여자를 모은다',        EDGE_THREAD);
ok('Edge 는 멘션 받은 사람을 답글 수신자에서 뺀다(두 통 금지)',  EDGE_DEDUPE);

console.log('\n── isMentionedMe ──');
api.set(ME, new Map(), new Set());
ok('멘션 목록에 내가 있으면 참',         api.isMentionedMe(n('a', OTHER, [ME], 'c1', '2026-11-17')));
ok('대소문자가 달라도 잡는다',            api.isMentionedMe(n('a', OTHER, ['HELEN@RAWGA.COM'], 'c1', '2026-11-17')));
ok('남만 멘션됐으면 거짓',                !api.isMentionedMe(n('a', OTHER, [THIRD], 'c1', '2026-11-17')));
ok('mentions 가 없는 행도 터지지 않는다', !api.isMentionedMe({ id: 'a', author_email: OTHER }));

console.log('\n── isReplyToMyThread — 내가 낀 대화인가 ──');
{
  const root = n('r0', ME,    [], 'c1', '2026-11-16T01:00:00Z');
  const rep1 = n('r1', OTHER, [], 'c1', '2026-11-17T01:00:00Z', 'r0');
  api.set(ME, build([root, rep1]), new Set());
  ok('내 원글에 남이 답글 → 참',   api.isReplyToMyThread(rep1));
  ok('원글 자체는 답글이 아니다',  !api.isReplyToMyThread(root));
}
{
  // 남의 원글인데 내가 먼저 답글을 달아 뒀고, 그 뒤 제3자가 답글
  const root = n('r0', OTHER, [], 'c2', '2026-11-15T01:00:00Z');
  const mine = n('r1', ME,    [], 'c2', '2026-11-16T01:00:00Z', 'r0');
  const rep2 = n('r2', THIRD, [], 'c2', '2026-11-17T01:00:00Z', 'r0');
  api.set(ME, build([root, mine, rep2]), new Set());
  ok('내가 답글을 단 대화의 새 답글 → 참', api.isReplyToMyThread(rep2));
}
{
  // 내가 전혀 안 낀 대화
  const root = n('r0', OTHER, [], 'c3', '2026-11-15T01:00:00Z');
  const rep1 = n('r1', THIRD, [], 'c3', '2026-11-17T01:00:00Z', 'r0');
  api.set(ME, build([root, rep1]), new Set());
  ok('내가 안 낀 대화의 답글 → 거짓',       !api.isReplyToMyThread(rep1));
  ok('그래도 멘션이 있으면 needsAck 은 참',  api.needsAck(n('r2', THIRD, [ME], 'c3', '2026-11-17T02:00:00Z', 'r0')));
  ok('멘션도 참여도 없으면 needsAck 은 거짓', !api.needsAck(rep1));
}

console.log('\n── unreadNotes — 무엇이 목록에 오르나 ──');
api.set(ME, build([
  n('n1', OTHER, [ME],    'c1', '2026-11-17T01:00:00Z'),
  n('n2', OTHER, [],      'c1', '2026-11-16T01:00:00Z'),
  n('n3', ME,    [OTHER], 'c2', '2026-11-15T01:00:00Z'),   // 내가 쓴 글
  n('n4', THIRD, [],      'c2', '2026-11-14T01:00:00Z'),
]), new Set());
eq('내가 쓴 메모는 빠지고 최신순',  api.unreadNotes().map(u => u.note.id), ['n1', 'n2', 'n4']);
eq('멘션 여부가 함께 온다',         api.unreadNotes().map(u => u.mention), [true, false, false]);
eq('cf_id 가 함께 온다',            api.unreadNotes().map(u => u.cfId), ['c1', 'c1', 'c2']);

console.log('\n── 답글은 확인 대상으로 표시된다 ──');
api.set(ME, build([
  n('r0', ME,    [], 'c1', '2026-11-15T01:00:00Z'),            // 내 원글
  n('r1', OTHER, [], 'c1', '2026-11-16T01:00:00Z', 'r0'),      // 남의 답글 → 확인 필요
  n('x0', OTHER, [], 'c2', '2026-11-17T01:00:00Z'),            // 무관한 새 메모 → 그냥 읽음
]), new Set());
eq('답글은 ack, 무관한 메모는 아님',
  api.unreadNotes().map(u => [u.note.id, u.ack]), [['x0', false], ['r1', true]]);
eq('답글은 mention 이 아니라 reply 로 구분된다',
  api.unreadNotes().filter(u => u.ack).map(u => [u.mention, u.reply]), [[false, true]]);

console.log('\n── 읽음 처리된 건 빠진다 ──');
api.set(ME, build([
  n('n1', OTHER, [ME], 'c1', '2026-11-17T01:00:00Z'),
  n('n2', OTHER, [],   'c1', '2026-11-16T01:00:00Z'),
]), new Set(['n2']));
eq('읽은 메모는 목록에서 사라진다', api.unreadNotes().map(u => u.note.id), ['n1']);

api.set(ME, build([n('n1', OTHER, [ME], 'c1', '2026-11-17T01:00:00Z')]), new Set(['n1']));
eq('전부 읽었으면 빈 목록', api.unreadNotes().length, 0);

console.log('\n── 로그인 전 ──');
api.set('', build([n('n1', OTHER, [ME], 'c1', '2026-11-17T01:00:00Z')]), new Set());
eq('로그인 전이면 빈 목록(누구 기준인지 모른다)', api.unreadNotes().length, 0);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass}/${pass + fail} 통과\n`);
process.exit(fail === 0 ? 0 : 1);

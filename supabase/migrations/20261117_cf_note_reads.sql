-- 입출금 메모 '읽음' 상태 (2026-11-17)
--
-- 왜 cf_notes 에 컬럼을 더하지 않는가:
--   cf_notes 의 UPDATE 정책은 **작성자 본인만** 쓸 수 있다. 메모를 읽는 쪽은 대개
--   작성자가 아니므로(멘션을 받은 사람) 그 테이블에는 읽음을 기록할 수가 없다.
--   notified_at 은 '메일을 보냈는가'(발송 중복 방지)이지 '사람이 읽었는가'가 아니다.
--
-- 읽음은 사람마다 다르므로 (note_id, user_email) 한 쌍이 한 행이다.

create table if not exists public.cf_note_reads (
  note_id    uuid        not null references public.cf_notes(id) on delete cascade,
  user_email text        not null,
  read_at    timestamptz not null default now(),
  primary key (note_id, user_email)
);

create index if not exists cf_note_reads_user_idx on public.cf_note_reads (user_email);

alter table public.cf_note_reads enable row level security;

-- ⚠ anon 에는 아무 권한도 주지 않는다 — publishable 키가 index.html 에 박혀 공개 배포된다.
--   읽음 상태는 본인 것만 보고 본인 것만 쓴다(남의 읽음 여부를 들여다볼 이유가 없다).
drop policy if exists cf_note_reads_select on public.cf_note_reads;
create policy cf_note_reads_select on public.cf_note_reads
  for select to authenticated
  using (user_email = auth.jwt() ->> 'email');

drop policy if exists cf_note_reads_insert on public.cf_note_reads;
create policy cf_note_reads_insert on public.cf_note_reads
  for insert to authenticated
  with check (user_email = auth.jwt() ->> 'email');

-- 되돌리기(읽음 해제)용 — 본인 것만
drop policy if exists cf_note_reads_delete on public.cf_note_reads;
create policy cf_note_reads_delete on public.cf_note_reads
  for delete to authenticated
  using (user_email = auth.jwt() ->> 'email');

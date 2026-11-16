-- 입출금 메모 · 대댓글 (2026-11-16)
--
-- 왜 전용 테이블인가
--   ① cf_data 행 안에 넣으면 안 된다 — 적재 Edge 가 행을 갱신할 때 덮어쓴다.
--      법인카드에서 overwrite 가 귀속을 바꾼 사고(72건)를 이미 겪었다.
--   ② cat_data 키 하나에 몰아넣으면 **동시 편집이 깨진다.** cat_data 는 키 단위 낙관적 잠금이라
--      두 사람이 서로 다른 행에 메모를 달아도 같은 키면 나중 저장이 거부된다
--      ("다른 곳에서 변경돼 저장하지 못했습니다"). 지금 접속자가 둘 이상이라 실제로 부딪힌다.
--   ③ 댓글은 행 단위다. 테이블로 두면 충돌이 아예 없고, '내 멘션 모아보기' 같은 질의가 자연스럽다.
--
-- 키 선택: cf_data 행의 _id 를 쓴다.
--   clobe_id 는 적재분에만 있어 수기 입력 행에는 없다. _id 는 모든 행에 있고 재적재에도 유지된다.
--   ⚠ cf_data 는 단일 행 JSONB 배열이라 FK 를 걸 수 없다. 무결성은 애플리케이션이 지킨다 —
--     행이 지워지면 메모는 고아로 남는다(지우지 않는다: 지워진 거래에 달린 메모가 기록으로 더 값지다).

create table if not exists public.cf_notes (
  id           uuid        primary key default gen_random_uuid(),
  cf_id        text        not null,                    -- cf_data 행의 _id
  parent_id    uuid        references public.cf_notes(id) on delete cascade,  -- null = 원글
  author_email text        not null,
  body         text        not null,
  mentions     text[]      not null default '{}',       -- 파싱된 이메일 (알림 대상)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  resolved_at  timestamptz,                             -- 해결 처리(원글에만 의미)
  resolved_by  text,
  -- 멘션 알림을 이미 보냈는지. Edge 가 보낸 뒤 찍고, 이미 찍혀 있으면 다시 안 보낸다.
  -- ⚠ 이게 없으면 새로고침·재시도마다 같은 멘션으로 메일이 또 나간다.
  notified_at  timestamptz
);

-- 한 거래의 스레드를 통째로 읽는 게 가장 잦은 질의
create index if not exists cf_notes_cf_id_idx   on public.cf_notes (cf_id, created_at);
-- '내 멘션 모아보기'
create index if not exists cf_notes_mentions_idx on public.cf_notes using gin (mentions);

-- updated_at 자동 갱신
create or replace function public.cf_notes_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists cf_notes_touch on public.cf_notes;
create trigger cf_notes_touch before update on public.cf_notes
  for each row execute function public.cf_notes_touch();

-- ── RLS ────────────────────────────────────────────────────────────────────
-- 대시보드는 로그인(Supabase Auth)을 거치므로 authenticated 에게만 연다.
-- ⚠ anon 에는 아무 권한도 주지 않는다. publishable 키가 index.html 에 박혀 공개 배포되므로,
--   anon 에 열면 누구나 메모를 읽고 쓸 수 있다(email_log 가 지금 그 상태다 — 별도 점검 필요).
alter table public.cf_notes enable row level security;

drop policy if exists cf_notes_select on public.cf_notes;
create policy cf_notes_select on public.cf_notes
  for select to authenticated using (true);

drop policy if exists cf_notes_insert on public.cf_notes;
create policy cf_notes_insert on public.cf_notes
  for insert to authenticated
  with check (author_email = auth.jwt() ->> 'email');   -- 남의 이름으로 못 쓴다

drop policy if exists cf_notes_update on public.cf_notes;
create policy cf_notes_update on public.cf_notes
  for update to authenticated
  using (author_email = auth.jwt() ->> 'email'          -- 내 글은 내가 고친다
         or resolved_at is not null or resolved_by is not null)
  with check (true);

drop policy if exists cf_notes_delete on public.cf_notes;
create policy cf_notes_delete on public.cf_notes
  for delete to authenticated
  using (author_email = auth.jwt() ->> 'email');        -- 내 글만 지운다

-- Realtime — 다른 사람이 단 메모가 바로 보이게
alter publication supabase_realtime add table public.cf_notes;

-- 확인:
--   select count(*) from public.cf_notes;
--   select tablename, policyname, cmd, roles from pg_policies where tablename = 'cf_notes';
--   select schemaname||'.'||tablename from pg_publication_tables where pubname='supabase_realtime';

-- cf_data 낙관적 잠금 (2026-08-02)
--
-- 배경: cf_data 는 거래 배열 전체가 한 행(data jsonb)에 들어 있어, 대시보드와 적재 Edge 함수가
--       각각 배열 전체를 덮어쓴다. 병합이 아니라 마지막에 쓴 쪽이 이기는 구조라, 둘이 겹치면
--       한쪽 변경이 아무 신호 없이 사라진다. 2026-08-01 에 실제로 292건이 유실됐다.
--
-- 대책: 쓰기 주체가 "내가 읽은 version 일 때만 쓴다" 는 조건을 걸 수 있게 version 을 둔다.
--       0행 갱신 = 그새 누가 썼다는 뜻이므로 덮어쓰지 않고 중단/재시도한다.
--
-- 트리거로 자동 증가시키는 이유: 쓰기 주체가 version 을 직접 올리게 하면, 아직 갱신되지 않은
--       쓰기 주체(구버전 Edge 함수 등)가 version 을 그대로 둔 채 data 만 바꿔버려 상대가 충돌을
--       감지하지 못한다. 트리거로 올리면 누가 쓰든 version 이 반드시 바뀐다.

alter table public.cf_data add column if not exists version bigint not null default 0;

create or replace function public.bump_version()
returns trigger
language plpgsql
as $$
begin
  new.version := coalesce(old.version, 0) + 1;
  return new;
end;
$$;

drop trigger if exists cf_data_bump_version on public.cf_data;
create trigger cf_data_bump_version
  before update on public.cf_data
  for each row execute function public.bump_version();

-- ── Realtime 발행 ──────────────────────────────────────────────────────────
-- 유실의 진짜 원인. 대시보드는 cf_data 의 UPDATE 를 구독하고 있었지만, supabase_realtime
-- 퍼블리케이션에 cat_data 만 들어 있어 cf_data 이벤트가 한 번도 오지 않았다.
-- → Edge 가 써도 대시보드는 모른 채 예전 배열을 들고 있다가 다음 저장에 통째로 덮어썼다.
-- cat_data 는 발행돼 있어 카테고리 동기화만 정상이라 문제가 드러나지 않았다.
alter publication supabase_realtime add table public.cf_data;

-- 확인:
--   select id, version, jsonb_array_length(data) as rows, updated_at from public.cf_data;
--   update public.cf_data set updated_at = now() where id = <id>;  -- version 이 +1 되어야 정상
--   select schemaname||'.'||tablename from pg_publication_tables where pubname='supabase_realtime';
--
-- 미적용: ar_data 도 대시보드가 구독하지만 발행돼 있지 않다(AR 은 시트가 진실원천이라
--         브라우저가 쓰지 않아 유실 위험은 낮음). cat_data 와 함께 별도 검토.

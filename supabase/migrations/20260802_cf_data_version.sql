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

-- 확인:
--   select id, version, jsonb_array_length(data) as rows, updated_at from public.cf_data;
--   update public.cf_data set updated_at = now() where id = <id>;  -- version 이 +1 되어야 정상

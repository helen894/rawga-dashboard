-- ar_data · cat_data 낙관적 잠금 (2026-08-02) — cf_data 와 동일 패턴 확장
--
-- cf_data 는 20260802_cf_data_version.sql 에서 처리했다. 나머지 두 테이블도 같은 위험이 있다.
--
--  · ar_data  : cf_data 와 같은 단일 행(배열 전체). 시트 동기화 Edge(ar-sheet-sync)가 쓰고,
--               대시보드는 AR_READONLY=true 라 현재는 쓰지 않는다. 다만 Realtime 발행이 안 돼
--               있어 시트가 갱신돼도 대시보드가 모른다(새로고침해야 반영). 발행을 추가한다.
--  · cat_data : key 별 21행 구조라 행이 서로 독립적이다. 따라서 key 단위로 version 을 걸면
--               다른 key 를 쓰는 호출부(saveArMeta, 법인카드 복원 등)와 간섭하지 않는다.
--               여기 담긴 학습 매핑(desc_to_mid 등)이 분류 작업의 산출물이라 보호 가치가 크다.
--
-- bump_version() 트리거 함수는 cf_data 마이그레이션에서 이미 만들었으므로 재사용한다.

alter table public.ar_data  add column if not exists version bigint not null default 0;
alter table public.cat_data add column if not exists version bigint not null default 0;

drop trigger if exists ar_data_bump_version on public.ar_data;
create trigger ar_data_bump_version
  before update on public.ar_data
  for each row execute function public.bump_version();

drop trigger if exists cat_data_bump_version on public.cat_data;
create trigger cat_data_bump_version
  before update on public.cat_data
  for each row execute function public.bump_version();

-- Realtime 발행 — ar_data 는 대시보드가 구독만 하고 발행이 안 돼 있었다(cf_data 와 같은 문제).
-- cat_data 는 이미 발행돼 있다.
alter publication supabase_realtime add table public.ar_data;

-- 확인:
--   select schemaname||'.'||tablename from pg_publication_tables where pubname='supabase_realtime';
--   select key, version from public.cat_data order by key;

# 입출금 구글 드라이브 폴더 자동 가져오기 (cf-folder-ingest)

`입출금_업로드` 폴더에 올린 엑셀을 자동으로 파싱해 대시보드 `cf_data`에 **추가(append)** 하는 파이프라인.

## 구성

```
구글 공유 드라이브(RAWGA_현금)
  ├─ 입출금_업로드  (1QdNNqxyF3o2qqR3mftalqiDxDmBZRkes)  ← 엑셀 업로드
  ├─ 입출금_완료    (1oEpbYu86u8dxgYY7UQykL08srWPw1xKj)  ← 성공 시 이동
  └─ 입출금_오류    (1SQO5SlHC1ekFOXs2FcRjuXKZBS0ntm2q)  ← 실패 시 이동

[Apps Script "CF 자동적재"]  apps-script/cf-folder-ingest.gs
  - 10분 트리거(ingestNewFiles) → 업로드 폴더 xlsx 파싱 → POST
       │  { secret, action:'push', rows:[{date,desc,in,out,status}] }
       ▼
[Supabase Edge Function cf-folder-ingest]  supabase/functions/cf-folder-ingest/index.ts
  - cf_data 읽기 → append(중복 skip, 상태 자동판정, 중분류 빈칸) → 저장
  - 반환 { ok, added, skipped, total }
       ▼
  성공: 완료 폴더 / 실패: 오류 폴더 이동, 대시보드 실시간 반영
```

## 동작 보장
- **덮어쓰기 없음**: cf_data 배열을 읽어 뒤에 추가만 함.
- **중복 방지**: (거래일+거래내용+상태+금액) 동일 행 skip + 처리 파일은 폴더 이동으로 재처리 차단.
- **컬럼 매핑**: 대시보드 `CF_FIELDS`와 동일 후보로 자동 감지. 중분류는 빈칸 → "✨ 자동분류 추천".
- **기존 업로드 방식(엑셀 업로드/개별 작성) 영향 없음** (별도 경로).

## 설정값
- Edge Function Secrets: `CF_SYNC_SECRET` (Apps Script 스크립트 속성과 **동일 값**)
- Edge Function Settings: **Verify JWT = OFF** (Apps Script는 Supabase JWT 없이 호출)
- Apps Script 고급 서비스: **Drive API v2** (식별자 `Drive`)

## 트러블슈팅(이번에 겪은 함정 — 재발 방지)
1. **Edge Function 자리에 Apps Script(.gs) 코드가 들어가 있으면 작동 불가.**
   Edge Function은 반드시 Deno/TypeScript(`Deno.serve`). Apps Script는 구글 쪽에만.
2. **`Drive.Files.create is not a function`** → 고급 Drive 서비스가 v3인데 코드는 v2(`insert`/`convert`).
   서비스를 **v2**로 맞추거나 코드를 v2 문법으로. (현재 v2 + `Drive.Files.insert(...,{convert:true})`)
3. **`Cannot use this operation on a shared drive item`** → `folder.addFile()/removeFile()`(DriveApp)는
   공유 드라이브 불가. `Drive.Files.update({}, id, null, {addParents, removeParents, supportsAllDrives:true})` 사용.
4. **401 unauthorized (secret 불일치)** → Supabase Secrets와 Apps Script 속성의 `CF_SYNC_SECRET` 값 불일치.

## 미사용(이 방식엔 불필요)
- OAuth 클라이언트 `drive-importer-oauth`, 서비스계정 `drive-importer` — 서버가 Apps Script(본인 계정)로
  드라이브에 접근하므로 사용하지 않음. 삭제해도 무방.

---
name: rawga-card-clobe-ingest
description: 평일(월~금) 클로브 법인카드 승인내역(어제까지)을 검증 후 대시보드 법인카드 탭에 자동 적재
---

> ⚠ **이 파일은 사본입니다.** 실제로 실행되는 원본은
> `%USERPROFILE%\.claude\scheduled-tasks\rawga-card-clobe-ingest\SKILL.md` 이며,
> 그쪽은 git 관리 대상이 아니라 기록 보존용으로 여기에 함께 둡니다.
> **태스크를 수정하면 원본과 이 사본을 같이 고쳐야 합니다.**

RAWGA 자금 대시보드의 법인카드 사용내역(corp_card_tx_data)에 클로브 카드 승인내역을 자동 적재한다. 조용히 수행하고, 이상이 있을 때만 사람이 읽을 요약을 남긴다.

## 원칙 (반드시 지킬 것)
- **승인(사용) 축만** 쓴다. `get_labeled_card_billing_items`(청구내역)와 **절대 섞지 않는다** — 같은 사용을 두 시점축으로 본 것이라 합치면 이중계상.
- 카드 데이터는 **cf_data(현금흐름)에 넣지 않는다.** 실제 현금 유출은 은행에서 빠지는 '카드대금 결제'이고 그건 입출금 적재가 이미 잡는다.
- 검증은 프롬프트가 아니라 **스크립트가** 한다. 스크립트가 중단하면 따르고 우회하지 말 것.
- 시크릿 값을 출력하거나 요약에 쓰지 말 것.

## 1) 클로브에서 승인내역 조회
1. `get_my_context` → **(주)로가** companyId (businessRegNo 1768101964, 보통 `31CbqJ82UGIZTXzfKRPd2`). (주)로가JHT·로가온은 대상 아님.
2. `get_card_approvals` 로 **최근 3일** 조회(놓친 날 보정용 — 중복은 자동 차단됨): `startDate`=3일 전, `endDate`=오늘, `size`=100
3. 응답의 `hasNext` 가 true 면 `page` 를 1씩 올려 **끝까지** 모두 받는다. (한 페이지라도 빠지면 스크립트가 건수 불일치로 중단)
4. `get_scraping_status` 로 CARD_APPROVAL 자산의 `scrapedAt` 확인. 수집이 어제보다 이전이면 **적재하지 말고** 사실만 남기고 종료.

커넥터 조회가 안 되면 아무것도 하지 말고 사유만 남기고 종료.

## 2) 응답을 파일로 저장 (원본 그대로)
받은 응답 객체를 **요약·재구성하지 말고 그대로** 저장한다.
- 한 페이지면 응답 객체 그대로, 여러 페이지면 배열로 `[{페이지0}, {페이지1}, ...]`
- 경로: `C:/Users/RAWGA/AppData/Local/Temp/clobe-card-YYYYMMDD.json` (YYYYMMDD=오늘)

## 3) 검증 → 적재
```bash
cd "C:/Users/RAWGA/Downloads/rawga-dashboard-git"
node scripts/clobe-card-ingest.mjs "C:/Users/RAWGA/AppData/Local/Temp/clobe-card-YYYYMMDD.json" --dry-run
```
스크립트가 하는 일: approvalId 중복 제거 · totalElements 대조 · **취소건(순액 0) 제외** · 오늘자 제외 · 카드번호→별칭 매핑(`scripts/card-alias-map.json`) · memo 에서 계정과목 추출(':' 앞) · 월별 요약 출력.

당일분은 제외한다(`--allow-today` 를 붙이지 말 것). 이유: 적재 후에 취소된 건은 재실행으로 고쳐지지 않는데(중복 skip), '가승인' 류는 몇 시간 뒤 전액취소되는 일이 잦아 당일 사용액이 과대계상된다. 하루 지나면 취소가 반영된 순액으로 들어온다.

검증에서 중단(exit 2)이나 **별칭 미매핑 경고**가 나오면 적재하지 말고 요약에 남긴다.
문제 없으면 `--dry-run` 없이 실행해 적재한다. 중복은 approval_id + 복합키로 이중 차단되므로 재실행해도 안전하다(수기 엑셀 업로드분과도 안 겹침).

## 4) 요약 남기기
- 정상: `카드 승인 N건 적재 (추가 X · 중복 Y) · 합계 Z원` 한 줄
- 다음 경우엔 자세히: 검증 중단(사유) / **별칭 미매핑 카드 발견**(카드번호 명시 — `scripts/card-alias-map.json` 에 추가 필요) / 커넥터·수집 최신성 문제 / 적재 실패(HTTP 오류)

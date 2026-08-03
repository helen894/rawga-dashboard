---
name: rawga-bank-snapshot
description: 평일(월~금) 아침 클로브 은행 실잔액을 조회해 RAWGA 자금 대시보드에 자동 반영
---

> ⚠ **이 파일은 사본입니다.** 실제로 실행되는 원본은
> `%USERPROFILE%\.claude\scheduled-tasks\rawga-bank-snapshot\SKILL.md` 이며,
> 그쪽은 git 관리 대상이 아니라 기록 보존용으로 여기에 함께 둡니다.
> **태스크를 수정하면 원본과 이 사본을 같이 고쳐야 합니다.**

RAWGA 자금 대시보드의 "은행 실잔액 대조" 카드를 최신화하는 작업이다. 세션 요약은 조용히 — 이상이 있을 때만 자세히 남긴다. 다만 **슬랙 DM은 매 실행마다 반드시 보낸다**(5단계).

## 1) 클로브에서 은행 잔액 조회
클로브 MCP 커넥터 사용:
1. `get_my_context` 로 companyId 확보 — **(주)로가** (businessRegNo 1768101964, 보통 `31CbqJ82UGIZTXzfKRPd2`). 회사가 여러 개면 반드시 (주)로가 선택. (주)로가JHT·로가온은 대상 아님.
2. `get_bank_accounts` 로 계좌·잔액 조회
3. `get_scraping_status` 로 각 자산 `scrapedAt`·`status` 확인

커넥터가 없거나 인증이 끊겨 조회가 안 되면 **아무것도 저장하지 말고** 그 사실만 한 줄로 남기고 종료한다.

## 2) 집계 규칙 (중요)
- `accountType`이 **CHECKING** = 예금, **SAVINGS** = 적금, **FX** = 외화
- **LOAN 은 부채이므로 현금 집계에서 반드시 제외**
- 외화(FX)는 `krwBalance`(원화환산)를 사용. `balance`는 외화 원금(USD 등)
- totalCash = CHECKING 합 + SAVINGS 합 + FX의 krwBalance 합
  (응답의 `summary.checkingBalanceSum` + `savingsBalanceSum` + `fxBalanceSumKrw` 를 쓰면 됨)
- fxRate = FX 계좌들의 krwBalance 합 ÷ balance 합 (환산 환율, 소수 1자리)
- asOf = get_scraping_status 의 BANK 카테고리 `scrapedAt` 중 **가장 최근 값**

## 3) 대시보드에 저장
로컬 파일에서 시크릿을 읽어 Edge 엔드포인트로 POST 한다. **시크릿 값을 출력하거나 요약에 쓰지 말 것.**

⚠ **한글을 curl 명령줄에 인라인으로 넣지 말 것.** Windows에서 `-d '{"source":"클로브"}'` 처럼 넘기면
인코딩이 깨진 채로 저장돼 카드에 `Ŭ?κ?` 로 표시된다(2026-08-03 발견, 그 전까지 매 실행 재발).
반드시 아래처럼 **JSON을 UTF-8 파일로 먼저 쓰고 `--data-binary @파일`** 로 보낸다.

**3-1. Write 도구로** snapshot JSON을 `C:\Users\RAWGA\AppData\Local\Temp\rawga-snap.json` 에 쓴다
(Write 도구는 UTF-8로 저장한다 — `echo`/`printf` 로 한글을 쓰면 같은 문제가 재발한다):
```json
{"asOf":"<가장 최근 scrapedAt>","source":"클로브","checking":<CHECKING합>,"savings":<SAVINGS합>,
 "fxKrw":<FX krw합>,"totalCash":<총현금>,"loan":<LOAN합>,"fxRate":<환산환율>,
 "fx":[{"bank":"<은행명>","acct":"<displayAccountNumber>","ccy":"USD","amount":<balance>,"krw":<krwBalance>}]}
```
`fx[].bank` 는 그 계좌의 실제 은행명을 쓴다 — `bankCode` 기준 `088`=신한 · `004`=국민 · `003`=기업 · `081`=하나.

**3-2. 시크릿과 합쳐 전송한다.** 시크릿도 명령줄 인자로 노출되지 않게 `printf` 로 파일에 합치고, 보낸 뒤 지운다:
```bash
SEC=$(cat "C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret")
PK=$(grep -oE "sb_publishable_[A-Za-z0-9_-]+" "C:/Users/RAWGA/Downloads/rawga-dashboard-git/index.html" | head -1)
SNAP="C:/Users/RAWGA/AppData/Local/Temp/rawga-snap.json"
BODY="C:/Users/RAWGA/AppData/Local/Temp/rawga-body.json"
{ printf '{"secret":"%s","snapshot":' "$SEC"; cat "$SNAP"; printf '}'; } > "$BODY"
curl -s -X POST "https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/bank-snapshot" \
  -H "Authorization: Bearer $PK" -H "apikey: $PK" -H "Content-Type: application/json" \
  --data-binary @"$BODY"
rm -f "$BODY"
```
응답이 `{"ok":true,...}` 가 아니면 실패로 간주하고 오류 내용을 남긴다.

## 4) 요약 남기기
- 정상: `은행 실잔액 <금액>원 반영 (수집 <asOf>)` 한 줄
- 문제 있을 때만 자세히: 커넥터 조회 실패 / 저장 실패 / **수집이 3일 이상 오래됨**(사용자가 app.clobe.ai 에서 직접 재수집 필요 — 이 도구로는 재수집 트리거 불가) / 전 계좌 잔액 0 같은 이상 징후

주의: totalCash가 0 이하이면 Edge가 저장을 거부한다(수집 실패 방어). 그 경우 억지로 재시도하지 말고 원인을 남길 것.

참고: publishable 키로 `cat_data` 를 REST 재조회해 저장을 확인하려 하지 말 것 — RLS가 로그인 사용자만 허용해서 **HTTP 200 + 빈 배열 `[]`** 이 돌아온다(미저장이 아님). Edge 응답 `{"ok":true,...}` 자체가 저장 성공의 근거다.

## 5) 슬랙으로 결과 발송 — 매 실행, 성공·실패 모두
`slack_send_message` 로 **본인 DM** 한 건 발송: `channel_id` = `U0794BSDK43`.

- 정상: `🏦 은행 실잔액 <금액>원 반영 · 수집 <asOf YYYY-MM-DD HH:MM> · 예금 <금액> + 외화 <금액>`
- 이상: 맨 앞에 `⚠️` 를 붙이고 **무엇이 실패했는지 + 사람이 할 조치**를 한 줄 덧붙인다.
  (예: 수집 3일 경과 → `app.clobe.ai 에서 직접 재수집 필요`)
- **시크릿·계좌번호는 넣지 말 것.** 금액·수집시각·은행명까지만.
- 발송이 실패해도 이미 저장된 스냅샷은 유효하다. 재시도는 1회만 하고 안 되면 세션 요약에만 남긴다.
- 조회 자체가 안 돼 3단계까지 못 갔더라도 **슬랙은 보낸다** — 조용하면 정상인지 태스크가 죽은 건지 구분이 안 되기 때문.
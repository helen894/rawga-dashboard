# 2026-08-24 잔액 3.29억 급감 — 원인: `settings` 통째 덮어쓰기로 `cf_start` 소실

## 증상

대표님: "갑자기 잔액이 328,587,457원이 빠짐".

## 원인

`cat_data` 의 `settings` 행이 **`{ init_cash: 148963934 }` 만 남아 있었다.** `cf_start` 가 없다.

`cf_start` 가 없으면 `initCashEff()` 는 첫 줄에서 그냥 `INIT_CASH` 를 돌려준다:

```js
function initCashEff() {
  if (!CF_START) return INIT_CASH;      // ← 여기서 빠져나감
  ...
  return INIT_CASH - pre;               // 원래는 시작일 이전 행 효과를 걷어냄
}
```

`INIT_CASH` 는 **클로브 2026-01-01 개시 잔액**이라 2026년 이전 행이 있으면 안 되는데,
`cf_data` 에는 2025년 라오스 4건이 남아 있다:

| 날짜 | 금액 | 적요 |
|---|---|---|
| 2025-10-24 | −80,477,097 | SUNJIN ST IMPORT EXPORT |
| 2025-10-24 | −43,127,357 | MEUANGLAO FOODS SUPPLIES |
| 2025-10-24 | −10,088,585 | BLOOMING HOLDINGS |
| 2025-12-02 | −194,895,222 | RAWGA SOLE CO., LTD |
| | **−328,588,261** | |

이 4건이 잔액에서 다시 빠져 **−328,588,261** 만큼 낮게 나왔다. 대표님이 말한 328,587,457
과는 804원 차이인데, 그 사이 외화 스냅샷 갱신(8/22)과 신규 행이 섞인 값이라 별도 결함이 아니다.

## 왜 지워졌나 — 저장 경로가 객체를 통째로 갈아엎었다

두 곳 모두 `settings` 를 **새 객체로 대체**했다. `cf_start` 는 UI 입력칸이 없어 그대로 소멸한다.

| 위치 | 코드 | 언제 실행되나 |
|---|---|---|
| `saveCatDataToSupabase` | `{ key: 'settings', data: { init_cash: INIT_CASH } }` | **분류 작업할 때마다** (학습 매핑 저장과 묶여 있음) |
| 기초잔액 모달 저장 버튼 | `upsert({ key: 'settings', data: { init_cash: val } })` | 기초잔액 수정 시 |

앞의 것이 자주 돌기 때문에 사실상 **시간 문제였다.** `setMeta` Edge 액션은 경로 단위로
값을 넣어 형제 키를 보존하므로, 그쪽으로 넣은 값이 UI 저장 한 번에 날아가는 구조였다.

## 조치

1. **`cf_start` 복구** — `setMeta { "settings.cf_start": "2026-01-01" }`.
   확인: `settings = {"cf_start":"2026-01-01","init_cash":148963934}`
2. **두 저장 경로를 병합 저장으로 교체** — `SETTINGS_RAW`(서버 원본)를 들고 있다가
   `{ ...SETTINGS_RAW, init_cash: ... }` 로 쓴다. 앞으로 추가되는 키도 자동 보존된다.
3. **미로드 보호** — `SETTINGS_RAW = null`(서버에서 아직 못 읽음)이면 **아예 저장하지 않는다.**
   병합할 원본이 없는 상태로 쓰면 똑같은 사고가 나기 때문이다. 모달은 이 경우 로컬 저장만
   하고 새로고침을 안내한다.

## 검증

- `node scripts/test-settings-merge.mjs` → **12/12**
  (구조 검사 + 기능 검사. `key: 'settings'` 로 쓰는 지점이 하나라도 `...SETTINGS_RAW` 없이
  객체를 쓰면 실패한다 — 새 저장 경로가 생겨도 걸린다.)
- `node scripts/verify-daily-balance-vs-clobe.mjs` → 레벨 차이 **2025-12-31 0 · 2026-08-23 402원**
  (사고 이전과 동일한 정상값)

## 교훈

**잔액 대조 카드가 이 사고를 잡을 수 있었다.** cf_start 가 사라지면 대조 차이가 402원 →
−3.29억으로 튄다. 카드가 빨갛게 벌어져 있으면 데이터가 아니라 **설정이 날아갔는지** 먼저 본다.

그리고 `cat_data` 의 어떤 행이든 **JSON 객체를 통째로 upsert 하는 코드는 그 행의 미지의 키를
지운다.** 새 저장 경로를 만들 때는 반드시 읽어온 원본을 펼쳐 병합할 것.

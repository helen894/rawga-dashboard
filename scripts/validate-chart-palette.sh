#!/usr/bin/env bash
# 자산 추이 차트(renderAssetMixChart) 계열색 검증.
#
# 왜 스크립트로 두는가: 색을 눈으로 판단하면 반드시 틀린다. 실제로 이 차트는
#   · 종전 팔레트에서 세종F2 대비 2.74:1 · 라오스 2.11:1 로 3:1 미달이었고(2026-08-24 발견)
#   · 브랜드 딥그린 #314840 을 계열색으로 쓰려다 채도 0.032 '회색으로 읽힘' 으로 걸렀고
#   · 테라코타↔오커가 정상시력 ΔE 10.6 으로 인접 불가임을 계산으로 알아냈다.
# 색을 바꾸기 전에 반드시 이걸 돌린다.
#
# ⚠ 순서가 검사에 들어간다 — 인접한 두 계열끼리 구분도를 본다.
#   스택 순서(현금 → 매출채권 → 세종F2 → 라오스)와 같게 넘겨야 의미가 있다.
# ⚠ 현재 조합은 세종↔채권 ΔE 6.1(경고 대역)이라 **끝점 직접 라벨이 필수**다.
#   라벨을 지우려면 색을 다시 골라 이 검사를 통과시켜야 한다.
set -euo pipefail
PAL="${1:-#2A7F57,#C24A38,#00785E,#9E6A15}"
V="$(ls -d "$HOME"/AppData/Local/Temp/claude/bundled-skills/*/*/dataviz 2>/dev/null | head -1)"
if [ -z "$V" ]; then
  echo "dataviz 검증기를 찾지 못했습니다. Claude 세션에서 dataviz 스킬을 한 번 불러오면 받아집니다." >&2
  exit 2
fi
echo "팔레트: $PAL  (현금 · 매출채권 · 세종F2 · 라오스 순서)"
node "$V/scripts/validate_palette.js" "$PAL" --mode light

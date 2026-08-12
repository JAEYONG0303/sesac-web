"""장기요양보험 급여 분석.

지정한 시도의
  1) 2024년 공단부담금과 수급자 수, 노인 1인당 급여
  2) 노인 1인당 급여가 높은 시도 상위 5곳
를 출력한다.

사용법:
    python analyze_ltc.py              # 기본값: 서울특별시
    python analyze_ltc.py 경기도
"""

import sys
from pathlib import Path

import pandas as pd

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_SIDO = "서울특별시"
LATEST_YEAR = 2024
BASE_YEAR = 2010
TOP_N = 5

XLSX_CANDIDATES = [
    BASE_DIR / "data" / "장기요양_최종.xlsx",
    BASE_DIR.parent / "data" / "장기요양_최종.xlsx",
]

SHEET = "01_시도패널"


def find_xlsx():
    for path in XLSX_CANDIDATES:
        if path.exists():
            return path
    return None


def to_jo(cheonwon):
    """천원 단위를 조원으로."""
    return cheonwon / 1e9


def to_manwon_per_person(cheonwon, people):
    """천원 총액을 1인당 만원으로."""
    return cheonwon / people / 10


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SIDO

    xlsx_path = find_xlsx()
    if xlsx_path is None:
        print("엑셀 파일을 찾을 수 없습니다. 확인한 경로:", file=sys.stderr)
        for path in XLSX_CANDIDATES:
            print(f"  - {path}", file=sys.stderr)
        return 1

    panel = pd.read_excel(xlsx_path, sheet_name=SHEET)

    if target not in set(panel.region):
        print(f"'{target}'를 찾을 수 없습니다. 사용 가능한 시도:", file=sys.stderr)
        print("  " + ", ".join(sorted(panel.region.unique())), file=sys.stderr)
        return 1

    latest = panel[panel.year == LATEST_YEAR].copy()
    latest["per_elder"] = to_manwon_per_person(latest.ltc_real2024, latest.pop_65plus)

    # 1) 전국 요약 — 정책 규모가 얼마나 커졌는지
    nation_now = to_jo(latest.ltc_real2024.sum())
    nation_base = to_jo(panel[panel.year == BASE_YEAR].ltc_real2024.sum())

    print(f"파일: {xlsx_path.name}")
    print(f"[전국] {LATEST_YEAR}년 장기요양 공단부담금 {nation_now:.1f}조원 "
          f"— {BASE_YEAR}년 {nation_base:.1f}조원의 {nation_now / nation_base:.1f}배")
    print()

    # 2) 선택한 시도
    row = latest[latest.region == target].iloc[0]
    print(f"[{target}] {LATEST_YEAR}년")
    print(f"  공단부담금     : {to_jo(row.ltc_real2024):.2f}조원")
    print(f"  급여이용 수급자 : {int(row.recipients):,}명")
    print(f"  65세 이상 인구  : {int(row.pop_65plus):,}명 (고령화율 {row.aging_rate:.1f}%)")
    print(f"  노인 1인당 급여 : {row.per_elder:.0f}만원")
    print()

    # 3) 노인 1인당 급여 상위 5개 시도
    top = latest.sort_values("per_elder", ascending=False).head(TOP_N)
    print(f"[노인 1인당 급여 상위 {TOP_N}개 시도]")
    print(f"{'시도':<12} {'노인 1인당 급여(만원)':>20} {'고령화율(%)':>12}")
    print("-" * 48)
    for _, r in top.iterrows():
        print(f"{r.region:<12} {r.per_elder:>20.0f} {r.aging_rate:>12.1f}")

    return 0


if __name__ == "__main__":
    sys.exit(main())

"""서울 아파트 실거래 분석 (표준 라이브러리만 사용).

지정한 자치구의
  1) 평균 거래금액과 거래건수  (실습3)
  2) 최고가 상위 5건            (실습4)
를 출력한다.

사용법:
    python analyze.py            # 기본값: 노원구
    python analyze.py 강남구
"""

import csv
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_GU = "노원구"
TOP_N = 5

# 이 파일 옆의 data/ 폴더를 먼저 찾고, 없으면 상위 폴더의 data/를 쓴다
CSV_CANDIDATES = [
    BASE_DIR / "data" / "seoul_apt_2026H1.csv",
    BASE_DIR / "data" / "seoul-apt-latest.csv",
    BASE_DIR.parent / "data" / "seoul-apt-latest.csv",
]

# 헤더가 한글이든 영문이든 같은 항목으로 인식하도록 후보를 나열
GU_ALIASES = ("자치구명", "gu")
COMPLEX_ALIASES = ("건물명", "complex")
DATE_ALIASES = ("계약일", "contract_date")
PRICE_ALIASES = ("물건금액(만원)", "price")


def find_csv():
    for path in CSV_CANDIDATES:
        if path.exists():
            return path
    return None


def open_csv(path):
    """UTF-8로 열어보고 실패하면 CP949로 재시도."""
    for encoding in ("utf-8-sig", "cp949"):
        try:
            f = open(path, newline="", encoding=encoding)
            f.readline()   # 헤더를 한 줄 읽어 인코딩이 맞는지 확인
            f.seek(0)
            return f
        except UnicodeDecodeError:
            f.close()
    raise UnicodeDecodeError("파일 인코딩을 UTF-8/CP949로 해석할 수 없습니다.")


def resolve_column(fieldnames, aliases, label):
    """실제 헤더에서 해당 항목의 컬럼명을 찾는다."""
    for name in aliases:
        if name in fieldnames:
            return name
    raise KeyError(f"'{label}' 컬럼을 찾을 수 없습니다. (헤더: {', '.join(fieldnames)})")


def parse_price(raw):
    """'85,000' 같은 문자열을 숫자로. 비어 있거나 숫자가 아니면 None."""
    if raw is None:
        return None
    cleaned = raw.strip().replace(",", "")
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def format_date(raw):
    """'20260101' 형식이면 '2026-01-01'로 바꾼다."""
    if len(raw) == 8 and raw.isdigit():
        return f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
    return raw


def collect_deals(csv_path, target_gu):
    """해당 자치구의 거래를 (금액, 건물명, 계약일) 목록으로 모은다."""
    deals = []
    skipped = 0

    # 행이 많아 전체를 메모리에 올리지 않고 한 줄씩 훑는다
    with open_csv(csv_path) as f:
        reader = csv.DictReader(f)
        gu_col = resolve_column(reader.fieldnames, GU_ALIASES, "자치구명")
        complex_col = resolve_column(reader.fieldnames, COMPLEX_ALIASES, "건물명")
        date_col = resolve_column(reader.fieldnames, DATE_ALIASES, "계약일")
        price_col = resolve_column(reader.fieldnames, PRICE_ALIASES, "물건금액(만원)")

        for row in reader:
            if (row.get(gu_col) or "").strip() != target_gu:
                continue

            price = parse_price(row.get(price_col))
            if price is None:
                skipped += 1
                continue

            deals.append((
                price,
                (row.get(complex_col) or "").strip(),
                format_date((row.get(date_col) or "").strip()),
            ))

    return deals, skipped


def main():
    target_gu = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_GU

    csv_path = find_csv()
    if csv_path is None:
        print("CSV 파일을 찾을 수 없습니다. 확인한 경로:", file=sys.stderr)
        for path in CSV_CANDIDATES:
            print(f"  - {path}", file=sys.stderr)
        return 1

    deals, skipped = collect_deals(csv_path, target_gu)

    if not deals:
        print(f"{target_gu} 거래 내역이 없습니다.")
        return 0

    # 1) 평균과 건수
    average_manwon = sum(price for price, _, _ in deals) / len(deals)
    average_eok = round(average_manwon / 10000, 1)

    print(f"파일: {csv_path.name}")
    print(f"{target_gu} 평균 거래가: {average_eok}억, 거래건수: {len(deals):,}건")

    # 2) 최고가 상위 5건
    deals.sort(key=lambda deal: deal[0], reverse=True)
    print()
    print(f"[최고가 상위 {TOP_N}건]")
    print(f"{'건물명':<24} {'물건금액(만원)':>14}  {'계약일'}")
    print("-" * 55)
    for price, complex_name, contract_date in deals[:TOP_N]:
        print(f"{complex_name:<24} {price:>14,.0f}  {contract_date}")

    if skipped:
        print()
        print(f"(금액이 비어 있어 제외한 행: {skipped:,}건)")

    return 0


if __name__ == "__main__":
    sys.exit(main())

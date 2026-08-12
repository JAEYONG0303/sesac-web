"""장기요양_최종.xlsx → 대시보드용 data.json 추출.

엑셀을 브라우저에서 직접 읽을 수 없으므로, 대시보드가 쓸 지표만 골라
가벼운 JSON으로 미리 뽑아 둔다. 이 스크립트는 데이터가 갱신될 때만 실행하면 된다.

사용법:
    python prepare_data.py
"""

import json
import sys
from pathlib import Path

import pandas as pd

BASE_DIR = Path(__file__).resolve().parent
OUT_PATH = BASE_DIR / "data.json"

XLSX_CANDIDATES = [
    BASE_DIR / "data" / "장기요양_최종.xlsx",
    BASE_DIR.parent / "data" / "장기요양_최종.xlsx",
]

# 17개 시도를 사각형 격자에 배치한 카토그램 좌표 (col, row) — 실제 지리 배치를 단순화
GRID = {
    "경기도": (2, 0), "강원특별자치도": (3, 0),
    "인천광역시": (1, 1), "서울특별시": (2, 1),
    "충청남도": (1, 2), "세종특별자치시": (2, 2), "충청북도": (3, 2), "경상북도": (4, 2),
    "대전광역시": (2, 3), "대구광역시": (4, 3),
    "전북특별자치도": (1, 4), "경상남도": (3, 4), "울산광역시": (4, 4),
    "전라남도": (1, 5), "광주광역시": (2, 5), "부산광역시": (4, 5),
    "제주특별자치도": (0, 6),
}

SHORT = {
    "서울특별시": "서울", "부산광역시": "부산", "대구광역시": "대구", "인천광역시": "인천",
    "광주광역시": "광주", "대전광역시": "대전", "울산광역시": "울산", "세종특별자치시": "세종",
    "경기도": "경기", "강원특별자치도": "강원", "충청북도": "충북", "충청남도": "충남",
    "전북특별자치도": "전북", "전라남도": "전남", "경상북도": "경북", "경상남도": "경남",
    "제주특별자치도": "제주",
}


def find_xlsx():
    for path in XLSX_CANDIDATES:
        if path.exists():
            return path
    return None


def safe(value):
    """NaN을 None으로 바꿔 JSON에 담을 수 있게 한다."""
    if pd.isna(value):
        return None
    return round(float(value), 4)


def main():
    xlsx_path = find_xlsx()
    if xlsx_path is None:
        print("엑셀 파일을 찾을 수 없습니다. 확인한 경로:", file=sys.stderr)
        for path in XLSX_CANDIDATES:
            print(f"  - {path}", file=sys.stderr)
        return 1

    panel = pd.read_excel(xlsx_path, sheet_name="01_시도패널")
    mix = pd.read_excel(xlsx_path, sheet_name="04_급여구성비")

    rows = []
    for _, r in panel.iterrows():
        total = r.ltc_real2024          # 공단부담금, 천원, 2024년 불변가격
        home, inst = r.ltc_real_home, r.ltc_real_inst

        # 경증(5등급)은 2014.7, 인지지원등급은 2018년 신설이라 그 이전은 NaN.
        # 제도가 없었던 것이므로 0으로 두어야 중증 비중이 100%로 바르게 나온다.
        severe = r.ltc_real_severe
        mild = 0.0 if pd.isna(r.ltc_real_mild) else r.ltc_real_mild
        cognitive = 0.0 if pd.isna(r.ltc_real_cognitive) else r.ltc_real_cognitive
        by_grade = (0.0 if pd.isna(severe) else severe) + mild + cognitive

        rows.append({
            "region": r.region,
            "short": SHORT.get(r.region, r.region),
            "year": int(r.year),
            # 금액은 억원으로 통일 (천원 → 억원)
            "total": safe(total / 1e5),
            "home": safe(home / 1e5),
            "inst": safe(inst / 1e5),
            "recipients": safe(r.recipients),
            "pop65": safe(r.pop_65plus),
            "agingRate": safe(r.aging_rate),
            # 파생 지표
            "perElder": safe(total / r.pop_65plus / 10) if pd.notna(r.pop_65plus) else None,
            "perRecipient": safe(total / r.recipients / 10) if pd.notna(r.recipients) else None,
            "coverage": safe(r.recipients / r.pop_65plus * 100) if pd.notna(r.pop_65plus) else None,
            "homeShare": safe(home / (home + inst) * 100) if pd.notna(home) else None,
            "severeShare": safe(severe / by_grade * 100) if pd.notna(severe) and by_grade else None,
        })

    payload = {
        "meta": {
            "source": "국민건강보험공단 「장기요양보험 통계연보」 3-1표, 통계청 인구 자료",
            "period": [int(panel.year.min()), int(panel.year.max())],
            "priceBase": "2024년 불변가격",
            "unitNote": "금액 단위는 억원. 1인당 지표는 만원.",
            "regionCount": int(panel.region.nunique()),
        },
        "grid": {region: {"col": c, "row": r} for region, (c, r) in GRID.items()},
        "panel": rows,
        "mix": [
            {
                "year": int(m.연도),
                "home": safe(m["재가%"]), "inst": safe(m["시설%"]),
                "severe": safe(m["중증%"]), "mild": safe(m["경증%"]),
                "cognitive": safe(m["인지지원%"]),
            }
            for _, m in mix.iterrows()
        ],
    }

    OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    size_kb = OUT_PATH.stat().st_size / 1024
    print(f"[저장] {OUT_PATH.name}  ({size_kb:.0f} KB)")
    print(f"  패널 {len(rows)}행 · {payload['meta']['regionCount']}개 시도 "
          f"· {payload['meta']['period'][0]}~{payload['meta']['period'][1]}년")
    print(f"  구성비 {len(payload['mix'])}행")

    missing = [r["region"] for r in rows if r["total"] is None]
    if missing:
        print(f"  주의: 급여액 결측 {len(missing)}행")

    return 0


if __name__ == "__main__":
    sys.exit(main())

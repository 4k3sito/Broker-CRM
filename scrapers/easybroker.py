"""
easybroker_scraper.py — fetches commercial properties (rent + sale) and
land (sale) from the EasyBroker API filtered to Monterrey, MX.

Run standalone:
    python3 easybroker_scraper.py          # prints results, writes output/easybroker.json
Run via scrape_all.py:
    python3 scrape_all.py easybroker
"""
import json
import os
import time
from pathlib import Path

import requests

# ── Load .env from parent directory (mirrors fetch-easybroker.js behaviour) ─
_env_file = Path(__file__).parent.parent / ".env"
if _env_file.exists():
    for _line in _env_file.read_text("utf-8").splitlines():
        _eq = _line.find("=")
        if _eq < 1:
            continue
        _key = _line[:_eq].strip()
        _val = _line[_eq + 1:].strip().strip('"').strip("'")
        if _key and _key not in os.environ:
            os.environ[_key] = _val

API_KEY = os.environ.get("EASYBROKER_API_KEY")
if not API_KEY:
    raise RuntimeError(
        "EASYBROKER_API_KEY no encontrada. Agrega la variable a tu archivo .env"
    )

BASE = "https://api.easybroker.com/v1"
PER_PAGE = 50
CITY = "Monterrey"

# Each entry defines one paginated search pass.
# A property may match several passes (e.g. listed for both rent and sale); it
# is fetched only once and stored as a single record (external_id = public_id).
# The operation used for price is chosen in normalize_easybroker (rental first).
TARGETS = [
    {
        "label": "Locales comerciales en renta",
        "property_types": ["Local comercial"],
        "operation_type": "rental",
    },
    {
        "label": "Locales comerciales en venta",
        "property_types": ["Local comercial"],
        "operation_type": "sale",
    },
    {
        "label": "Terrenos en venta",
        "property_types": ["Terreno"],
        "operation_type": "sale",
    },
]

_session = requests.Session()
_session.headers.update({"X-Authorization": API_KEY, "Accept": "application/json"})


def _get(url: str, params: dict = None) -> dict:
    resp = _session.get(url, params=params, timeout=30)
    if resp.status_code == 401:
        raise RuntimeError("API Key inválida o sin permisos.")
    resp.raise_for_status()
    return resp.json()


def _fetch_page(params: dict, page: int) -> dict:
    return _get(f"{BASE}/properties", params={**params, "page": page, "limit": PER_PAGE})


def _fetch_all_basics(base_params: dict) -> list[dict]:
    results = []
    page = 1
    total_pages = 1

    while page <= total_pages:
        data = _fetch_page(base_params, page)
        items = data.get("content") or []

        if page == 1:
            total = (data.get("pagination") or {}).get("total", len(items))
            total_pages = max(1, -(-total // PER_PAGE))
            print(f"    Total: {total} propiedades — {total_pages} página(s)")

        results.extend(items)
        print(f"    Página {page}/{total_pages} — {len(items)} props (acum: {len(results)})")
        page += 1
        if page <= total_pages:
            time.sleep(0.3)

    return results


def _fetch_detail(public_id: str) -> dict | None:
    try:
        detail = _get(f"{BASE}/properties/{public_id}")
        time.sleep(0.15)
        return detail
    except Exception as exc:
        print(f"      Sin detalle {public_id}: {exc}")
        return None


def run() -> list[dict]:
    all_records = []
    seen_ids = set()  # public_ids ya capturados; evita duplicados entre pasadas

    for target in TARGETS:
        print(f"\n  [{target['label']}]")

        params = {
            "search[cities][]": CITY,
            "search[operation_types][]": target["operation_type"],
            "search[property_types][]": target["property_types"],
        }

        basics = _fetch_all_basics(params)
        print(f"    Obteniendo detalles de {len(basics)} propiedades…")

        for i, basic in enumerate(basics, 1):
            pid = basic.get("public_id", "")
            print(f"\r      [{i}/{len(basics)}] {pid}   ", end="", flush=True)
            if pid and pid in seen_ids:
                continue  # ya capturada en otra pasada
            seen_ids.add(pid)
            detail = _fetch_detail(pid)
            all_records.append(detail or basic)

        print()

    print(f"\n  Total registros obtenidos: {len(all_records)}")
    return all_records


if __name__ == "__main__":
    records = run()
    out = Path(__file__).parent / "output" / "easybroker.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  Guardados {len(records)} → {out}")

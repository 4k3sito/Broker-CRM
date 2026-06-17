"""
scrape_all.py — unified runner for all property scrapers.

Usage:
    python scrape_all.py              # run all scrapers
    python scrape_all.py inmuebles24  # run a single source
    python scrape_all.py lamudi propiedadesmexico

Each scraper is run sequentially. Normalized records are upserted into
PostgreSQL (must be running via docker-compose or at DATABASE_URL).
User-managed fields (status, starred, notes) are never overwritten.
"""
import sys

from dotenv import load_dotenv
load_dotenv()

from scrapers import inmuebles24, lamudi, propiedadesmx, easybroker
from scrapers.normalize import (
    normalize_inmuebles24,
    normalize_lamudi,
    normalize_propiedadesmexico,
    normalize_easybroker,
)
from scrapers.db_writer import ensure_schema, upsert_batch


SCRAPERS = {
    "inmuebles24": {
        "mod":        inmuebles24,
        "normalizer": normalize_inmuebles24,
        "label":      "Inmuebles24",
    },
    "lamudi": {
        "mod":        lamudi,
        "normalizer": normalize_lamudi,
        "label":      "Lamudi",
    },
    "propiedadesmexico": {
        "mod":        propiedadesmx,
        "normalizer": normalize_propiedadesmexico,
        "label":      "PropiedadesMX",
    },
    "easybroker": {
        "mod":        easybroker,
        "normalizer": normalize_easybroker,
        "label":      "EasyBroker",
    },
}


def run_scraper(key: str):
    cfg = SCRAPERS[key]
    print(f"\n{'='*60}")
    print(f"  {cfg['label']} — iniciando scraper…")
    print(f"{'='*60}")

    raw_records = cfg["mod"].run()
    print(f"  {len(raw_records)} registros obtenidos del scraper")

    normalized = []
    for r in raw_records:
        try:
            normalized.append(cfg["normalizer"](r))
        except Exception as e:
            print(f"  ⚠️  Error normalizando registro: {e}")

    print(f"  {len(normalized)} registros normalizados — guardando en BD…")
    inserted, updated = upsert_batch(normalized)
    print(f"  ✅ {cfg['label']}: {inserted} nuevos, {updated} actualizados")
    return inserted, updated


def main():
    targets = sys.argv[1:] or list(SCRAPERS.keys())

    unknown = [t for t in targets if t not in SCRAPERS]
    if unknown:
        print(f"Error: fuentes desconocidas: {unknown}")
        print(f"Fuentes válidas: {list(SCRAPERS.keys())}")
        sys.exit(1)

    print("\n🏠  OfficeScrapper — runner multi-sitio")
    print(f"   Fuentes: {', '.join(targets)}\n")

    print("Verificando/migrando esquema de BD…")
    ensure_schema()
    print("Esquema OK.\n")

    total_inserted = total_updated = 0
    for key in targets:
        ins, upd = run_scraper(key)
        total_inserted += ins
        total_updated += upd

    print(f"\n{'='*60}")
    print(f"  LISTO — {total_inserted} nuevos | {total_updated} actualizados")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()

import json
import re
import sys
from datetime import datetime
from pathlib import Path

from database import engine, SessionLocal
from models import Base, Listing

DATA_PATH = Path("/app/output/scrape.json")


def parse_price(price_str: str):
    if not price_str:
        return None, None
    currency = None
    if "MN" in price_str or "MXN" in price_str:
        currency = "MXN"
    elif "USD" in price_str or "$" in price_str:
        currency = "USD"
    numbers = re.findall(r"[\d,]+(?:\.\d+)?", price_str)
    if numbers:
        try:
            return float(numbers[-1].replace(",", "")), currency
        except ValueError:
            pass
    return None, currency


def parse_size(features: list):
    if not features:
        return None
    for feat in features:
        # "234 m² lote", "7 a 30 m² lote", "35 m2"
        match = re.search(r"(\d+(?:\.\d+)?)\s*(?:a\s*(\d+(?:\.\d+)?)\s*)?m[²2]", feat)
        if match:
            lo = float(match.group(1))
            hi = float(match.group(2)) if match.group(2) else lo
            return (lo + hi) / 2
    return None


def parse_date(date_str: str):
    if not date_str:
        return None
    for fmt in ("%m/%d/%y", "%d/%m/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(date_str, fmt).date()
        except ValueError:
            continue
    return None


def main():
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    try:
        if db.query(Listing).count() > 0:
            print("Data already imported, skipping.")
            return

        if not DATA_PATH.exists():
            print(f"Archivo de datos no encontrado: {DATA_PATH}, omitiendo importación.")
            return

        with open(DATA_PATH) as f:
            raw = json.load(f)

        # Flatten: the file is a list of lists
        records = []
        for item in raw:
            if isinstance(item, list):
                records.extend(item)
            elif isinstance(item, dict):
                records.append(item)

        listings = []
        for r in records:
            price_num, currency = parse_price(r.get("price"))
            features = r.get("features") or []
            country_obj = r.get("countryOfOrigin")
            country = country_obj.get("name") if isinstance(country_obj, dict) else None

            listings.append(Listing(
                url=r.get("url"),
                broker_name=r.get("name"),
                description=r.get("description"),
                price_raw=r.get("price"),
                price_numeric=price_num,
                currency=currency,
                features=features if features else None,
                property_size_m2=parse_size(features),
                transaction_type=r.get("transaction_type"),
                date_posted=parse_date(r.get("datePosted")),
                location=r.get("location"),
                image=r.get("image"),
                posting_type=r.get("posting_type"),
                publisher_logo=r.get("publisher_logo"),
                country=country,
            ))

        db.bulk_save_objects(listings)
        db.commit()
        print(f"Imported {len(listings)} listings.")
    finally:
        db.close()


if __name__ == "__main__":
    main()

"""
Upsert normalized listing records into Supabase.

Matches on (source, external_id). Never overwrites status/starred/notes.
Requires env vars:
    SUPABASE_URL         (defaults to the project URL)
    SUPABASE_SERVICE_KEY (service-role key — bypasses RLS)
"""
import os
from datetime import date, datetime

from supabase import create_client, Client

SUPABASE_URL = os.environ.get(
    "SUPABASE_URL", "https://fbtyjwpeymnguetrcwzt.supabase.co"
)
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

_client: Client | None = None

_USER_FIELDS = {"status", "starred", "notes", "id"}


def _get_client() -> Client:
    global _client
    if _client is None:
        if not SUPABASE_SERVICE_KEY:
            raise RuntimeError(
                "Falta la variable de entorno SUPABASE_SERVICE_KEY"
            )
        _client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    return _client


def _serialize(record: dict) -> dict:
    """Convert date/datetime values to ISO strings for the REST API."""
    out = {}
    for k, v in record.items():
        if isinstance(v, datetime):
            out[k] = v.isoformat()
        elif isinstance(v, date):
            out[k] = v.isoformat()
        else:
            out[k] = v
    return out


def ensure_schema():
    """No-op: schema is managed in Supabase directly."""
    pass


def upsert_listing(record: dict) -> str:
    """
    Insert or update a listing. Returns 'inserted' or 'updated'.
    Never touches status/starred/notes on existing rows.
    """
    client = _get_client()
    source = record.get("source")
    external_id = record.get("external_id")

    existing = None
    if source and external_id:
        res = (
            client.table("listings")
            .select("id")
            .eq("source", source)
            .eq("external_id", external_id)
            .maybe_single()
            .execute()
        )
        existing = res.data if res is not None else None

    if existing is None and record.get("url"):
        res = (
            client.table("listings")
            .select("id")
            .eq("url", record["url"])
            .maybe_single()
            .execute()
        )
        existing = res.data if res is not None else None

    payload = _serialize(record)

    if existing:
        update_data = {k: v for k, v in payload.items() if k not in _USER_FIELDS}
        client.table("listings").update(update_data).eq("id", existing["id"]).execute()
        return "updated"
    else:
        insert_data = {k: v for k, v in payload.items() if k != "id"}
        insert_data.setdefault("status", "new")
        insert_data.setdefault("starred", False)
        insert_data.setdefault("notes", None)
        client.table("listings").insert(insert_data).execute()
        return "inserted"


def upsert_batch(records: list[dict], verbose: bool = True) -> tuple[int, int]:
    """Upsert a list of normalized records. Returns (inserted, updated) counts."""
    inserted = updated = 0
    for rec in records:
        result = upsert_listing(rec)
        if result == "inserted":
            inserted += 1
        else:
            updated += 1
    if verbose:
        print(f"  → {inserted} insertados, {updated} actualizados")
    return inserted, updated

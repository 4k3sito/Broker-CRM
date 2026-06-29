from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import distinct
from typing import Optional, List
from datetime import date

from database import get_db
from models import Listing
from schemas import ListingResponse, ListingUpdate, PaginatedListings

app = FastAPI(title="Real Estate Listings API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/listings", response_model=PaginatedListings, summary="List listings with optional filters")
def get_listings(
    transaction_type: Optional[str] = Query(None),
    location: Optional[str] = Query(None),
    source: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    starred: Optional[bool] = Query(None),
    property_type: Optional[str] = Query(None),
    min_price: Optional[float] = Query(None),
    max_price: Optional[float] = Query(None),
    min_size: Optional[float] = Query(None),
    max_size: Optional[float] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    q = db.query(Listing)

    if transaction_type:
        q = q.filter(Listing.transaction_type.ilike(f"%{transaction_type}%"))
    if location:
        q = q.filter(Listing.location.ilike(f"%{location}%"))
    if source:
        q = q.filter(Listing.source == source)
    if status:
        q = q.filter(Listing.status == status)
    if starred is not None:
        q = q.filter(Listing.starred == starred)
    if property_type:
        q = q.filter(Listing.property_type.ilike(f"%{property_type}%"))
    if min_price is not None:
        q = q.filter(Listing.price_numeric >= min_price)
    if max_price is not None:
        q = q.filter(Listing.price_numeric <= max_price)
    if min_size is not None:
        q = q.filter(Listing.property_size_m2 >= min_size)
    if max_size is not None:
        q = q.filter(Listing.property_size_m2 <= max_size)
    if date_from:
        q = q.filter(Listing.date_posted >= date_from)
    if date_to:
        q = q.filter(Listing.date_posted <= date_to)

    total = q.count()
    data = q.order_by(Listing.id).offset((page - 1) * page_size).limit(page_size).all()

    return PaginatedListings(total=total, page=page, page_size=page_size, data=data)


@app.get("/listings/sources", response_model=List[str], summary="List distinct source values")
def get_sources(db: Session = Depends(get_db)):
    rows = db.query(distinct(Listing.source)).filter(Listing.source.isnot(None)).all()
    return sorted(r[0] for r in rows)


@app.get("/listings/{listing_id}", response_model=ListingResponse, summary="Get a single listing by ID")
def get_listing(listing_id: int, db: Session = Depends(get_db)):
    listing = db.query(Listing).filter(Listing.id == listing_id).first()
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")
    return listing


@app.patch("/listings/{listing_id}", response_model=ListingResponse, summary="Update user-managed fields")
def update_listing(listing_id: int, payload: ListingUpdate, db: Session = Depends(get_db)):
    listing = db.query(Listing).filter(Listing.id == listing_id).first()
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(listing, field, value)
    db.commit()
    db.refresh(listing)
    return listing

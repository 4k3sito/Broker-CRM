from pydantic import BaseModel
from typing import Optional, List
from datetime import date, datetime


class ListingResponse(BaseModel):
    id: int
    external_id: Optional[str] = None
    source: Optional[str] = None
    url: Optional[str] = None
    title: Optional[str] = None
    broker_name: Optional[str] = None
    description: Optional[str] = None
    price_raw: Optional[str] = None
    price_numeric: Optional[float] = None
    currency: Optional[str] = None
    price_per_m2: Optional[float] = None
    property_type: Optional[str] = None
    features: Optional[List[str]] = None
    property_size_m2: Optional[float] = None
    transaction_type: Optional[str] = None
    posting_type: Optional[str] = None
    location: Optional[str] = None
    neighborhood: Optional[str] = None
    country: Optional[str] = None
    image: Optional[str] = None
    images: Optional[List[str]] = None
    whatsapp: Optional[str] = None
    maps_url: Optional[str] = None
    publisher_logo: Optional[str] = None
    date_posted: Optional[date] = None
    scraped_at: Optional[datetime] = None
    status: Optional[str] = None
    starred: Optional[bool] = None
    notes: Optional[str] = None

    model_config = {"from_attributes": True}


class ListingUpdate(BaseModel):
    status: Optional[str] = None
    starred: Optional[bool] = None
    notes: Optional[str] = None


class PaginatedListings(BaseModel):
    total: int
    page: int
    page_size: int
    data: List[ListingResponse]

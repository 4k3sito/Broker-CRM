from sqlalchemy import Column, Integer, String, Text, Float, Date, Boolean, DateTime, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY
from database import Base


class Listing(Base):
    __tablename__ = "listings"

    id = Column(Integer, primary_key=True, index=True)
    # Identification
    external_id = Column(String(100), nullable=True, index=True)
    source = Column(String(50), nullable=True, index=True)
    url = Column(Text)
    # Content
    title = Column(String(500), nullable=True)
    broker_name = Column(String(255), index=True)
    description = Column(Text)
    # Pricing
    price_raw = Column(String(255))
    price_numeric = Column(Float, nullable=True, index=True)
    currency = Column(String(10), nullable=True)
    price_per_m2 = Column(Float, nullable=True)
    # Property details
    property_type = Column(String(100), nullable=True)
    features = Column(ARRAY(String), nullable=True)
    property_size_m2 = Column(Float, nullable=True, index=True)
    transaction_type = Column(String(50), index=True)
    posting_type = Column(String(50), nullable=True)
    # Location
    location = Column(String(255), index=True)
    neighborhood = Column(String(255), nullable=True)
    country = Column(String(100), nullable=True)
    # Media & contact
    image = Column(Text, nullable=True)
    images = Column(ARRAY(String), nullable=True)
    whatsapp = Column(String(50), nullable=True)
    maps_url = Column(Text, nullable=True)
    publisher_logo = Column(Text, nullable=True)
    # Dates
    date_posted = Column(Date, nullable=True, index=True)
    scraped_at = Column(DateTime, nullable=True)
    # User tracking — never overwritten by scraper upsert
    status = Column(String(50), nullable=False, server_default="new")
    starred = Column(Boolean, nullable=False, server_default="false")
    notes = Column(Text, nullable=True)

    __table_args__ = (
        UniqueConstraint("source", "external_id", name="uq_source_external_id"),
    )

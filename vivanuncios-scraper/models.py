"""Esquema E2E de validación (Pydantic). Frontera estricta antes de persistir."""
from typing import Optional
from pydantic import BaseModel, Field, HttpUrl


class PropertyListing(BaseModel):
    url: HttpUrl = Field(..., description="URL absoluta del detalle")
    title: str = Field(..., min_length=2)
    price: Optional[float] = Field(None, ge=0.0)        # 'Consultar precio' -> None
    currency: Optional[str] = None                       # MXN / USD
    location: Optional[str] = None
    description: Optional[str] = None
    features: list[str] = Field(default_factory=list)    # recámaras, baños, m2, etc.
    posting_id: Optional[str] = None                     # ID del anuncio (de la URL)
    published: Optional[str] = None                      # fecha/antigüedad de publicación
    photos: list[HttpUrl] = Field(default_factory=list)  # URLs de fotos

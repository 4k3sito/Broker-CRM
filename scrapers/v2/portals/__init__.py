"""One adapter per portal. `PORTALS` is the registry the CLI and cron read."""

from .lamudi import Lamudi
from .mercadolibre import MercadoLibre
from .navent import Inmuebles24, Vivanuncios
from .pincali import Pincali

PORTALS = {p.name: p for p in (Vivanuncios(), Inmuebles24(), MercadoLibre(), Lamudi(), Pincali())}

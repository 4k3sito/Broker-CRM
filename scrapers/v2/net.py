"""Transport: who we leave through, what it cost, and why a request failed.

Three ideas, all measured on 2026-10-08 (see README.md):

1. **Egress ladder.** A portal lists its routes cheapest-first, e.g.
   ("direct", "residential"). Every request starts on the cheapest one and the
   whole portal climbs a rung only when the gate blocks it. Lamudi, Vivanuncios
   and Mercado Libre answer the VPS's own IP, so their proxy bill is zero until
   the day they stop — and that day the run keeps going instead of dying.

2. **The meter reads the wire.** The body is requested undecoded and decompressed
   here, so `Page.wire` is the compressed size the proxy bills. The old meter
   re-gzipped the decoded body and was off by -27% to +43% depending on whether
   the portal serves brotli.

3. **Errors have names.** A 402 from the proxy is the account, not the portal:
   `ProxyDead` aborts the run at once instead of spending 16 retries per URL.
   `Gone` (404/410) is an answer, not a failure, and is never retried.
"""

from __future__ import annotations

import logging
import os
import random
import threading
import time
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import brotli
import zstandard
from curl_cffi import requests as cffi

log = logging.getLogger("v2")

# What Chrome sends. Kept verbatim: the header is part of the fingerprint, and we
# set it by hand only because curl would otherwise decode the body for us.
ACCEPT_ENCODING = "gzip, deflate, br, zstd"


class FetchError(Exception):
    """Transport kept failing after every retry."""


class Blocked(FetchError):
    """The gate refused us on every route this portal is allowed to use."""


class Gone(FetchError):
    """404/410 — the page does not exist. Final; do not retry."""


class ProxyDead(Exception):
    """The proxy itself refused (402 payment, 407 credentials). Not a portal
    problem and not retryable: the run stops and says so."""


@dataclass
class Page:
    status: int
    text: str
    url: str
    wire: int          # compressed body bytes, as billed
    route: str


# Bytes and requests per route, for the whole process. "residential" is the bill.
METER: dict[str, dict[str, int]] = {}
_meter_lock = threading.Lock()
# How far up its ladder each portal has climbed, and when; shared by its workers.
_LEVEL: dict[str, int] = {}
_CLIMBED_AT: dict[str, float] = {}
# TLS fingerprints the portal has refused during this run. Which Chrome build a
# gate accepts is not stable: Inmuebles24 took chrome131 at 20:50 and refused it 7
# times in 8 an hour later, while chrome150 went 8 for 8. So a refusal demotes the
# fingerprint for everyone working that portal, and the next identity picks another.
_REFUSED: dict[str, set[str]] = {}
# A block on the free route is usually a rate window, not a verdict. After this
# long on the paid rung the portal steps back down and tries the cheap one again.
REPROBE_S = 1800.0


def meter(route: str, wire: int) -> None:
    with _meter_lock:
        m = METER.setdefault(route, {"bytes": 0, "requests": 0})
        m["bytes"] += wire
        m["requests"] += 1


def billed_mb() -> float:
    return METER.get("residential", {}).get("bytes", 0) / 1e6


def meter_line() -> str:
    parts = [f"{r}: {m['requests']} req, {m['bytes'] / 1e6:.1f} MB"
             for r, m in sorted(METER.items())]
    return "wire — " + (" · ".join(parts) or "nothing fetched") + \
           f" · proxy bill {billed_mb():.1f} MB"


# --------------------------------------------------------------------------- #
# routes
# --------------------------------------------------------------------------- #
def _env_file() -> dict[str, str]:
    path = Path(os.environ.get("SCRAPERS_ENV") or Path(__file__).resolve().parent.parent / ".env")
    env: dict[str, str] = {}
    try:
        for line in path.read_text().splitlines():
            if line.strip() and not line.lstrip().startswith("#"):
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip()
    except OSError:
        pass
    return env


def residential_template() -> str | None:
    """Proxy URL with a `{session}` slot: a fixed id pins the exit IP, a new id
    changes it. `PROXIES` (any provider) wins over the Apify password."""
    env = _env_file()
    raw = os.environ.get("PROXIES") or env.get("PROXIES") or ""
    pool = [p.strip() for p in raw.split(",") if p.strip()]
    if pool:
        return random.choice(pool)
    if not env.get("PASSWORD"):
        return None
    country = os.environ.get("PROXY_COUNTRY") or env.get("PROXY_COUNTRY") or "MX"
    return (f"http://groups-RESIDENTIAL,country-{country},session-{{session}}"
            f":{env['PASSWORD']}@proxy.apify.com:8000")


def _decoder(encoding: str) -> Callable[[bytes], bytes]:
    """Decompressor for a Content-Encoding."""
    enc = (encoding or "").strip().lower()
    if enc == "br":
        return brotli.Decompressor().process
    if enc == "zstd":
        return zstandard.ZstdDecompressor().decompressobj().decompress
    if enc in ("gzip", "x-gzip"):
        return zlib.decompressobj(16 + zlib.MAX_WBITS).decompress
    if enc == "deflate":
        return zlib.decompressobj().decompress
    return lambda b: b


# --------------------------------------------------------------------------- #
# fetcher
# --------------------------------------------------------------------------- #
class Fetcher:
    """One polite visitor: its own session, exit IP, TLS shape and pacing clock.

    Build one per worker. N fetchers are N visitors each honouring `min_gap`;
    sharing one across threads would be a single IP at N times the rate.
    """

    def __init__(self, portal: str, routes=("direct", "residential"),
                 impersonate=("chrome131",), min_gap: float = 2.5,
                 block_re=None, tries: int = 3) -> None:
        self.portal, self.routes = portal, tuple(routes)
        self.impersonate, self.min_gap = tuple(impersonate), min_gap
        self.block_re, self.tries = block_re, tries
        self._last = 0.0
        self._template = residential_template() if "residential" in self.routes else None
        if "residential" in self.routes and not self._template:
            if self.routes == ("residential",):
                raise ProxyDead("no proxy configured: scrapers/.env has no PASSWORD/PROXIES")
            self.routes = tuple(r for r in self.routes if r != "residential")
        self.rotate()

    # -- identity -----------------------------------------------------------
    @property
    def route(self) -> str:
        level = _LEVEL.get(self.portal, 0)
        if level and time.monotonic() - _CLIMBED_AT.get(self.portal, 0.0) > REPROBE_S:
            level = _LEVEL[self.portal] = level - 1
            log.info("%s: stepping back down to %s to re-test it", self.portal, self.routes[level])
        return self.routes[min(level, len(self.routes) - 1)]

    def rotate(self) -> None:
        """Fresh cookies, TLS shape and (on the proxy) exit IP."""
        self.sess = cffi.Session()
        self.notes: dict = {}       # adapter scratch, tied to this identity
        pool = [i for i in self.impersonate if i not in _REFUSED.get(self.portal, ())]
        if not pool:                # all refused: the gate is the IP's, not the build's
            _REFUSED.pop(self.portal, None)
            pool = list(self.impersonate)
        self._imp = random.choice(pool)
        self._proxy = (self._template.format(session=random.randbytes(6).hex())
                       if self._template and "{session}" in self._template else self._template)

    def _climb(self, why: str) -> bool:
        level = _LEVEL.get(self.portal, 0)
        if level + 1 >= len(self.routes):
            return False
        _LEVEL[self.portal] = level + 1
        _CLIMBED_AT[self.portal] = time.monotonic()
        log.warning("%s: %s on %s — climbing to %s for the rest of the run",
                    self.portal, why, self.routes[level], self.routes[level + 1])
        self.rotate()
        return True

    def _pace(self) -> None:
        gap = self.min_gap * random.uniform(1.0, 1.25)
        wait = gap - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()

    # -- one request --------------------------------------------------------
    def _once(self, url: str, referer, headers, accept, reject) -> Page:
        route = self.route
        proxy = self._proxy if route == "residential" else None
        hdrs = {"Accept-Encoding": ACCEPT_ENCODING, **(headers or {})}
        self._pace()
        try:
            resp = self.sess.get(
                url, impersonate=self._imp, headers=hdrs, referer=referer,
                proxies={"http": proxy, "https": proxy} if proxy else None,
                accept_encoding=None, timeout=45)
        except Exception as exc:  # noqa: BLE001 — curl_cffi raises its own tree
            msg = str(exc)
            if "response 402" in msg or "response 407" in msg:
                raise ProxyDead(f"proxy refused the tunnel ({msg[:90]})") from exc
            raise FetchError(msg[:160]) from exc
        raw = resp.content
        meter(route, len(raw))
        try:
            body = _decoder(resp.headers.get("content-encoding", ""))(raw)
        except Exception as exc:  # noqa: BLE001 — a truncated body is a transport failure
            raise FetchError(f"body decode failed: {str(exc)[:120]}") from exc
        status, text = resp.status_code, body.decode("utf-8", "replace")
        if status in (404, 410):
            raise Gone(f"{status} {url}")
        if (status in (403, 429, 503) or (self.block_re and self.block_re.search(text[:6000]))
                or (reject and reject(text))):
            raise Blocked(f"{status} on {route}")
        if status not in accept:
            raise FetchError(f"HTTP {status}")
        return Page(status, text, str(resp.url), len(raw), route)

    def get(self, url: str, referer: str | None = None, headers: dict | None = None,
            accept=(200,), reject: Callable[[str], bool] | None = None) -> Page:
        """GET with pacing, retry and the ladder. `reject(text)` lets an adapter
        name a gate that answers HTTP 200 (a login wall, a challenge page): a
        True is handled exactly like a 403."""
        err: Exception | None = None
        attempt = 0
        while attempt < self.tries:
            try:
                return self._once(url, referer, headers, accept, reject)
            except (Gone, ProxyDead):
                raise
            except Blocked as exc:
                err = exc
                # Direct has one IP, so the only retry worth making is after a
                # real pause; a second refusal climbs. On the proxy a new identity
                # is a new visitor: rotate and go again, climb when out of tries.
                direct = self.route == "direct"
                if len(self.impersonate) > 1:
                    _REFUSED.setdefault(self.portal, set()).add(self._imp)
                if (direct and attempt >= 1) or attempt == self.tries - 1:
                    if self._climb("blocked"):
                        attempt = 0
                        continue
                if direct:
                    time.sleep(random.uniform(20, 30))
                self.rotate()
            except FetchError as exc:
                err = exc
                if attempt >= 1:
                    self.rotate()   # a dead sticky tunnel cannot be waited out
            attempt += 1
            time.sleep(min(1.5 * 2 ** attempt, 20) + random.uniform(0, 1))
        if isinstance(err, Blocked):
            raise Blocked(f"{url}: {err}")
        raise FetchError(f"{url}: {err}")


def selfcheck() -> None:
    raw = b"<html>" + b"x" * 5000 + b"</html>"
    for enc, packed in (("br", brotli.compress(raw)),
                        ("gzip", zlib.compress(raw, 6, 16 + zlib.MAX_WBITS)),
                        ("zstd", zstandard.ZstdCompressor().compress(raw)),
                        ("", raw)):
        assert _decoder(enc)(packed) == raw, enc
    f = Fetcher("selfcheck", routes=("direct",))
    assert f.route == "direct" and not f._climb("x")
    _LEVEL.pop("t", None)
    g = Fetcher.__new__(Fetcher)
    g.portal, g.routes, g._template, g.impersonate = "t", ("direct", "residential"), None, ("chrome131",)
    logging.disable(logging.WARNING)
    assert g.route == "direct" and g._climb("blocked") and g.route == "residential"
    assert not g._climb("blocked")
    logging.disable(logging.NOTSET)
    _LEVEL.pop("t", None)
    h = Fetcher("t2", routes=("direct",), impersonate=("chrome131", "chrome150"))
    _REFUSED["t2"] = {"chrome131"}
    assert all((h.rotate(), h._imp)[1] == "chrome150" for _ in range(8)), "a refused build must not be picked"
    _REFUSED["t2"] = {"chrome131", "chrome150"}
    h.rotate()
    assert "t2" not in _REFUSED, "when every build is refused the slate is wiped"
    _REFUSED.pop("t2", None)

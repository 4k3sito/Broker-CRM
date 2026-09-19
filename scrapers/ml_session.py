"""Sesión iniciada de Mercado Libre: se saca en local y se sube al VPS.

ML aprueba el login desde la app del celular y **exige que el navegador esté en
la misma red que el teléfono**, así que el login no puede pasar en el VPS. Se
hace aquí, headful, y lo único que viaja al servidor es el `storage_state` de
Playwright (cookies + localStorage): un JSON.

    .venv/bin/python ml_session.py login      # local, abre Chrome; aprueba en el cel
    .venv/bin/python ml_session.py check      # ¿sigue viva? (sirve local y en el VPS)
    .venv/bin/python ml_session.py --selfcheck

Aviso: la sesión nace con la IP de tu casa. ML puede tirarla al verla salir por
la IP del VPS; si pasa, corre `check` allá con el proxy residencial MX del .env
(PROXY/APIFY) en vez de la IP pelona del datacenter.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
STATE = HERE / "data" / "ml_session.json"          # .gitignore: scrapers/data/
PROFILE = HERE / "data" / ".ml-profile"            # perfil persistente del login
LOGIN_URL = "https://www.mercadolibre.com.mx/jms/mlm/lgz/login"
# La sonda es la home, no `myaccount`: las páginas de la cuenta piden
# re-autenticarte (step-up challenge) aunque la sesión esté perfectamente viva,
# así que rebotan al login y mienten. La home sólo trae el nickname si hay sesión.
HOME = "https://www.mercadolibre.com.mx/"
NICK = re.compile(r'"nickname":"([^"]+)"')
VPS = "officelab:/srv/officelab/scrapers/data/ml_session.json"


def _whoami(html: str) -> str | None:
    """El nickname que la home incrusta en su estado inicial, o None si la
    sesión ya no vale (ahí la home sirve «Crea tu cuenta» y no hay nickname)."""
    m = NICK.search(html)
    return m.group(1) if m else None


def login() -> int:
    from patchright.sync_api import sync_playwright

    PROFILE.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        # Perfil persistente: ML marca el dispositivo al aprobar desde el cel, y
        # ese marcaje vive en localStorage/IndexedDB, no sólo en las cookies.
        ctx = p.chromium.launch_persistent_context(
            str(PROFILE), headless=False, channel="chrome",
            viewport=None, locale="es-MX", timezone_id="America/Monterrey",
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(LOGIN_URL, wait_until="domcontentloaded")
        print("Inicia sesión en la ventana (aprueba en el celular).")
        input("Cuando ya estés dentro, regresa aquí y presiona Enter... ")

        page.goto(HOME, wait_until="domcontentloaded")
        quien = _whoami(page.content())
        if not quien:
            print("✗ No quedaste logueado: la home no trae nickname", file=sys.stderr)
            ctx.close()
            return 1
        print(f"Sesión de {quien}.")

        STATE.parent.mkdir(parents=True, exist_ok=True)
        ctx.storage_state(path=str(STATE))
        ctx.close()

    n = len(json.loads(STATE.read_text())["cookies"])
    print(f"✓ Sesión guardada en {STATE} ({n} cookies)\n\nSúbela al VPS:\n"
          f"  scp {STATE} {VPS}\n"
          f"  ssh officelab 'cd /srv/officelab/scrapers && "
          f".venv/bin/python ml_session.py check'")
    return 0


def cookies(state: Path = STATE) -> dict[str, str]:
    """Las cookies del storage_state, listas para curl_cffi/requests."""
    data = json.loads(state.read_text())
    return {c["name"]: c["value"] for c in data["cookies"]
            if "mercadolibre" in c.get("domain", "")}


def check(state: Path = STATE) -> int:
    from stealth_scraper import Scraper

    s = Scraper()  # sale por el proxy residencial MX del .env, si hay
    s.sess.cookies.update(cookies(state))
    quien = _whoami(s.get(HOME).text)
    print(f"✓ viva: {quien}" if quien else "✗ muerta — hay que volver a hacer login")
    return 0 if quien else 1


def _selfcheck() -> int:
    assert _whoami('...,"nickname":"ALEXANDERREYN","x":1...') == "ALEXANDERREYN"
    assert _whoami("<html>Crea tu cuenta</html>") is None
    fake = HERE / "data" / ".ml_session_selfcheck.json"
    fake.parent.mkdir(parents=True, exist_ok=True)
    fake.write_text(json.dumps({"cookies": [
        {"name": "ssid", "value": "x", "domain": ".mercadolibre.com.mx"},
        {"name": "ruido", "value": "y", "domain": ".google.com"},
    ], "origins": []}))
    assert cookies(fake) == {"ssid": "x"}, "filtró cookies de otro dominio"
    fake.unlink()
    print("✓ selfcheck ok")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("cmd", nargs="?", choices=["login", "check"])
    ap.add_argument("--selfcheck", action="store_true")
    a = ap.parse_args()
    if a.selfcheck:
        sys.exit(_selfcheck())
    if not a.cmd:
        ap.error("falta el comando: login | check")
    sys.exit(login() if a.cmd == "login" else check())

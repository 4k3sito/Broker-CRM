"""Prueba de la barra de filtros con un navegador de verdad.

    OL_URL=http://127.0.0.1:3000 python web/verificar_navegador.py <capturas/> <correo> <contraseña>

Es el complemento de `verificar.py`, que sólo mira clases y marcado estático. Aquí se
inicia sesión, se lee el DOM con `page.evaluate()` **y se guardan capturas**, porque
`CLAUDE.md` es explícito en que medir no basta: `tareas.html` daba `scrollWidth` correcto
con el kanban reducido a 54 px y la página era inservible. Las capturas hay que mirarlas.

Este archivo encontró dos defectos que el DOM solo no habría delatado:

  1. Elegir un municipio cerraba el popover. El manejador de "clic fuera" corría después
     de repintar la lista, así que el elemento clicado ya estaba desprendido del árbol y
     `closest('#fbPop')` devolvía null. Se arregló escuchando `pointerdown`.
  2. La frase bajo la barra decía "Sin filtros: el catálogo completo" mientras los chips
     mostraban Monterrey y dos tipos. La página se contradecía en pantalla.

Ojo con el límite de intentos: seis inicios de sesión seguidos desde la misma IP
devuelven 429. Este script reusa un solo contexto de navegador a propósito.
"""
import os
import sys
from patchright.sync_api import sync_playwright

BASE = os.environ.get("OL_URL", "http://127.0.0.1:3000")
SALIDA = sys.argv[1]
fallos = []

def check(cond, msg):
    print(("  ok   " if cond else "  FALLA ") + msg)
    if not cond:
        fallos.append(msg)

with sync_playwright() as pw:
    nav = pw.chromium.launch(args=["--no-sandbox"])
    ctx = nav.new_context(viewport={"width": 1440, "height": 900})
    pg = ctx.new_page()

    pg.goto(f"{BASE}/login.html", wait_until="networkidle")
    pg.fill("#email", sys.argv[2])
    pg.fill("#password", sys.argv[3])
    pg.click("button[type=submit]")
    pg.wait_for_url(lambda u: "login" not in u, timeout=20000)
    print("sesión iniciada")

    pg.goto(f"{BASE}/index.html", wait_until="networkidle")
    pg.wait_for_selector(".card", timeout=25000)

    # ── Los tres chips existen y arrancan vacíos ──────────────────────────────
    print("\nchips")
    for k, vacio in (("ubicacion", "Todo México"), ("precio", "Cualquiera"), ("tipo", "Todos")):
        v = pg.eval_on_selector(f"#fbv-{k}", "e => e.textContent.trim()")
        check(v == vacio, f"{k} arranca en «{vacio}» (dice «{v}»)")
        check(pg.eval_on_selector(f'.fb-chip[data-f="{k}"] .fb-x', "e => e.hidden"),
              f"{k} sin filtro no muestra la ✕")

    antes = pg.eval_on_selector("#countNum", "e => e.textContent.trim()")
    print(f"\nresultados sin filtros: {antes}")

    # ── Ubicación: buscar, elegir, aplicar ────────────────────────────────────
    print("\nubicación")
    pg.click('.fb-open[data-f="ubicacion"]')
    check(not pg.eval_on_selector("#fbPop", "e => e.hidden"), "el popover abre")
    pg.fill("#fbBuscaLugar", "monterrey")
    pg.wait_for_selector(".fb-sug", timeout=15000)
    n = pg.eval_on_selector_all(".fb-sug", "es => es.length")
    check(n > 0, f"el buscador devuelve municipios ({n})")

    # El borrador NO debe filtrar hasta Aplicar.
    pg.click(".fb-sug")
    check(pg.eval_on_selector("#countNum", "e => e.textContent.trim()") == antes,
          "elegir un municipio no filtra todavía (es borrador)")
    check(pg.eval_on_selector_all(".fb-sel", "es => es.length") == 1, "el municipio elegido se muestra")

    pg.click(".fb-aplica")
    pg.wait_for_function(f"document.querySelector('#countNum').textContent.trim() !== '{antes}'", timeout=25000)
    despues = pg.eval_on_selector("#countNum", "e => e.textContent.trim()")
    etiqueta = pg.eval_on_selector("#fbv-ubicacion", "e => e.textContent.trim()")
    check(despues != antes, f"aplicar sí filtra ({antes} → {despues})")
    check(etiqueta != "Todo México", f"el chip dice el municipio («{etiqueta}»)")
    check(not pg.eval_on_selector('.fb-chip[data-f="ubicacion"] .fb-x', "e => e.hidden"), "aparece la ✕")
    check(pg.eval_on_selector("#fbPop", "e => e.hidden"), "el popover cierra al aplicar")

    # La frase de abajo no puede contradecir a los chips de arriba.
    frase = pg.eval_on_selector("#qbarSentence", "e => e.textContent.trim()")
    check("Sin filtros" not in frase, f"la sentencia no dice «sin filtros» con un filtro puesto: «{frase}»")
    check("Monterrey" in frase, "la sentencia nombra el municipio filtrado")
    check(not pg.eval_on_selector("#qbar-clear", "e => e.hidden"), "aparece «Limpiar» en la barra")

    # ── Esc descarta el borrador ──────────────────────────────────────────────
    print("\nborrador")
    pg.click('.fb-open[data-f="tipo"]')
    pg.click('.fb-caja input[data-tipo="local"]')
    pg.keyboard.press("Escape")
    check(pg.eval_on_selector("#fbPop", "e => e.hidden"), "Esc cierra")
    check(pg.eval_on_selector("#fbv-tipo", "e => e.textContent.trim()") == "Todos",
          "Esc descarta lo marcado, no lo aplica")

    # ── Tipo: sólo los cuatro acordados ───────────────────────────────────────
    print("\ntipo")
    pg.click('.fb-open[data-f="tipo"]')
    tipos = pg.eval_on_selector_all(".fb-caja input", "es => es.map(e => e.dataset.tipo)")
    check(tipos == ["oficina", "local", "bodega", "terreno"], f"los cuatro tipos, en orden: {tipos}")
    pg.click('.fb-caja input[data-tipo="local"]')
    pg.click('.fb-caja input[data-tipo="bodega"]')
    pg.click(".fb-aplica")
    pg.wait_for_timeout(2500)
    check(pg.eval_on_selector("#fbv-tipo", "e => e.textContent.trim()") == "2 tipos",
          "dos tipos se resumen como «2 tipos»")

    # ── Precio: min > max se voltea ───────────────────────────────────────────
    print("\nprecio")
    pg.click('.fb-open[data-f="precio"]')
    pg.click('.fb-seg[data-op="rent"]')
    pg.fill("#fbMin", "90000")
    pg.fill("#fbMax", "10000")
    check(pg.eval_on_selector("#fbMin", "e => e.value") == "90,000", "los miles se escriben solos")
    pg.click(".fb-aplica")
    pg.wait_for_timeout(2500)
    etiqueta = pg.eval_on_selector("#fbv-precio", "e => e.textContent.trim()")
    check("10,000" in etiqueta and etiqueta.index("10,000") < etiqueta.index("90,000"),
          f"mín y máx invertidos se voltean («{etiqueta}»)")

    # ── La ✕ del chip limpia sin abrir ────────────────────────────────────────
    pg.click('.fb-chip[data-f="precio"] .fb-x')
    pg.wait_for_timeout(2500)
    check(pg.eval_on_selector("#fbv-precio", "e => e.textContent.trim()") == "Cualquiera", "la ✕ del chip limpia")
    check(pg.eval_on_selector("#fbPop", "e => e.hidden"), "la ✕ no abre el popover")

    pg.screenshot(path=f"{SALIDA}/fb-1440-claro.png", full_page=False)
    pg.click('.fb-open[data-f="ubicacion"]')
    pg.screenshot(path=f"{SALIDA}/fb-1440-popover.png", full_page=False)
    pg.keyboard.press("Escape")

    # ── Oscuro ────────────────────────────────────────────────────────────────
    pg.evaluate("document.documentElement.setAttribute('data-theme','dark')")
    pg.screenshot(path=f"{SALIDA}/fb-1440-oscuro.png")
    pg.evaluate("document.documentElement.setAttribute('data-theme','light')")

    # ── Teléfono: el popover es hoja inferior ─────────────────────────────────
    print("\nteléfono (390px)")
    pg.set_viewport_size({"width": 390, "height": 780})
    pg.wait_for_timeout(600)
    check(pg.evaluate("document.documentElement.scrollWidth <= 390"), "no desborda a lo ancho")
    pg.click('.fb-open[data-f="ubicacion"]')
    pg.wait_for_timeout(400)
    caja = pg.eval_on_selector("#fbPop", "e => { const r = e.getBoundingClientRect();"
                               " return {pos: getComputedStyle(e).position, abajo: Math.round(r.bottom),"
                               " alto: Math.round(r.height), ancho: Math.round(r.width)}; }")
    print(f"    popover: {caja}")
    check(caja["pos"] == "fixed", "el popover es fijo en el teléfono")
    check(abs(caja["abajo"] - 780) <= 2, "queda pegado al borde inferior")
    check(caja["alto"] > 150, f"tiene alto usable ({caja['alto']}px), no aplastado")
    check(not pg.eval_on_selector("#fbScrim", "e => e.hidden"), "el fondo oscurecido aparece")
    pg.screenshot(path=f"{SALIDA}/fb-390-hoja.png")

    ctx.close(); nav.close()

print("\n" + ("TODO BIEN" if not fallos else f"{len(fallos)} FALLAS:\n  - " + "\n  - ".join(fallos)))
sys.exit(1 if fallos else 0)

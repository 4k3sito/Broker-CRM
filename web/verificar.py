#!/usr/bin/env python3
"""Verifica que el marcado no se salga del sistema de diseño Hermes Tinta.

Dos cosas, las dos documentadas en DESIGN.md §6:

1. Que ninguna clase del HTML/JS se quede sin regla en `hermes.css`. Una clase
   sin regla es marcado muerto o un componente que no se ve.
2. Que no reaparezcan las marcas del sistema terracota de julio.

Reporta y **siempre sale con 0**: es un informe, no una compuerta. Nadie tiene que
quedarse bloqueado a media edición.

    python3 web/verificar.py              # o: npm run verificar
    python3 web/verificar.py --selfcheck  # las trampas que ya costaron un despliegue
"""
import re
import sys
import pathlib

WEB = pathlib.Path(__file__).parent

# Prefijos que se generan solos y nunca están escritos tal cual en el CSS:
# `status-<estado>` en las tarjetas, y los tokens de estado `s-`, `e-`, `p-`.
GENERADOS = ('status-', 's-', 'e-', 'p-')

# Lo que quedó del sistema terracota. Si algo de esto vuelve, el tema oscuro se
# rompe en silencio o la marca queda a medias.
PROHIBIDO = ('OfficeScrapper', '#241F19', 'Newsreader')


def clases_usadas(texto):
    """Las clases de un `class="…"`, con las expresiones `${…}` descartadas.

    Sin ese descarte, un template literal como `class="card ${l.starred ? 'on' : ''}"`
    mete `${l.starred`, `?`, `:` y `===` a la lista y el informe se vuelve ruido.
    """
    out = set()
    for cuerpo in re.findall(r'class="([^"]*)"', texto):
        for c in re.sub(r'\$\{[^}]*\}', ' ', cuerpo).split():
            # Los guiones dobles son parte del nombre: `.login-brand--mobile` es una
            # clase distinta de `.login-brand` y tiene que buscarse entera.
            if re.fullmatch(r'[a-z][a-z0-9-]*', c):
                out.add(c)
    return out


def clases_por_js(texto):
    """Las clases que el JS pone sin pasar por un `class="…"`.

    `tareas.js` arma casi todo su DOM con `className =`, y `menu.js` y `theme.js`
    construyen el cajón y el botón de tema igual. Sin mirar aquí, el informe da OK
    en `tareas` sin haber revisado nada de su kanban.
    """
    out = set()
    # La comilla de cierre tiene que ser la misma que la de apertura: un template
    # literal como `tk ${x ? ' dragging' : ''}` lleva comillas simples adentro, y
    # un patrón que corte en la primera comilla que encuentre parte el valor a la
    # mitad y se inventa clases.
    crudas = [m[1] for m in re.findall(r"""className\s*=\s*(['"`])(.*?)\1""", texto)]
    crudas += [m[1] for m in re.findall(r"""classList\.(?:add|toggle)\(\s*(['"])(.*?)\1""", texto)]
    for v in crudas:
        for c in re.sub(r'\$\{[^}]*\}', ' ', v).split():
            if re.fullmatch(r'[a-z][a-z0-9-]*', c):
                out.add(c)
    return out


def clases_con_regla(css):
    return set(re.findall(r'\.([a-z][a-z0-9-]*)', css))


def sin_etiquetas(html):
    """El texto visible, ya sin marcado.

    `Office<span>Scrapper</span>` se lee «OfficeScrapper» en pantalla pero ningún
    grep de la palabra entera lo encuentra en el fuente. Por eso se busca en los
    dos lados: en el fuente tal cual y aquí.
    """
    return re.sub(r'<[^>]+>', '', html)


def paginas():
    """Cada HTML con los .js que carga, sacados de sus propios `<script src>`.

    Derivarlo del marcado y no de una lista fija es lo que mantiene el verificador
    al día solo: una página nueva entra sin tocar este archivo.
    """
    for html in sorted(WEB.glob('*.html')):
        texto = html.read_text(encoding='utf-8')
        js = [WEB / s for s in re.findall(r'<script src="([^"]+)"', texto)]
        yield html, [html] + [j for j in js if j.exists()]


def main():
    css = (WEB / 'hermes.css').read_text(encoding='utf-8')
    tiene = clases_con_regla(css)
    problemas = 0

    for html, archivos in paginas():
        usadas = set()
        for f in archivos:
            texto = f.read_text(encoding='utf-8')
            usadas |= clases_usadas(texto) | clases_por_js(texto)
        faltan = sorted(c for c in usadas - tiene if not c.startswith(GENERADOS))
        print(f"  {html.stem:17} {', '.join(faltan) if faltan else 'OK'}")
        problemas += len(faltan)

    for f in sorted(WEB.glob('*.html')) + sorted(WEB.glob('*.js')) + [WEB / 'hermes.css']:
        texto = f.read_text(encoding='utf-8')
        visible = sin_etiquetas(texto)
        for marca in PROHIBIDO:
            if marca in texto or marca in visible:
                print(f"  {f.name:17} marca retirada: {marca}")
                problemas += 1

    print(f"\n{problemas} por resolver" if problemas else "\nSin clases huérfanas ni marcas viejas")
    return 0


def selfcheck():
    """Las dos trampas que DESIGN.md §6 confiesa que ya costaron un despliegue roto."""
    # 1. Una clase con guion doble es un nombre entero, no una variante de su base.
    assert clases_usadas('<i class="login-brand--mobile">') == {'login-brand--mobile'}
    assert 'login-brand--mobile' in clases_con_regla('.login-brand--mobile { color:red }')
    assert 'login-brand--mobile' not in clases_con_regla('.login-brand { color:red }'), \
        "definir la base no le da regla a la variante"

    # 2. La marca partida por el marcado se lee en pantalla aunque no esté en el fuente.
    assert 'OfficeScrapper' not in '<h1>Office<span>Scrapper</span></h1>'
    assert 'OfficeScrapper' in sin_etiquetas('<h1>Office<span>Scrapper</span></h1>')

    # 3. Las expresiones de los template literals no son clases.
    assert clases_usadas('''<article class="card ${l.starred ? 'on' : ''}">''') == {'card'}
    # El prefijo pegado a la expresión sí es una clase real y tiene que quedar.
    assert clases_usadas('<div class="qpop-chip${o.v === actual ? \' on\' : \'\'}">') == {'qpop-chip'}

    # 4. El DOM que el JS arma sin `class="…"` también cuenta. Sin esto, `tareas`
    #    daba OK sin que nadie hubiera mirado una sola clase de su kanban.
    assert clases_por_js("div.className = 'kb-col';") == {'kb-col'}
    # `p-` sobrevive al recorte de la expresión y lo filtra GENERADOS, como `.p-alta`.
    assert clases_por_js("art.className = `tk p-${t.prioridad}${x ? ' dragging' : ''}`;") == {'tk', 'p-'}
    assert clases_por_js("el.classList.add('over');") == {'over'}
    assert clases_por_js("e.classList.toggle('active', v);") == {'active'}
    tareas = clases_por_js((WEB / 'tareas.js').read_text(encoding='utf-8'))
    assert {'kb', 'kb-col', 'kb-list', 'tk-matrix'} <= tareas, \
        "el kanban se construye con className y tiene que verse desde aquí"

    # 5. Las páginas salen de los `<script src>`, no de una lista escrita a mano.
    encontradas = {h.stem for h, _ in paginas()}
    assert 'update-password' in encontradas and 'reset-request' in encontradas, \
        "las ocho páginas, no las seis del fragmento viejo"
    for html, archivos in paginas():
        if html.stem not in ('login', 'reset-request', 'update-password'):
            assert WEB / 'menu.js' in archivos, f"{html.stem} carga menu.js y hay que mirarlo"
    print("ok")
    return 0


if __name__ == '__main__':
    sys.exit(selfcheck() if '--selfcheck' in sys.argv else main())

"""El PDF del análisis de mercado: de los números del motor a un documento que el
asesor le manda a su cliente.

Se renderiza en el servidor y no en el navegador a propósito. El otro PDF del
producto —la ficha técnica— lo imprime el navegador del asesor (`printFicha()` en
web/listing.js), y para una hoja de datos eso basta. Este documento sale del
sistema hacia un tercero: tiene que paginar igual siempre, con la misma
tipografía, aunque el asesor use un navegador distinto o esté sin red, y tiene que
poder archivarse tal cual se entregó. Eso no se consigue con `window.print()`.

Lo que este documento NO hace, por decisión explícita: no emite un veredicto de
precio. Dice dónde cae la propiedad en la distribución de su mercado comparable y
deja la conclusión al asesor, que es quien conoce al cliente y quien firma. Un
"está 18% arriba del mercado" impreso, sobre precios de lista y con el nombre de
la casa encima, es una afirmación que nadie quiere tener que defender.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from html import escape
from pathlib import Path

AQUI = Path(__file__).resolve().parent

# Las dos únicas tintas que se escriben literales, porque van como atributo de un
# SVG y WeasyPrint no resuelve var() dentro del SVG. Tienen que coincidir con
# --accent y --paper de documento.css; si allá cambian, aquí también.
TINTA = "#201333"
PAPEL = "#FFFFFF"

MESES = ("enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
         "agosto", "septiembre", "octubre", "noviembre", "diciembre")
OPERACION = {"rent": "Renta", "sale": "Venta"}
TIPO = {"local": "Local comercial", "terreno": "Terreno", "bodega": "Bodega o nave",
        "oficina": "Oficina", "rancho": "Rancho", "hotel": "Hotel",
        "desarrollo": "Desarrollo"}


def pesos(n: float | None, decimales: int = 0) -> str:
    """Formato mexicano, sin librería de locale: el contenedor es `slim` y no trae
    las locales instaladas, así que pedirle es.MX falla en silencio y devuelve el
    formato inglés."""
    if n is None:
        return "—"
    s = f"{n:,.{decimales}f}"
    return "$" + s


def metros(n: float | None) -> str:
    if n is None:
        return "—"
    return f"{n:,.0f} m²" if n >= 100 else f"{n:,.1f} m²"


def fecha_larga(iso: str) -> str:
    d = datetime.fromisoformat(iso)
    return f"{d.day} de {MESES[d.month - 1]} de {d.year}"


def posicion(valor: float, lo: float, hi: float) -> float:
    """Dónde cae `valor` dentro del dominio, en porcentaje de 0 a 100. El dominio
    se calcula incluyendo al sujeto justamente para que una propiedad fuera del
    rango p10–p90 siga siendo dibujable: recortarla al borde la haría parecer que
    está dentro del mercado cuando el punto entero es que no lo está."""
    if hi <= lo:
        return 50.0
    return max(0.0, min(100.0, 100.0 * (valor - lo) / (hi - lo)))


def tira(u: dict, sujeto: float | None) -> str:
    """La distribución del mercado como una tira.

    Es un gráfico de una sola serie, así que no lleva leyenda de colores ni
    paleta: el mercado va en tinta recesiva y la propiedad en tinta plena. Es el
    patrón de énfasis —destacar uno, apagar el resto— y tiene dos ventajas sobre
    inventarle un color al marcador: respeta la regla de DESIGN.md §4 de que
    ningún componente define color propio, y sobrevive a una impresión en blanco
    y negro, donde un marcador que sólo se distingue por su tono desaparece.

    Se dibuja con cajas HTML posicionadas y no con un SVG de ancho completo. La
    primera versión sí era SVG y salió mal de dos maneras que sólo se ven mirando
    el PDF: WeasyPrint no resuelve `var()` dentro del SVG, así que todos los
    rellenos cayeron al negro por defecto, y `preserveAspectRatio="none"` estiró
    el círculo del marcador hasta volverlo un óvalo. Con cajas, cada marca usa los
    tokens de documento.css y nada se deforma. El único SVG que queda es el punto,
    de tamaño fijo —y es SVG, y no una caja con `border-radius`, porque esa regla
    de DESIGN.md §4 no admite excepciones.

    El `style=` en línea es deliberado y es la única forma posible: la posición de
    cada marca es un dato calculado, no una constante que pueda vivir en la hoja.
    La prohibición de DESIGN.md sobre estilos en línea nace de la CSP del sitio, y
    este HTML nunca llega a un navegador: lo consume WeasyPrint y muere aquí.
    """
    p10, p25, p50, p75, p90 = (u["p10"], u["p25"], u["mediana"], u["p75"], u["p90"])
    lo, hi = p10, p90
    if sujeto is not None:
        lo, hi = min(lo, sujeto), max(hi, sujeto)
    # Un respiro a los lados para que una marca en el extremo no quede pegada al
    # borde de la caja ni se le corte la etiqueta.
    margen = (hi - lo) * 0.08 or 1
    lo, hi = lo - margen, hi + margen
    x = lambda v: round(posicion(v, lo, hi), 2)                        # noqa: E731

    marcador = ""
    if sujeto is not None:
        marcador = (
            f'<i class="t-tallo" style="left:{x(sujeto)}%"></i>'
            # El halo del color del papel es la separación que pide una marca
            # encimada a un relleno, sin dibujarle un borde de color.
            f'<svg class="t-suj" style="left:{x(sujeto)}%" viewBox="0 0 16 16">'
            f'<circle cx="8" cy="8" r="7.5" fill="{PAPEL}"/>'
            f'<circle cx="8" cy="8" r="4.5" fill="{TINTA}"/></svg>')
    return f"""
<div class="tira">
  <i class="t-eje"></i>
  <i class="t-bigote" style="left:{x(p10)}%;width:{x(p90) - x(p10)}%"></i>
  <i class="t-banda" style="left:{x(p25)}%;width:{x(p75) - x(p25)}%"></i>
  <i class="t-tope" style="left:{x(p10)}%"></i>
  <i class="t-tope" style="left:{x(p90)}%"></i>
  <i class="t-mediana" style="left:{x(p50)}%"></i>
  {marcador}
</div>
<div class="tira-pies">
  <span style="left:{x(p10)}%">{escape(pesos(p10))}</span>
  <span style="left:{x(p50)}%"><b>{escape(pesos(p50))}</b></span>
  <span style="left:{x(p90)}%">{escape(pesos(p90))}</span>
</div>"""


def narrativa(d: dict) -> list[str]:
    """Los párrafos que acompañan a las cifras.

    Hoy son plantilla. La redacción con modelo se enciende cuando exista una
    credencial (`ANTHROPIC_API_KEY`); mientras no la haya, el documento sale
    completo con este texto en vez de salir mutilado o no salir. Es la razón de
    que esta función no reciba nada de red: el PDF nunca puede depender de que
    una API de terceros conteste.
    """
    s, r = d["sujeto"], d["resumen"]
    tipo = TIPO.get(s["tipo"], "Inmueble").lower()
    op = "renta" if s["operation"] == "rent" else "venta"
    zona = s["municipio"] or "la zona"
    if not r["suficiente"]:
        return [
            # Sin artículo delante del tipo: los nombres mezclan géneros
            # ("local comercial" y "bodega o nave"), y "este bodega" salió impreso
            # en la primera prueba.
            f"No hay inventario suficiente para sostener un análisis de mercado de "
            f"esta propiedad —{tipo}— en {zona}. Se buscaron anuncios vigentes de la misma "
            f"operación y de superficie comparable dentro de {max(RADIOS_TXT)} km a la "
            f"redonda y se encontraron {r['n']}, por debajo de los "
            f"{r['minimo']} que este documento exige para publicar una cifra.",
            "El mínimo no es un capricho técnico. Una mediana calculada sobre un "
            "puñado de anuncios se mueve por completo si uno de ellos tiene el "
            "precio mal capturado, y no hay forma de defenderla frente a un cliente "
            "que pregunte de dónde salió.",
        ]
    u = r["unitario"]
    submercado = ", ".join(m["nombre"] for m in r["municipios"][:2]) or zona
    p = r["percentil_sujeto"]
    ubica = ""
    if p is not None:
        if p >= 50:
            ubica = (f"Su precio por metro cuadrado es mayor que el de {p}% de los "
                     f"comparables y menor que el del {100 - p}% restante.")
        else:
            ubica = (f"Su precio por metro cuadrado es menor que el de {100 - p}% de "
                     f"los comparables y mayor que el del {p}% restante.")
    return [
        f"Este análisis compara la propiedad con los {r['n']} anuncios vigentes de "
        f"{tipo} en {op} que se publican a menos de {r['radio_m'] / 1000:.0f} km de "
        f"ella, con una superficie dentro de ±50% de la suya. El comparable se "
        f"concentra en {submercado}.",
        f"La mitad de ese mercado pide entre {pesos(u['p25'])} y {pesos(u['p75'])} "
        f"por metro cuadrado, con una mediana de {pesos(u['mediana'])}. "
        f"La superficie mediana de los comparables es de {metros(r['area_mediana'])}. "
        + ubica,
    ]


RADIOS_TXT = (1, 2, 3, 5)


def html(d: dict) -> str:
    s, r = d["sujeto"], d["resumen"]
    hoy = fecha_larga(d["generado_at"])
    titulo = s["title"] or "Propiedad sin título"
    # El municipio no se repite si `location` ya lo nombra: los portales lo
    # incluyen casi siempre, y "Santa Catarina, Nuevo León, Santa Catarina" salió
    # impreso en la primera prueba.
    partes = [s["location"]] if s["location"] else []
    if s["municipio"] and s["municipio"].lower() not in (s["location"] or "").lower():
        partes.append(s["municipio"])
    donde = ", ".join(partes)
    unitario_sujeto = pesos(s["unitario"]) + " / m²" if s["unitario"] else "—"
    # Cuando el portal publica el precio por m², el total es lo que el cliente
    # quiere leer —y sin esto las columnas "Precio" y "Por m²" imprimen el mismo
    # número dos veces, que fue lo que salió en la primera prueba.
    total = (s["price"] * s["area_m2"] if s["price_is_per_m2"] and s["area_m2"]
             else s["price"])
    precio = pesos(total)

    parrafos = "".join(f"<p>{escape(t)}</p>" for t in narrativa(d))
    # Las notas metodológicas se imprimen también cuando no hubo muestra, así que
    # el radio tiene que poder contarse sin haberse elegido nunca.
    radio_txt = (f"a menos de {r['radio_m'] / 1000:.0f} km de ella"
                 if r["suficiente"] else "en los alrededores de la propiedad")

    if r["suficiente"]:
        u = r["unitario"]
        cuerpo = f"""
<section>
  <h2>El mercado comparable</h2>
  {parrafos}
  <table class="cifras">
    <tr><th>Mediana del mercado</th><td class="dato">{escape(pesos(u['mediana']))} / m²</td></tr>
    <tr><th>Mitad central (p25–p75)</th><td>{escape(pesos(u['p25']))} – {escape(pesos(u['p75']))} / m²</td></tr>
    <tr><th>Rango amplio (p10–p90)</th><td>{escape(pesos(u['p10']))} – {escape(pesos(u['p90']))} / m²</td></tr>
    <tr><th>Superficie mediana</th><td>{escape(metros(r['area_mediana']))}</td></tr>
    <tr><th>Comparables considerados</th><td>{r['n']} anuncios vigentes en {r['radio_m'] / 1000:.0f} km</td></tr>
  </table>
</section>
<section class="evitar-corte">
  <h2>Dónde cae esta propiedad</h2>
  <div class="tira-caja">
    {tira(u, s['unitario'])}
    <div class="tira-leyenda">
      <span class="lg-banda"></span> Mitad central del mercado
      <span class="lg-mediana"></span> Mediana
      <svg class="lg-suj" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4.5" fill="{TINTA}"/></svg> Esta propiedad, {escape(unitario_sujeto)}
    </div>
  </div>
</section>"""
        filas = "".join(f"""
    <tr>
      <td>{escape(c['title'] or 'Sin título')}<span class="muni">{escape(c['municipio'] or '')}</span></td>
      <td class="num">{escape(metros(c['area_m2']))}</td>
      <td class="num">{escape(pesos(c['unitario']))}</td>
      <td class="num">{c['dist_m'] / 1000:.1f} km</td>
    </tr>""" for c in d["comparables"])
        tabla = f"""
<section>
  <h2>Los comparables más cercanos</h2>
  <p class="sutil">Los {len(d['comparables'])} anuncios vigentes más próximos a la
  propiedad, de los {r['n']} que sostienen las cifras de este análisis. Una misma
  propiedad publicada en varios portales aparece una sola vez.</p>
  <table class="lista">
    <thead><tr><th>Anuncio</th><th class="num">Superficie</th>
               <th class="num">Precio / m²</th><th class="num">Distancia</th></tr></thead>
    <tbody>{filas}</tbody>
  </table>
</section>"""
    else:
        cuerpo = f"""
<section>
  <h2>Inventario insuficiente</h2>
  {parrafos}
</section>"""
        tabla = ""

    return f"""<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>Análisis de mercado — {escape(titulo)}</title>
<link rel="stylesheet" href="documento.css">
</head><body>
<header class="portada">
  <div class="marca">Office<i>Lab</i></div>
  <div class="kicker">Análisis de mercado</div>
</header>
<h1>{escape(titulo)}</h1>
<div class="donde">{escape(donde) or "Ubicación no publicada"}</div>
<table class="hechos"><tr>
  <td><span>Tipo</span><strong>{escape(TIPO.get(s['tipo'], '—'))}</strong></td>
  <td><span>Operación</span><strong>{escape(OPERACION.get(s['operation'], '—'))}</strong></td>
  <td><span>Superficie</span><strong>{escape(metros(s['area_m2']))}</strong></td>
  <td><span>Precio</span><strong>{escape(precio)}</strong></td>
  <td><span>Por m²</span><strong>{escape(unitario_sujeto)}</strong></td>
</tr></table>
{cuerpo}
{tabla}
<section class="notas">
  <h2>Cómo se calculó</h2>
  <ul>
    <li><b>Son precios de lista, no de cierre.</b> Cada cifra viene de lo que el
    anunciante pide en un portal público. No son operaciones cerradas, y en
    inmuebles comerciales la diferencia entre lo que se pide y lo que se paga no es
    menor. Léase como el precio al que compite la propiedad, no como su valor.</li>
    <li><b>Un comparable</b> es un anuncio vigente del mismo tipo y la misma
    operación, con superficie dentro de ±50% de la de esta propiedad, publicado
    {radio_txt}. El radio empieza en {RADIOS_TXT[0]} km y sólo se abre —hasta un
    máximo de {RADIOS_TXT[-1]} km— cuando hace falta para juntar al menos
    {r['minimo']} comparables.</li>
    <li><b>Mediana y percentiles, nunca promedio.</b> Entre precios de portal
    siempre hay alguno mal capturado, y un promedio se lo cree.</li>
    <li><b>Vigencia:</b> se consideran sólo los anuncios verificados como publicados.
    El inventario se revisa de forma continua y se actualiza cada noche.</li>
    <li><b>Corte:</b> {escape(hoy)}. Las cifras cambian con el inventario.</li>
  </ul>
</section>
</body></html>"""


def pdf(d: dict) -> bytes:
    """El render. Se importa WeasyPrint aquí dentro y no arriba porque arrastra
    Pango por ctypes al importarse: si algún día falta una librería del sistema,
    que se caiga este endpoint y no el arranque entero de la API."""
    from weasyprint import HTML

    return HTML(string=html(d), base_url=str(AQUI)).write_pdf()


def selfcheck() -> None:
    assert pesos(1234567.891) == "$1,234,568"
    assert pesos(None) == "—"
    assert metros(1200) == "1,200 m²" and metros(85.5) == "85.5 m²"
    assert fecha_larga("2026-09-21T05:00:00+00:00") == "21 de septiembre de 2026"
    # El dominio de la tira incluye al sujeto: una propiedad más cara que el p90
    # se dibuja fuera de la banda, no aplastada contra el borde.
    assert posicion(5, 0, 10) == 50.0
    assert posicion(-5, 0, 10) == 0.0 and posicion(50, 0, 10) == 100.0
    assert posicion(1, 3, 3) == 50.0, "dominio degenerado no debe dividir entre cero"

    u = {"p10": 100.0, "p25": 150.0, "mediana": 200.0, "p75": 260.0, "p90": 320.0}
    marcas = tira(u, 400.0)
    # Eje, bigote, banda, dos topes, mediana y el tallo del marcador del sujeto.
    assert marcas.count("<i ") == 7 and 't-suj' in marcas
    sin_suj = tira(u, None)
    assert "t-suj" not in sin_suj, "sin precio del sujeto no se dibuja su marca"
    assert sin_suj.count("<i ") == 6
    # Ninguna tinta llega literal al HTML salvo las dos del SVG, que WeasyPrint
    # no sabe resolver por token.
    assert marcas.count(TINTA) == 1 and marcas.count(PAPEL) == 1

    base = {"sujeto": {"title": "Local <script>", "location": "Cumbres",
                       "municipio": "Monterrey", "tipo": "local", "operation": "rent",
                       "area_m2": 200.0, "price": 60000.0, "currency": "MXN",
                       "price_is_per_m2": False, "unitario": 300.0},
            "resumen": {"suficiente": True, "n": 40, "radio_m": 2000, "minimo": 15,
                        "unitario": u, "area_mediana": 210.0, "percentil_sujeto": 72,
                        "municipios": [{"nombre": "Monterrey", "n": 30}]},
            "comparables": [{"title": "Otro <b>local</b>", "municipio": "Monterrey",
                             "area_m2": 180.0, "unitario": 250.0, "dist_m": 900.0,
                             "id": "x:1", "url": "http://x", "currency": "MXN"}],
            "generado_at": "2026-09-21T05:00:00+00:00"}
    h = html(base)
    # Todo lo que viene de un portal se escapa: el título del anuncio lo escribió
    # un tercero y acaba dentro del HTML que renderiza WeasyPrint.
    assert "<script>" not in h and "&lt;script&gt;" in h
    assert "<b>local</b>" not in h and "&lt;b&gt;local&lt;/b&gt;" in h
    assert "precios de lista, no de cierre" in h
    # El municipio no se repite cuando `location` ya lo nombra.
    assert html({**base, "sujeto": {**base["sujeto"], "location": "Cumbres, Monterrey"}}
                ).count("Cumbres, Monterrey") == 1
    # Precio por m²: la columna Precio da el total, no el unitario otra vez.
    por_m2 = html({**base, "sujeto": {**base["sujeto"], "price": 300.0,
                                      "price_is_per_m2": True}})
    assert "$60,000" in por_m2, "300/m² × 200 m² tiene que imprimirse como total"
    # Género: ningún artículo pegado al nombre del tipo.
    sin_muestra = html({**base, "sujeto": {**base["sujeto"], "tipo": "bodega"},
                        "resumen": {"suficiente": False, "n": 0, "radio_m": None,
                                    "minimo": 15}})
    assert "este bodega" not in sin_muestra and "esta propiedad" in sin_muestra
    assert "veredicto" not in h.lower()

    flaco = {**base, "resumen": {"suficiente": False, "n": 6, "radio_m": None,
                                 "minimo": 15}}
    hf = html(flaco)
    assert "Inventario insuficiente" in hf and "Mediana del mercado" not in hf
    print("ok")


if __name__ == "__main__":
    selfcheck()

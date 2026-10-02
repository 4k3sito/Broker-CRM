# Investigación — análisis de mercado por ubicación, sin Google Cloud

> **Qué es:** la investigación para rehacer desde cero el análisis de mercado como una
> herramienta de **entorno**: eliges un punto, un radio o un tiempo de traslado, y ves
> población, NSE, competencia y vialidad. Parte de la descripción, por WhatsApp, de un
> programa parecido que ya existe (OpenStreetMap + OpenFreeMap + datos de INEGI).
> **Qué no es:** un plan de ejecución aprobado. Las decisiones abiertas están en §8.
> **Medido:** el 2026-10-01, desde el VPS. Lo que dice "verificado" se descargó y se contó;
> lo que dice "sin verificar" salió de documentación y hay que medirlo antes de prometerlo.

---

## 1. Conclusión corta

Todo lo que describe el mensaje se puede construir con datos abiertos y sin una sola
llave de Google, **menos una cosa: el aforo vehicular en calles urbanas**. Ese dato no
existe abierto en México; lo que existe es de paga (TomTom) o es un sustituto que hay que
llamar por su nombre.

| Lo que hacía el programa | Se puede sin Google | Con qué | Confianza |
|---|---|---|---|
| Mapa base | Sí | MapLibre GL + OpenFreeMap | Alta |
| Radio en metros | Sí | PostGIS (`ST_Buffer` sobre geografía) | Alta |
| Perímetro por tiempo (15 min) | Sí | Valhalla propio, u openrouteservice | Alta, **sin tráfico** |
| Población | Sí | Censo 2020 por manzana (INEGI) | Alta; el dato es de 2020 |
| NSE | Sí | AMAI por AGEB (descarga gratuita) | Media: AGEB, no manzana |
| Competencia por giro | Sí | DENUE (INEGI), carga masiva | Alta |
| Aforo vehicular urbano | **No** | Carreteras federales: SICT. Calles: sólo de paga o sustituto | Baja |

Y hay una ventaja que el otro programa no tiene: **el inventario propio**. 464 mil
anuncios con precio y coordenada permiten poner, junto a la población y la competencia, la
renta mediana de locales del mismo polígono. Eso no lo da INEGI ni Google.

---

## 2. El stack propuesto

| Capa | Pieza | Costo | Dónde corre |
|---|---|---|---|
| Mapa | **MapLibre GL JS**, vendorizado en `web/vendor/` | $0 | Navegador |
| Teselas | **OpenFreeMap**, instancia pública | $0, sin llave | Sus servidores |
| Motor espacial | **PostGIS 17-3.5** — el contenedor que ya existe | $0 | VPS |
| Isócronas | **Valhalla** en un contenedor más | $0 | VPS (ver §4) |
| Población / vivienda | Censo 2020, resultados por AGEB y manzana + Marco Geoestadístico | $0 | Tablas en PostGIS |
| NSE | Base AMAI por AGEB | $0 | Tabla en PostGIS |
| Negocios | DENUE, descarga masiva por estado | $0 | Tabla en PostGIS |
| Vialidad | OSM (jerarquía) + Datos Viales SICT (TDPA en carreteras) | $0 | Tablas en PostGIS |
| Búsqueda | El gazetteer propio (municipios + 71,465 colonias) | $0 | Ya está |
| API | Un router nuevo en FastAPI, `entorno.py` | $0 | VPS |

Nada de esto pide un servicio externo de paga, y sólo las teselas dependen de un tercero
en tiempo de ejecución.

### Por qué cargar los datos en vez de consultarlos por API

La API del DENUE existe y es gratuita con token, pero su radio máximo es de 5,000 m y
obliga a salir a internet en cada consulta. El archivo completo de Nuevo León pesa 21 MB.
Con todo en PostGIS, una consulta de entorno es un `ST_Intersects` local, funciona con
cualquier polígono (no sólo círculos) y no depende de que INEGI conteste — la misma regla
que ya se sigue con el PDF.

---

## 3. Los datos, uno por uno

### 3.1 Población y vivienda — Censo 2020 por manzana · verificado

- Archivo de Nuevo León: 11 MB comprimido, 48 MB en CSV, **230 columnas**.
- **76,995 manzanas, 2,765 AGEB urbanas, 5,565,047 habitantes** en manzanas.
- Trae lo que se necesita: `POBTOT`, estructura por edad y sexo, `TOTHOG`,
  `VIVPAR_HAB`, `GRAPROES` (escolaridad promedio), `POCUPADA`, `VPH_INTER`,
  `VPH_AUTOM`, `VPH_PC`, `VPH_2YMASD` (dos o más dormitorios).
- La geometría sale del Marco Geoestadístico 2020 (91 MB para NL), que une por clave.

**La manzana es la unidad correcta, no la AGEB.** Un radio de 500 m corta AGEBs por la
mitad y obliga a suponer que la gente está repartida parejo dentro de cada una. Con
manzanas el error de borde es de una cuadra.

**Confidencialidad.** INEGI oculta con `*` las variables de las manzanas muy pequeñas.
Medido en NL: `VPH_INTER` está oculto en 7,937 manzanas (10%), pero ahí viven sólo 99,970
personas (**1.8%** de la población). `POBTOT` casi nunca se oculta. El conteo de población
es sólido; las variables de vivienda se completan con el valor de la AGEB.

**El dato tiene seis años.** Fraccionamientos posteriores a 2020 aparecen vacíos. Hay una
corrección parcial: la Encuesta Intercensal 2025 publicó resultados definitivos el
2026-09-22, pero **sólo a nivel municipio**. Sirve para un factor de crecimiento por
municipio y para decir en el documento qué tan vieja es la cifra; no arregla una colonia
nueva. El documento debe declarar el año, igual que hoy declara "precios de lista".

### 3.2 NSE — tres caminos

La regla AMAI 2024 (sin cambios desde 2020) clasifica **hogares** con seis preguntas:
escolaridad del jefe, baños completos, autos, internet, ocupados de 14+ y dormitorios;
de 0 a 300 puntos y siete niveles (A/B ≥ 202 … E ≤ 47). El Censo publica agregados por
manzana, no hogares, así que **la regla no se puede aplicar tal cual** a datos abiertos.

| Camino | Qué es | A favor | En contra |
|---|---|---|---|
| **A. Base AMAI por AGEB** | AMAI ya corrió un modelo alterno sobre el Censo 2020. Viviendas por nivel y nivel predominante, por AGEB. Descarga gratuita en Excel | Es el NSE oficial; trae la **distribución**, no sólo una etiqueta | AGEB, no manzana (la manzana se vende). Condiciones de uso comercial **sin verificar** |
| B. Índice propio por manzana | Combinar `GRAPROES`, `VPH_INTER`, `VPH_AUTOM`, `VPH_2YMASD`, `POCUPADA` | Resolución de cuadra | **No es AMAI** y no se puede llamar así. Hay que validarlo contra A |
| C. Microsimulación | Hogares sintéticos calibrados a los totales de cada AGEB (hay un proyecto con licencia MIT que lo hace) | Lo más cercano a la regla real | Trabajo de semanas |

**Recomendación: A.** Repartir las viviendas por nivel de cada AGEB entre sus manzanas en
proporción a las viviendas habitadas, y sumar lo que caiga en el polígono. El resultado es
"de 4,200 viviendas, 38% C+, 31% C…", que es más honesto y más útil que una letra.
B queda como mejora si la AGEB resulta gruesa. CONAPO (marginación urbana) y CONEVAL
(rezago social) publican índices por AGEB 2020 y sirven de contraste.

### 3.3 Competencia — DENUE · verificado

- Nuevo León: **211,349 establecimientos, el 100% con coordenada**, 42 columnas. El archivo
  es del 2026-05-20.
- Trae nombre, razón social, código SCIAN de 6 dígitos, estrato de personal (166,089 son
  de 0 a 5 personas), dirección, y si está dentro de un centro comercial (`nom_CenCom`).
- Lo más poblado: comercio al por menor (74,892), otros servicios (37,034), alojamiento y
  alimentos (27,673).

Lo que no es obvio:

- **El SCIAN no habla como un asesor.** Nadie busca "722513"; busca "taquería" o
  "gimnasio". Hace falta un diccionario de sinónimos giro → códigos, y es trabajo manual.
- **`fecha_alta` no es la fecha de apertura**: 76,667 de los registros dicen 2024, que es
  cuando se incorporaron al directorio. No sirve para "negocios nuevos".
- **El DENUE no da de baja con rapidez.** Un local cerrado puede seguir apareciendo. El
  documento cuenta "establecimientos registrados", no "abiertos hoy".
- Para marcas y cadenas, **Overture Maps Places** (abierto, ~3 millones de lugares en
  México según un tercero, sin verificar) complementa bien. Es una segunda fase.

Métrica que conviene desde el primer día: **habitantes por competidor** en el polígono.

### 3.4 Aforo vehicular — el hueco

| Fuente | Qué cubre | Estado |
|---|---|---|
| **Datos Viales SICT** | TDPA 2009–2024 y composición por tipo de vehículo; 4,791 tramos y 13,826 estaciones. Hay una compilación en GeoPackage/PostGIS con licencia CC BY | Abierto. **Sólo la red carretera pavimentada**, no avenidas |
| PIMUS de la zona metropolitana | Aforos manuales y automáticos en vialidades | Se levantaron y **no se publicaron**: sólo un PDF ejecutivo |
| SINTRAM | Semáforos con sensores | No encontré datos abiertos |
| TomTom Traffic Stats | Muestras de sondas por tramo | De paga; prueba de 30 días. Es **muestra**, no volumen |
| TomTom Historical Traffic Volumes | TDPA modelado por tramo | De paga, por ventas. Cobertura en Monterrey sin verificar |

Sobre lo que dice el mensaje ("creo que estimado con datos de Google Maps"): no encontré ninguna API
de Google que entregue conteo de vehículos. Lo más probable es que su programa muestre la
capa de tráfico (velocidad) o un estimado propio. **Vale la pena preguntarle de dónde
sale ese número**; es la única pieza que no pude reconstruir.

**Recomendación:** en la primera versión mostrar lo que sí se sabe —la **jerarquía de la
vialidad** de frente al predio según OSM (primaria, secundaria, local), carriles, y el
TDPA de la SICT cuando el punto esté sobre una carretera— y llamarlo "vialidad", no
"aforo". Poner un número de vehículos inventado en un PDF que va a un cliente es peor que
no ponerlo. Si el aforo resulta indispensable, probar TomTom contra un conteo manual.

### 3.5 Mapa — MapLibre + OpenFreeMap · verificado que responde

- Cinco estilos listos (`positron`, `bright`, `liberty`, `dark`, `fiord3d`). `positron` es
  el que mejor deja ver capas encima. Las teselas se regeneran cada semana.
- Sin llave, sin registro, sin límite declarado, uso comercial permitido. Se sostiene con
  donaciones: **no hay SLA**. Plan B si se cae: servir un extracto propio de México
  (el planeta completo pide 300 GB; un país es una fracción — sin medir).
- Atribución obligatoria en el mapa: OpenFreeMap · © OpenMapTiles · © OpenStreetMap.

Choques con este repo:

- **CSP.** `script-src 'self'` obliga a vendorizar MapLibre, y su worker arranca por
  defecto desde un `blob:`. Hay que usar la variante CSP (worker como archivo propio) o
  abrir `worker-src blob:`. Además: `connect-src https://tiles.openfreemap.org` e
  `img-src blob: data:`. Va en `SECURITY.md` en el mismo commit.
- **`web/mapa.js`** hoy es Google Maps. Pasarlo a MapLibre quita la última dependencia de
  Google en el navegador y deja un solo motor de mapa para el tablero y para el entorno.
- **El PDF** usa Static Maps. Sustituto: rasterizar con el Chromium que ya está en
  `scrapers/.venv` (patchright), o dibujar un SVG propio con manzanas y puntos, que con
  WeasyPrint sale nítido y no depende de la red.
- **DESIGN.md** prohíbe `border-radius` y `box-shadow`: los controles de MapLibre traen
  los dos y hay que reescribirles el estilo en `hermes.css`.

### 3.6 Búsqueda de ubicación

Nominatim público prohíbe el autocompletado. No hace falta: el gazetteer propio ya resuelve
colonia y municipio, y la entrada principal es **clic en el mapa** o partir de un anuncio
del inventario. Geocodificar direcciones con número (Photon propio) se deja para cuando
alguien lo pida.

---

## 4. Isócronas — "15 minutos para llegar"

| Opción | Límite | Notas |
|---|---|---|
| **Valhalla propio** | El del VPS | Imagen oficial `valhalla/valhalla` (la de gis-ops se archivó en marzo de 2026). Auto, a pie y bicicleta |
| openrouteservice, API pública | 500 isócronas/día, 20/min | Requiere llave; hay que llamarla desde la API, no desde el navegador |

- El extracto de México en Geofabrik pesa **646 MB** (verificado, se actualiza diario).
- El VPS tiene **2 núcleos, 7 GB de RAM (6 libres) y 79 GB de disco**, y ahí vive la base
  de producción. La memoria que pide construir el grafo de un país no está documentada:
  **hay que medirla**, y no en horario de trabajo. Lo prudente es recortar el extracto al
  noreste con `osmium` y construir con un solo hilo; servir pide mucho menos que construir.
- Para cinco usuarios, **openrouteservice alcanza de sobra** y permite sacar la primera
  versión sin tocar el VPS. Valhalla entra cuando se quiera independencia o precálculo.

**Lo que hay que decir en voz alta:** ninguna de las dos conoce el tráfico. Calculan con
la velocidad de la vía. "15 minutos" en Gonzalitos a las 6 de la tarde es mentira. El
documento debe decir "15 minutos sin tráfico", o ajustar las velocidades urbanas a la baja
y medir contra recorridos reales.

Cada isócrona se guarda con su punto, modo y minutos: el segundo asesor que abre la misma
propiedad no la recalcula.

---

## 5. Cómo se arma la consulta

```
punto + (radio | minutos, modo)
        │
        ├─ radio    → ST_Buffer(punto::geography, metros)
        └─ minutos  → Valhalla / ORS → polígono (con caché)
        │
        ▼ polígono
   ├─ manzanas que intersecta → población, viviendas, edades   (ponderado por área cortada)
   ├─ AGEB → manzana → viviendas por NSE
   ├─ DENUE dentro, filtrado por giro → competidores, el más cercano, habitantes/competidor
   ├─ vialidad OSM / SICT más cercana al punto
   └─ listings propios dentro → renta y venta mediana por m², con deduplicar()
```

Un solo endpoint, `GET /api/entorno?lat&lng&radio=` o `&minutos=&modo=`, que devuelve todo
junto. Va en su propio router (E5 de `PLAN-STACK.md` ya pide sacar el análisis de
`main.py`), y `api/entorno.py` —que hoy habla con Google— se reescribe sobre estas tablas.

Tamaño estimado para Nuevo León: 77 mil manzanas y 211 mil negocios. Con índice GiST es
una consulta de milisegundos. Nacional son ~1 millón de manzanas y ~5 millones de
negocios: cabe en el disco actual, pero conviene empezar por el área metropolitana.

---

## 6. Qué ya existe parecido

- **`consultorez99/radar-inmobiliario-ags`** (abierto, Aguascalientes): es casi exactamente
  esto. Radio, isócronas y polígono libre; población por interpolación; NSE propio de seis
  variables; competencia por giro DENUE con sinónimos; PDF. Usa Leaflet + Turf en el
  navegador, TomTom para isócronas en auto y ORS a pie. Dos ideas para tomar: el **gasto
  potencial** del polígono (un modelo sobre la ENIGH) y avisar cuando más del 25% del área
  no tiene cobertura censal. Y una lección: declara que su NSE "no es AMAI".
- **`asuskf-kin/mx-retail-geodemographics`** (MIT): el camino C de §3.2, hecho para Mérida.
- **`iChocko/Datos-Viales-SICT`** (CC BY): los aforos carreteros ya en formato PostGIS.
- **Comerciales en México:** Datlas (Monterrey), MktCompass, GeoPanel, Blackprint, AXSI.
  Datlas arma su análisis en siete bloques: demografía, social, vivienda, NSE, negocios y
  competencia, **generadores de tráfico** (escuelas, hospitales, oficinas, transporte) y
  seguridad. Los generadores salen del mismo DENUE y son un buen sustituto parcial del
  aforo: dicen por qué pasa gente, aunque no cuánta.

---

## 7. Fases sugeridas

1. **Datos en PostGIS** (NL): manzanas con Censo, AGEB con NSE de AMAI, DENUE. Scripts
   hermanos de `vps/colonias.py`, con su `--selfcheck`. *Listo cuando:* la suma de
   población de las manzanas de San Pedro coincide con la cifra oficial del municipio.
2. **Endpoint de radio** y una página `entorno.html` con MapLibre: clic, radio, cifras.
   De paso `web/mapa.js` deja Google.
3. **Isócronas** con openrouteservice detrás de la API, con caché.
4. **Competencia por giro** con el diccionario de sinónimos, y la capa del inventario
   propio (renta mediana del polígono).
5. **PDF** nuevo sobre estos datos, con mapa propio.
6. Después, según se pida: Valhalla propio, cobertura nacional, gasto potencial,
   generadores de tráfico, aforo de paga.

---

## 8. Decisiones abiertas

1. **¿Qué pasa con el análisis de comparables que ya existe?** No depende de Google salvo
   por el mapa y los lugares del PDF. La lectura de esta investigación es que se conserva
   como una sección más del documento nuevo; si "desde cero" quiere decir tirarlo también,
   hay que decirlo.
2. **Aforo:** vialidad honesta, o pagar por el dato. Antes, preguntar al autor del otro
   programa de dónde lo saca.
3. **NSE:** confirmar las condiciones de uso de la base de AMAI antes de ponerla en un PDF
   para clientes.
4. **Alcance geográfico:** área metropolitana de Monterrey primero, o nacional de entrada.
5. **Isócronas:** openrouteservice ahora y Valhalla después, o Valhalla desde el inicio
   (pide medir memoria en el VPS).

---

## 9. Fuentes

Datos (las cuatro primeras se descargaron el 2026-10-01):

- Censo 2020 por AGEB y manzana, NL — `inegi.org.mx/contenidos/programas/ccpv/2020/microdatos/ageb_manzana/RESAGEBURB_19_2020_csv.zip`
- DENUE, NL — `inegi.org.mx/contenidos/masiva/denue/denue_19_csv.zip`
- Marco Geoestadístico 2020, NL — `inegi.org.mx/.../marcogeo/889463807469/19_nuevoleon.zip`
- OSM México — `download.geofabrik.de/north-america/mexico-latest.osm.pbf`
- [API del DENUE](https://www.inegi.org.mx/servicios/api_denue.html)
- [AMAI — nota sobre las bases de NSE](https://www.amai.org/descargas/AMAI_NSE2022_Nota_sobre_estructura_bases_NSE.pdf)
- [AMAI — "Conociendo los NSE", abril 2024 (regla y puntajes)](https://inegi.org.mx/contenidos/inegi/ccu/2024/primera_sesion/presentaciones/niveles_socioeconomicos.pdf)
- [CONEVAL — rezago social por AGEB urbana 2020](https://www.coneval.org.mx/Medicion/Documents/GRS_AGEB_2020/Nota_GRS_AGEB_urbana_2020.pdf)
- [Encuesta Intercensal 2025, resultados definitivos](https://www.inegi.org.mx/contenidos/saladeprensa/boletines/2026/ei/EIC2025-def_RR.pdf)
- [Datos Viales — datos.gob.mx](https://www.datos.gob.mx/dataset/datos_viales) · [compilación en GitHub](https://github.com/iChocko/Datos-Viales-SICT)
- [PIMUS: los datos no se publicaron](https://pueblobicicletero.org/exigen-a-gobierno-del-estado-publicar-datos-abiertos-del-pimus-zmm/)
- [Overture Maps — Places](https://docs.overturemaps.org/guides/places)

Stack:

- [OpenFreeMap](https://openfreemap.org) · [inicio rápido](https://openfreemap.org/quick_start/)
- [Valhalla en Docker (oficial)](https://github.com/valhalla/valhalla/blob/master/docker/README.md) · [gis-ops, archivado](https://github.com/gis-ops/docker-valhalla)
- [openrouteservice — planes y límites](https://openrouteservice.org/plans/)
- [TomTom Traffic Stats](https://docs.tomtom.com/traffic-stats/documentation/product-information/introduction) · [Historical Traffic Volumes](https://www.tomtom.com/products/historical-traffic-volumes/)
- [Photon](https://github.com/komoot/photon)

Referentes:

- [radar-inmobiliario-ags](https://github.com/consultorez99/radar-inmobiliario-ags)
- [mx-retail-geodemographics](https://github.com/asuskf-kin/mx-retail-geodemographics)
- [mapanet/NSE](https://github.com/mapanet/NSE)
- [Datlas — análisis de entorno](https://blogdatlas.wordpress.com/2026/08/31/analisis-de-entorno-la-guia-completa-para-2026/)

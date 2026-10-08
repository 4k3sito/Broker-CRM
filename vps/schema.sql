-- Esquema único de OfficeLab. Fuente de verdad: este archivo.
--   - lo ejecuta el contenedor al inicializar el volumen (docker-entrypoint-initdb.d)
--   - lo ejecuta `python propdb.py init` contra una DB ya existente
-- Idempotente: se puede correr dos veces sin romper nada.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─────────────────────────────────────────────────────────── inventario scrapeado

CREATE TABLE IF NOT EXISTS listings (
  source          text NOT NULL,
  listing_id      text NOT NULL,
  url             text NOT NULL,
  title           text,
  image_url       text,
  operation       text,
  price           numeric,
  currency        text,
  property_type   text,
  area_m2         numeric,
  plot_area_m2    numeric,
  built_area_m2   numeric,
  bedrooms        int,
  bathrooms       int,
  location        text,
  city            text,
  province        text,
  agency_name     text,
  agent_phone     text,
  description     text,
  geom            geography(Point, 4326),
  listed_at       timestamptz,
  observed_at     timestamptz,
  price_is_per_m2 boolean,
  norm            text,   -- location+city+province+title sin acentos, minúsculas
  -- Campos que el dashboard muestra pero los scrapers actuales no producen (venían
  -- del scraping de página de detalle). Quedan NULL en las cargas de propdb.py.
  neighborhood    text,
  images          text[],
  features        text[],
  maps_url        text,
  PRIMARY KEY (source, listing_id)
);

CREATE INDEX IF NOT EXISTS listings_geom_idx   ON listings USING gist (geom);
CREATE INDEX IF NOT EXISTS listings_norm_idx   ON listings USING gin  (norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS listings_filter_idx ON listings (operation, property_type, price);

-- ──────────────────────────────────────────────────────────────────────────── CRM
--
-- user_id es uuid y apunta a `usuario` (la tabla de la API propia). La FK no se declara
-- aquí sino al final del archivo, en bloque, porque `usuario` se crea más abajo.
--
-- listing_id / source_listing_id son text con el formato "source:listing_id" — la llave
-- natural del inventario. NO hay FK a listings: una recarga completa del inventario no
-- debe borrar el seguimiento del asesor.

CREATE TABLE IF NOT EXISTS user_listing (
  user_id    uuid NOT NULL,
  listing_id text NOT NULL,
  status     text CHECK (status IN ('new','reviewed','contacted','rented','discarded')),
  starred    boolean NOT NULL DEFAULT false,
  notes      text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, listing_id)
);

CREATE TABLE IF NOT EXISTS cliente (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL,
  nombre         text NOT NULL,
  contacto       text,
  empresa        text,
  requerimientos text,
  notas          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cliente_user_idx ON cliente (user_id);

-- Snapshot editable de una propiedad en seguimiento. No es la listing viva:
-- el asesor corrige precio/tamaño sin que el siguiente scrape se lo pise.
CREATE TABLE IF NOT EXISTS ficha (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL,
  source_listing_id text,
  titulo            text,
  precio            numeric,
  moneda            text DEFAULT 'MXN',
  tamano_m2         numeric,
  fotos             text[] NOT NULL DEFAULT '{}',
  notas             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_listing_id)
);
CREATE INDEX IF NOT EXISTS ficha_user_idx ON ficha (user_id);

-- Cruce cliente × ficha: el núcleo del CRM.
CREATE TABLE IF NOT EXISTS proceso (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  cliente_id uuid NOT NULL REFERENCES cliente (id) ON DELETE CASCADE,
  ficha_id   uuid NOT NULL REFERENCES ficha (id)   ON DELETE CASCADE,
  status     text NOT NULL DEFAULT 'presentado'
             CHECK (status IN ('presentado','aprobado','rechazado')),
  notas      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cliente_id, ficha_id)
);
CREATE INDEX IF NOT EXISTS proceso_user_idx  ON proceso (user_id);
CREATE INDEX IF NOT EXISTS proceso_ficha_idx ON proceso (ficha_id);

-- Documentos de la PROPIEDAD (predial, planos, escrituras), no del cliente.
CREATE TABLE IF NOT EXISTS ficha_documento (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  ficha_id   uuid NOT NULL REFERENCES ficha (id) ON DELETE CASCADE,
  label      text NOT NULL,
  done       boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ficha_documento_ficha_idx ON ficha_documento (ficha_id);

-- ────────────────────────────────────────────────────────────────────── tareas
--
-- Tablero de trabajo del equipo. Una tarea puede colgar de un inmueble, de un
-- cliente, de ambos o de ninguno — por eso las dos referencias son opcionales.
--
-- El checklist NO tiene tabla propia: vive como markdown dentro de `descripcion`
-- (`- [ ]` / `- [x]`), que es como lo escribe el diseño. Una tabla aparte para
-- marcar tres casillas sería más esquema del que el problema pide.

CREATE TABLE IF NOT EXISTS tarea (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES usuario (id) ON DELETE CASCADE,   -- quien la creó
  asignado_a  uuid REFERENCES usuario (id) ON DELETE SET NULL,           -- sin asignar = pendiente
  titulo      text NOT NULL,
  tipo        text,                       -- Visita, Fotos, Contrato, Llamada…
  prioridad   text NOT NULL DEFAULT 'media' CHECK (prioridad IN ('alta','media','baja')),
  columna     text NOT NULL DEFAULT 'pendiente'
              CHECK (columna IN ('pendiente','asignado','encurso','completado')),
  -- "source:listing_id", igual que el resto del CRM. Sin FK a listings: recargar
  -- el inventario no debe borrar el trabajo del equipo.
  listing_id  text,
  cliente_id  uuid REFERENCES cliente (id) ON DELETE SET NULL,
  descripcion text NOT NULL DEFAULT '',
  vence_el    date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tarea_asignado_idx ON tarea (asignado_a);
CREATE INDEX IF NOT EXISTS tarea_columna_idx  ON tarea (columna);
CREATE INDEX IF NOT EXISTS tarea_listing_idx  ON tarea (listing_id);

-- Hilo de comentarios de una tarea. Se borran con ella.
CREATE TABLE IF NOT EXISTS tarea_comentario (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tarea_id   uuid NOT NULL REFERENCES tarea (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES usuario (id) ON DELETE CASCADE,
  texto      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tarea_comentario_idx ON tarea_comentario (tarea_id, created_at);

-- Adjuntos por URL, no por subida: no hay almacenamiento de archivos en el stack.
ALTER TABLE tarea ADD COLUMN IF NOT EXISTS adjuntos text[] NOT NULL DEFAULT '{}';

-- El tablero por persona muestra el rol debajo del nombre.
ALTER TABLE usuario ADD COLUMN IF NOT EXISTS rol text;

-- ─────────────────────────────────────────────────────────── zonas geográficas

-- Polígonos para filtrar por zona. Se llenan con vps/zonas.py (OSM/Nominatim).
-- `tipo` separa niveles: 'municipio' hoy; 'colonia' cuando haya una fuente decente.
CREATE TABLE IF NOT EXISTS zona (
  id     bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  tipo   text NOT NULL,
  nombre text NOT NULL,
  estado text,
  osm_id bigint UNIQUE,          -- permite re-sincronizar sin duplicar
  norm   text,                   -- nombre sin acentos, para buscar como escribe la gente
  geom   geography(MultiPolygon, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS zona_geom_idx ON zona USING gist (geom);
CREATE INDEX IF NOT EXISTS zona_norm_idx ON zona USING gin  (norm gin_trgm_ops);

-- La zona se materializa en listings: ST_Covers contra polígonos de miles de vértices
-- cuesta ~430 ms por consulta, y el inventario solo cambia cuando corre el cron.
-- Con la columna, el mismo filtro es un índice btree (<1 ms).
ALTER TABLE listings ADD COLUMN IF NOT EXISTS zona_id bigint REFERENCES zona (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS listings_zona_idx ON listings (zona_id);

-- Se llama después de cada carga (propdb.py load, zonas.py).
--
-- ⚠️ El `z.tipo = 'municipio'` NO es decorativo. `zona` guarda dos niveles desde el
-- 2026-09-23: municipios y colonias (INEGI DCAH). Un anuncio cae dentro de los dos a la
-- vez, así que sin el filtro el UPDATE elegiría cualquiera de ellos y `zona_id` pasaría a
-- ser a veces una colonia. Peor: como la condición es `IS DISTINCT FROM`, cada corrida
-- nocturna lo cambiaría otra vez, y el filtro de municipio del tablero devolvería
-- resultados distintos cada día sin que nada fallara.
CREATE OR REPLACE FUNCTION asignar_zonas() RETURNS bigint AS $$
  WITH m AS (
    UPDATE listings l SET zona_id = z.id
    FROM zona z
    WHERE l.geom IS NOT NULL
      AND z.tipo = 'municipio'
      AND ST_Covers(z.geom, l.geom)
      AND l.zona_id IS DISTINCT FROM z.id
    RETURNING 1)
  SELECT count(*) FROM m;
$$ LANGUAGE sql;

-- ── Colonias (INEGI DCAH) ───────────────────────────────────────────────────
--
-- Segundo nivel de `zona`, cargado por vps/colonias.py desde la Delimitación de Colonias
-- y otros Asentamientos Humanos de INEGI: 75,516 polígonos con nombre, tipo y código
-- postal, delimitados por cada municipio y sólo integrados por INEGI. La cobertura es
-- desigual por diseño —depende de qué ayuntamiento entregó y cuándo— así que un anuncio
-- sin colonia es lo normal, no un error.
--
-- `clave` es el CVEGEO de 13 caracteres (EEMMMLLLLAAAA) y da la idempotencia, igual que
-- `osm_id` la da para los municipios. Los municipios no tienen CVEGEO y las colonias no
-- tienen osm_id: por eso son dos columnas y no una.
ALTER TABLE zona ADD COLUMN IF NOT EXISTS clave     text;
ALTER TABLE zona ADD COLUMN IF NOT EXISTS cp        text;
ALTER TABLE zona ADD COLUMN IF NOT EXISTS padre_id  bigint REFERENCES zona (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS zona_clave_idx ON zona (clave) WHERE clave IS NOT NULL;
CREATE INDEX IF NOT EXISTS zona_tipo_idx  ON zona (tipo);
CREATE INDEX IF NOT EXISTS zona_padre_idx ON zona (padre_id);

ALTER TABLE listings ADD COLUMN IF NOT EXISTS colonia_id bigint REFERENCES zona (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS listings_colonia_idx ON listings (colonia_id);

-- Gemela de asignar_zonas(), para el nivel de colonia. Se llama en los mismos sitios.
CREATE OR REPLACE FUNCTION asignar_colonias() RETURNS bigint AS $$
  WITH m AS (
    UPDATE listings l SET colonia_id = z.id
    FROM zona z
    WHERE l.geom IS NOT NULL
      AND z.tipo = 'colonia'
      AND ST_Covers(z.geom, l.geom)
      AND l.colonia_id IS DISTINCT FROM z.id
    RETURNING 1)
  SELECT count(*) FROM m;
$$ LANGUAGE sql;

-- Validación de vigencia (scrapers/liveness.py): ¿el anuncio sigue publicado?
-- activo NULL = nunca revisado. Se separa de observed_at, que dice cuándo lo vio
-- el scraper, no si hoy sigue en pie.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS activo       boolean;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS revisado_at  timestamptz;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS http_status  int;
-- `revisado_at` es cuándo se VERIFICÓ (hubo veredicto). `intento_at` es cuándo se
-- INTENTÓ, con o sin suerte. La distinción no es cosmética: un 403 no concluye nada,
-- así que dejaba `revisado_at` en NULL y la fila volvía a salir primera en la corrida
-- siguiente — y en la siguiente. Medido el 2026-09-19: 12,036 de 52,000 peticiones se
-- fueron en bloqueos, y las mismas filas encabezaban la cola cada vez, así que el
-- grueso de la tabla no se revisó nunca. `intentos_fallidos` alimenta un backoff
-- exponencial para que lo que se bloquea se espere en vez de acaparar el turno.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS intento_at        timestamptz;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS intentos_fallidos smallint NOT NULL DEFAULT 0;

-- Parcial: la consulta que importa es "qué falta revisar", no el índice completo.
-- Ordena por intento, no por verificación, que es como se elige el trabajo.
CREATE INDEX IF NOT EXISTS listings_por_revisar_idx ON listings (revisado_at NULLS FIRST)
  WHERE activo IS NOT false;
CREATE INDEX IF NOT EXISTS listings_por_intentar_idx ON listings (intento_at NULLS FIRST)
  WHERE activo IS NOT false;

-- Precio por m² vs precio total. Varios portales publican "$700" queriendo decir
-- "$700 por m²"; mostrarlo como total convierte un terreno de 7.5 MDP en uno de $700.
-- Pincali marca `priceIsPerM2` pero se le escapan casos, y vivanuncios/lamudi no lo
-- marcan nunca. `precio_m2_inferido` distingue lo deducido de lo que vino del portal,
-- para poder auditarlo o revertirlo sin tocar el dato original.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS precio_m2_inferido boolean NOT NULL DEFAULT false;

-- Un precio total por debajo de estos pisos es imposible: son precios por m² mal leídos.
-- Umbrales calibrados contra los 11,797 casos que Pincali sí marcó (ver MIGRATION.md).
-- Varios portales publican 0 o 1 como "precio a consultar". Dejarlo como número real
-- pone anuncios de $0 al frente del orden "más barato", que es el que más se usa.
CREATE OR REPLACE FUNCTION limpiar_precios() RETURNS bigint AS $$
  WITH m AS (
    UPDATE listings SET price = NULL
    -- 0 y 1 son el "precio a consultar" de varios portales. Y un total menor a $50
    -- sin superficie para interpretarlo como $/m² no se puede recuperar: mostrar "$3"
    -- es peor que decir "sin precio".
    WHERE price <= 1
       OR (price < 50 AND price_is_per_m2 IS NOT TRUE
           AND coalesce(area_m2, 0) = 0)
    RETURNING 1)
  SELECT count(*) FROM m;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION inferir_precio_m2() RETURNS bigint AS $$
  WITH m AS (
    UPDATE listings SET price_is_per_m2 = true, precio_m2_inferido = true
    WHERE price_is_per_m2 IS NOT TRUE
      AND price > 0 AND area_m2 > 0
      AND price BETWEEN 0.5 AND 200000
      AND ((operation = 'sale' AND area_m2 > 100 AND price / area_m2 < 20)
        OR (operation = 'rent' AND area_m2 >  50 AND price / area_m2 < 1))
    RETURNING 1)
  SELECT count(*) FROM m;
$$ LANGUAGE sql;

-- Un inmueble ofrecido en renta Y venta a la vez. La llave (source, listing_id) lo
-- mantiene como UNA fila —es una sola propiedad—, con el segundo precio aquí.
-- `operation`/`price` siguen siendo el par principal (el que se filtra y ordena).
ALTER TABLE listings ADD COLUMN IF NOT EXISTS precio_alt          numeric;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS operacion_alt       text
  CHECK (operacion_alt IN ('rent','sale'));
ALTER TABLE listings ADD COLUMN IF NOT EXISTS precio_alt_por_m2   boolean;

-- Procedencia de `geom`. Sin esto la cobertura es un número ciego: el centroide de
-- una colonia y la coordenada exacta del portal ocupan la misma columna, y ni el
-- mapa ni la búsqueda por radio pueden distinguirlas. La columna existe para que
-- subir la cobertura no signifique bajar la confianza sin avisar.
--   portal        — lat/lng publicada por la fuente; es la ubicación real
--   portal_aprox  — la fuente publicó el punto y **ella misma avisa de que es
--                   aproximado**. Hoy sólo Pincali lo dice, con
--                   `data-exact-location="false"`: ese pin es el centroide de la
--                   colonia, no la propiedad. Se separa de 'portal' porque parecen
--                   iguales y no lo son, y de 'colonia' porque el centroide es del
--                   portal y no de nuestro gazetteer, así que `geo_error_m` no se
--                   puede calcular igual.
--   colonia       — centroide de una clave apretada del gazetteer de colonias
--   relleno       — el punto por defecto que sirve ML cuando el anuncio no publica
--                   ubicación; no es una ubicación y no debe dibujarse como tal
-- `geo_error_m` es el error ESPERADO en metros, no el real: para 'colonia' es la
-- dispersión medida de esa clave sobre el corpus que sí trae coordenada.
--
-- Dos consecuencias de marcar 'portal_aprox' que son el motivo de existir de este
-- valor: el gazetteer de colonias se arma SÓLO con `geo_origen='portal'`
-- (propdb.py), así que estos dejan de contaminarlo; y `colonia_id` de un pin que ya
-- es centroide de colonia es circular —siempre cae en la colonia de la que salió— y
-- ahora se puede detectar en vez de confundirlo con una ubicación real.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS geo_origen  text;
-- La CHECK se rehace: `ADD COLUMN IF NOT EXISTS` no la actualiza en una base que ya
-- tiene la columna, así que ampliarla ahí no habría surtido efecto.
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_geo_origen_check;
ALTER TABLE listings ADD CONSTRAINT listings_geo_origen_check
  CHECK (geo_origen IN ('portal','portal_aprox','colonia','relleno'));
ALTER TABLE listings ADD COLUMN IF NOT EXISTS geo_error_m int;
CREATE INDEX IF NOT EXISTS listings_geo_origen_idx ON listings (geo_origen);

-- El equivalente SQL de `norm()` en propdb.py. La extensión `unaccent` no está
-- instalada y no vale un cambio de imagen: los cinco portales publican en español
-- y `translate` cubre el juego entero.
CREATE OR REPLACE FUNCTION sin_acentos(t text) RETURNS text IMMUTABLE LANGUAGE sql AS $$
  SELECT btrim(lower(translate(coalesce(t, ''),
                               'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')));
$$;

-- Geocodificación por colonia, sin red: 82,581 anuncios de MercadoLibre no traen
-- lat/lng, pero sí el texto "colonia, municipio, estado" — y los otros cuatro
-- portales ya aportaron 362,606 coordenadas exactas sobre ese mismo territorio.
-- El corpus geocodificado ES el gazetteer.
--
-- Dos decisiones que son el punto entero de la función:
--
--  1. El diccionario se arma SOLO con `geo_origen='portal'`. Si se alimentara de
--     sus propios centroides, cada corrida heredaría el error de la anterior y la
--     nube se iría corriendo sola. 'relleno' queda fuera por la misma razón: es un
--     punto inventado por ML y arrastraría a toda su colonia hacia él.
--
--  2. Mediana y no promedio, para el centro y para el radio. Un anuncio con la
--     coordenada equivocada mueve el promedio de su colonia y dispara la stddev;
--     con mediana y distancia mediana al centro, ese anuncio es un voto perdido y
--     la colonia sigue siendo utilizable. Medido sobre 20,000 filas de coordenada
--     conocida: con claves de radio <1 km el error real fue 0.35 km mediano y
--     1.32 km al p90. Por encima de ese radio la clave describe la ciudad, no la
--     colonia, y el pin miente por kilómetros — de ahí el tope, y de ahí que la
--     función prefiera dejar el hueco antes que rellenarlo con ruido.
--
-- No toca filas que ya tienen `geom`: una coordenada del portal siempre gana.
CREATE OR REPLACE FUNCTION geocodificar_colonias(max_error_m int DEFAULT 1000,
                                                 min_n int DEFAULT 5) RETURNS bigint AS $$
  WITH partes AS (
    -- Cada parte separada por comas de `location` es una colonia CANDIDATA. No se
    -- intenta adivinar cuál lo es: los cinco portales ordenan el campo distinto
    -- (lamudi abre con la colonia, inmuebles24 y vivanuncios la cierran, ML la
    -- mete entre el título y el municipio). El filtro de radio hace ese trabajo
    -- mejor que un parser por portal: el nombre de una calle larga o una palabra
    -- de título se dispersan por toda la ciudad y la clave se cae sola.
    SELECT l.geom, sin_acentos(l.city) c, sin_acentos(l.province) p,
           sin_acentos(parte) col
    FROM listings l, unnest(string_to_array(l.location, ',')) parte
    WHERE l.geo_origen = 'portal' AND l.location IS NOT NULL
  ), centro AS (
    SELECT col, c, p, count(*) n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ST_X(geom::geometry)) x,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ST_Y(geom::geometry)) y
    FROM partes WHERE length(col) >= 4 AND c <> '' AND p <> ''
    GROUP BY 1, 2, 3 HAVING count(*) >= min_n
  ), gz AS (
    -- Segunda pasada: qué tan apretada es la clave, en metros. Es el dato que se
    -- guarda como `geo_error_m` y el que decide si la clave se usa.
    SELECT k.col, k.c, k.p, k.x, k.y,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ST_Distance(
             pa.geom, ST_SetSRID(ST_MakePoint(k.x, k.y), 4326)::geography))::int r
    FROM centro k
    JOIN partes pa ON pa.col = k.col AND pa.c = k.c AND pa.p = k.p
    GROUP BY 1, 2, 3, 4, 5
  ), falta AS (
    SELECT l.source, l.listing_id, sin_acentos(l.city) c,
           sin_acentos(l.province) p, sin_acentos(parte) col
    FROM listings l, unnest(string_to_array(coalesce(l.location, ''), ',')) parte
    WHERE l.geom IS NULL
  ), mejor AS (
    -- La clave más apretada de las que empatan: si el anuncio nombra su colonia y
    -- también su avenida, gana la colonia.
    SELECT DISTINCT ON (f.source, f.listing_id)
           f.source, f.listing_id, g.x, g.y, g.r
    FROM falta f
    JOIN gz g ON g.col = f.col AND g.c = f.c AND g.p = f.p
    WHERE g.r <= max_error_m
    ORDER BY f.source, f.listing_id, g.r
  ), m AS (
    UPDATE listings l
       SET geom = ST_SetSRID(ST_MakePoint(mejor.x, mejor.y), 4326)::geography,
           geo_origen = 'colonia', geo_error_m = mejor.r
    FROM mejor
    WHERE l.source = mejor.source AND l.listing_id = mejor.listing_id
      AND l.geom IS NULL
    RETURNING 1)
  SELECT count(*) FROM m;
$$ LANGUAGE sql;

-- ─────────────────────────────────────────── vocabulario de tipo (análisis)

-- Los cinco portales escriben el mismo concepto de cuatro maneras. Medido el
-- 2026-09-21 sobre las 464,014 filas, `property_type` trae 17 valores distintos
-- para siete conceptos: "Local comercial" (39,625), "Local Comercial" (18,020),
-- "Locales Comerciales" (46,287) y "Local" (2,070) son lo mismo y hoy cuentan por
-- separado. Cualquier agregado por tipo miente mientras eso siga así, y un
-- análisis de mercado es todo agregados.
--
-- Columna GENERADA y no un UPDATE periódico: Postgres la mantiene sola, así que
-- ninguna carga parcial ni ningún scraper puede dejarla desfasada, y se indexa
-- como cualquier columna. El precio de esa garantía es que cambiar `tipo_norm()`
-- obliga a recrear la columna (DROP COLUMN + ADD COLUMN), porque una columna
-- generada congela la definición con la que nació. Si se agrega un concepto, ese
-- es el camino — y hay que re-crear también `listings_tipo_idx`.
--
-- 'oficina' ya está contemplado y hoy no matchea ni una fila: las cinco fuentes
-- scrapean locales, terrenos y bodegas. Está aquí para que el día que entren las
-- oficinas no haya que tocar esta función ni recrear la columna.
CREATE OR REPLACE FUNCTION tipo_norm(t text) RETURNS text IMMUTABLE LANGUAGE sql AS $$
  SELECT CASE
    WHEN t IS NULL OR btrim(t) = ''                         THEN NULL
    -- El orden es la regla: "Local en centro comercial" es un local, y
    -- "Lote Comercial" es terreno. Se pregunta por lo específico primero.
    WHEN t ILIKE '%bodega%'  OR t ILIKE '%nave%'            THEN 'bodega'
    WHEN t ILIKE '%oficina%'                                THEN 'oficina'
    WHEN t ILIKE '%local%'                                  THEN 'local'
    WHEN t ILIKE '%terreno%' OR t ILIKE '%lote%'            THEN 'terreno'
    WHEN t ILIKE '%rancho%'  OR t ILIKE '%huerta%'          THEN 'rancho'
    WHEN t ILIKE '%hotel%'   OR t ILIKE '%entretenimiento%' THEN 'hotel'
    WHEN t ILIKE '%desarrollo%'                             THEN 'desarrollo'
    ELSE 'otro' END;
$$;

ALTER TABLE listings ADD COLUMN IF NOT EXISTS tipo text
  GENERATED ALWAYS AS (tipo_norm(property_type)) STORED;

-- El índice del motor de comparables: tipo y operación cortan el universo, la
-- superficie acota la banda de ±50%, y la distancia la resuelve listings_geom_idx.
CREATE INDEX IF NOT EXISTS listings_tipo_idx ON listings (tipo, operation, area_m2);

-- ───────────────────────────────────────── historial de precio y vigencia

-- `listings` es una foto: el UPSERT de propdb.py pisa el precio anterior y no
-- queda rastro de lo que decía antes. Sin esta tabla la pregunta "¿subió el m² de
-- esta zona?" no tiene respuesta posible, y cada noche de cron que pasa es
-- historia que no se recupera después.
--
-- Por trigger y no por un gancho en propdb.py, a propósito: el precio lo escribe
-- el UPSERT (propdb.py:119) pero la vigencia la escribe liveness.py por su cuenta
-- en tres UPDATE distintos (liveness.py:558, :570, :582), y mañana puede
-- escribirla un psql a mano. Un trigger sobre la tabla cubre los tres caminos sin
-- tocar ningún script, y nadie puede saltárselo por olvido.
--
-- La cláusula WHEN es lo que lo hace barato. El UPSERT toca ~90,000 filas por
-- carga aunque casi ninguna haya cambiado de precio: sin el WHEN, esta tabla
-- crecería 90,000 filas por noche para describir que no pasó nada.
CREATE TABLE IF NOT EXISTS precio_historial (
  id              bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  source          text NOT NULL,
  listing_id      text NOT NULL,
  visto_at        timestamptz NOT NULL DEFAULT now(),
  -- Precio, bandera y superficie viajan juntos porque por separado no se pueden
  -- interpretar después: `price` puede ser $/m², y reconstruir el unitario de una
  -- fila vieja con la superficie de hoy da un número que nunca existió.
  price           numeric,
  currency        text,
  price_is_per_m2 boolean,
  area_m2         numeric,
  operation       text,
  activo          boolean
);

-- Las dos preguntas que se le hacen: "la serie de este anuncio" y "qué se movió
-- en este periodo".
CREATE INDEX IF NOT EXISTS precio_historial_anuncio_idx
  ON precio_historial (source, listing_id, visto_at DESC);
CREATE INDEX IF NOT EXISTS precio_historial_fecha_idx ON precio_historial (visto_at);

CREATE OR REPLACE FUNCTION registrar_historial() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO precio_historial (source, listing_id, price, currency,
                                price_is_per_m2, area_m2, operation, activo)
  VALUES (NEW.source, NEW.listing_id, NEW.price, NEW.currency,
          NEW.price_is_per_m2, NEW.area_m2, NEW.operation, NEW.activo);
  RETURN NULL;   -- AFTER FOR EACH ROW: el valor de retorno se ignora
END $$;

-- El alta es el punto de partida de la serie: sin ella, el primer cambio de precio
-- de un anuncio nuevo no tiene contra qué compararse.
CREATE OR REPLACE TRIGGER listings_historial_alta
  AFTER INSERT ON listings
  FOR EACH ROW EXECUTE FUNCTION registrar_historial();

CREATE OR REPLACE TRIGGER listings_historial_cambio
  AFTER UPDATE ON listings
  FOR EACH ROW
  WHEN (OLD.price           IS DISTINCT FROM NEW.price
     OR OLD.price_is_per_m2 IS DISTINCT FROM NEW.price_is_per_m2
     OR OLD.activo          IS DISTINCT FROM NEW.activo)
  EXECUTE FUNCTION registrar_historial();

-- Pone al día el historial comparando el estado de HOY contra la última fila
-- registrada de cada anuncio. Hace dos trabajos en uno: siembra a los que nunca
-- tuvieron una fila —el caso `u.source IS NULL`— y registra el cambio NETO de una
-- carga completa.
--
-- El cambio neto es el punto. El UPSERT de propdb.py reescribe `price` y
-- `price_is_per_m2` con lo que dice el archivo, y acto seguido `limpiar_precios()`
-- e `inferir_precio_m2()` vuelven a corregirlos: medido el 2026-09-21, 6,456 filas
-- llevan `precio_m2_inferido`, así que su bandera va de false a true en cada carga
-- sin que el mercado se haya movido un peso. Con el trigger encendido durante la
-- carga eso quedaba escrito como dos cambios por fila por noche — una oscilación
-- que nunca ocurrió, que es exactamente lo que esta tabla existe para no hacer.
--
-- Por eso `propdb.py load` corre con `session_replication_role = replica` y llama
-- a esta función al final: el trigger sigue cubriendo a liveness.py y a cualquier
-- psql a mano, que sí hacen una sola escritura definitiva, y la carga masiva
-- registra el neto.
CREATE OR REPLACE FUNCTION sincronizar_historial() RETURNS bigint AS $$
  WITH ultimo AS (
    SELECT DISTINCT ON (source, listing_id) source, listing_id,
           price, price_is_per_m2, activo
    FROM precio_historial
    ORDER BY source, listing_id, visto_at DESC, id DESC
  ), m AS (
    INSERT INTO precio_historial (source, listing_id, price, currency,
                                  price_is_per_m2, area_m2, operation, activo)
    SELECT l.source, l.listing_id, l.price, l.currency,
           l.price_is_per_m2, l.area_m2, l.operation, l.activo
    FROM listings l LEFT JOIN ultimo u USING (source, listing_id)
    WHERE u.source IS NULL
       OR l.price           IS DISTINCT FROM u.price
       OR l.price_is_per_m2 IS DISTINCT FROM u.price_is_per_m2
       OR l.activo          IS DISTINCT FROM u.activo
    RETURNING 1)
  SELECT count(*) FROM m;
$$ LANGUAGE sql;

-- ────────────────────────────────────────────────────────────── auth (Fase 2a)

CREATE TABLE IF NOT EXISTS usuario (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,     -- normalizado a minúsculas por la API
  password_hash text NOT NULL,            -- scrypt$n$r$p$salt_hex$dk_hex
  nombre        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Sesiones opacas en la DB, no JWT: se revocan borrando la fila. Se guarda el
-- sha256 del token, no el token — una fuga de la DB no otorga sesiones.
CREATE TABLE IF NOT EXISTS sesion (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES usuario (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sesion_user_idx ON sesion (user_id);

-- Tokens de recuperación de contraseña. Mismo criterio que `sesion`: se guarda el
-- sha256, no el token — quien lea la base no puede secuestrar un reset en vuelo.
-- Un solo uso (`used_at`) y vida corta (30 min); OWASP pide ambas cosas.
CREATE TABLE IF NOT EXISTS reset_token (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES usuario (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  -- Para el registro de auditoría: de dónde salió la solicitud.
  solicitado_desde text
);
CREATE INDEX IF NOT EXISTS reset_token_user_idx ON reset_token (user_id);

-- Ahora que existe `usuario`, el CRM puede colgar de él: borrar un asesor se lleva
-- sus datos en vez de dejarlos huérfanos. En bloque porque ADD CONSTRAINT no tiene
-- IF NOT EXISTS y este archivo debe poder correr dos veces.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_listing','cliente','ficha','proceso','ficha_documento'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_user_fk') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (user_id)
                      REFERENCES usuario (id) ON DELETE CASCADE', t, t || '_user_fk');
    END IF;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────── pipeline comercial (2026-09-25)
--
-- El pipeline que el equipo llevaba en Google Sheets ("PIPELINES PROREALTOR": una
-- pestaña por cliente, una fila por propiedad ofrecida) vive ahora en el CRM con el
-- modelo que ya existía: la pestaña es un `cliente`, la propiedad es una `ficha` y la
-- fila es el `proceso` que los cruza. Una propiedad ofrecida a cuatro clientes es UNA
-- ficha con cuatro procesos, no cuatro filas que hay que actualizar a mano.
--
-- Las fichas del sheet no salen de un portal: `source_listing_id` queda NULL.
--
-- "Quién lo trae" y "responsable de la cuenta" se guardan como TEXTO (`trae`,
-- `responsable`) porque la mayoría del equipo todavía no tiene cuenta, más una
-- referencia opcional a `usuario` (`trae_id`, `responsable_id`) que se llena cuando la
-- tenga. `vincular_asesor()` hace ese enlace de una vez.
--
-- Este bloque es aditivo y se puede correr dos veces. Para aplicarlo a la copia de
-- trabajo sin tocar producción, ver README.md, "Copia de trabajo".

ALTER TABLE cliente ADD COLUMN IF NOT EXISTS responsable    text;
ALTER TABLE cliente ADD COLUMN IF NOT EXISTS responsable_id uuid REFERENCES usuario (id) ON DELETE SET NULL;

ALTER TABLE ficha ADD COLUMN IF NOT EXISTS tipo      text;      -- Terreno, Local, Bodega…
ALTER TABLE ficha ADD COLUMN IF NOT EXISTS municipio text;
ALTER TABLE ficha ADD COLUMN IF NOT EXISTS mapa_url  text;
ALTER TABLE ficha ADD COLUMN IF NOT EXISTS precio_m2 numeric;   -- `precio` es el monto de salida

ALTER TABLE proceso ADD COLUMN IF NOT EXISTS junta   text;      -- 1ra, 2da… la junta en que se presenta
ALTER TABLE proceso ADD COLUMN IF NOT EXISTS numero  integer;   -- el N° de la fila en el sheet
ALTER TABLE proceso ADD COLUMN IF NOT EXISTS marca   text;      -- la marca del cliente a la que va, cuando tiene varias
ALTER TABLE proceso ADD COLUMN IF NOT EXISTS trae    text;
ALTER TABLE proceso ADD COLUMN IF NOT EXISTS trae_id uuid REFERENCES usuario (id) ON DELETE SET NULL;

-- Las etapas del pipeline. `presentado`, `aprobado` y `rechazado` conservan su llave
-- para que los procesos que ya existían no cambien de significado; `pausa` y
-- `rechazado` son laterales, no pasos del avance. `evaluacion` se agregó el 2026-10-07,
-- entre presentado y aprobado; va en esta misma lista (y no en un bloque nuevo al final)
-- porque si no, volver a correr el archivo fallaría aquí con filas en esa etapa.
ALTER TABLE proceso DROP CONSTRAINT IF EXISTS proceso_status_check;
ALTER TABLE proceso ADD CONSTRAINT proceso_status_check CHECK (status IN
  ('prospecto','por_presentar','presentado','evaluacion','aprobado','negociacion','cerrado','pausa','rechazado'));

-- El CRM pasa a ser del equipo (clientes, fichas, procesos y documentos; ver
-- SECURITY.md §5). Eso cambia qué significa borrar a un asesor: antes `deluser` se
-- llevaba en cascada todo lo que había creado, y con datos compartidos eso borraría el
-- pipeline de todos. Ahora `user_id` sólo dice quién lo creó, y al borrar la cuenta
-- queda en NULL. `user_listing` NO cambia: el estado de un anuncio sí es de cada quien.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cliente','ficha','proceso','ficha_documento'] LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN user_id DROP NOT NULL', t);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_user_id_fkey');
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_user_fk');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (user_id)
                    REFERENCES usuario (id) ON DELETE SET NULL', t, t || '_user_fk');
  END LOOP;
END $$;

-- Enlaza el texto de "quién lo trae" / "responsable" con la cuenta de esa persona,
-- el día que la tenga:  SELECT vincular_asesor('<nombre>', '<uuid de su usuario>');
-- Sólo toca filas sin enlace y compara sin mayúsculas. Un valor compuesto como
-- 'A/B' no se enlaza: se queda como texto.
CREATE OR REPLACE FUNCTION vincular_asesor(nombre_en_texto text, uid uuid) RETURNS integer AS $$
DECLARE n integer; m integer;
BEGIN
  UPDATE proceso SET trae_id = uid
   WHERE trae_id IS NULL AND lower(btrim(trae)) = lower(btrim(nombre_en_texto));
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE cliente SET responsable_id = uid
   WHERE responsable_id IS NULL AND lower(btrim(responsable)) = lower(btrim(nombre_en_texto));
  GET DIAGNOSTICS m = ROW_COUNT;
  RETURN n + m;
END $$ LANGUAGE plpgsql;

-- Una tarea puede colgar de un proceso del pipeline (cliente × propiedad): "agendar
-- el QHSE de tal terreno para tal cliente" es trabajo de ESE proceso, no sólo del cliente. Con la liga,
-- la tarea abre su tarjeta del pipeline y la tarjeta lista sus tareas. Si el proceso se
-- borra, la tarea se queda (sigue siendo trabajo que alguien hizo o tiene que hacer).
ALTER TABLE tarea ADD COLUMN IF NOT EXISTS proceso_id uuid REFERENCES proceso (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tarea_proceso_idx ON tarea (proceso_id);

-- Criterios de búsqueda del cliente: lo que en "Qué busca" se captura como píldoras
-- (tipo, operación, m², $/m², precio total, ubicación). Estructurado y no texto porque
-- el tablero lo aplica como filtro: `index.html?cliente=<id>`. Las llaves son las
-- mismas que entiende GET /api/listings, más `lugares` con el objeto completo del
-- autocompletado para poder pintar el nombre sin volver a preguntar:
--   {"tipos":["oficina"], "operacion":"rent", "m2_min":100, "ppm_max":10,
--    "lugares":[{"valor":"m40","nombre":"Monterrey","contexto":"Nuevo León"}]}
-- `requerimientos` (texto libre) se queda para lo que no cabe en una píldora.
ALTER TABLE cliente ADD COLUMN IF NOT EXISTS criterios jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Cuentas que existen pero no son del equipo: la de verificación de frontend
-- (SECURITY.md, H8). Pueden entrar, pero /api/equipo no las lista, así que no salen en
-- los selectores de cuenta ni de asignación, ni en los filtros por persona.
ALTER TABLE usuario ADD COLUMN IF NOT EXISTS oculto boolean NOT NULL DEFAULT false;
UPDATE usuario SET oculto = true WHERE email = 'verificacion-dom@officelab.local';

-- ─────────────────────────────────────────────────────────────── google_cache
--
-- Lo que el análisis de mercado le pide a Google (api/entorno.py): el entorno a
-- 500 m de Places (`datos`, jsonb) y el mapa de Static Maps (`png`). Cada consulta
-- se paga una sola vez: el entorno se indexa por una rejilla de ~110 m y vive 180
-- días; el mapa, por el hash de su URL sin llave. Es caché, no dato: se puede
-- vaciar entera sin perder nada que no se pueda volver a pedir. Vive en `public`
-- para que la API de la copia de trabajo (search_path dev,public) la comparta.
CREATE TABLE IF NOT EXISTS google_cache (
  clave     text PRIMARY KEY,
  tipo      text NOT NULL,             -- 'entorno' | 'mapa'
  datos     jsonb,
  png       bytea,
  creado_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────── fichas guardadas, ubicación y bolsa propia (2026-10-01)
--
-- Tres cosas que pidió el equipo sobre la ficha:
--
-- 1. `folio`: el ID que sale en la ficha PDF. El formulario ya lo capturaba, pero la
--    columna no existía y el PATCH respondía 422 en silencio.
-- 2. `lat` / `lng`: la ubicación de una ficha que NO viene de un portal (las del sheet
--    y las que el equipo da de alta a mano en Inmobiliaria). El asesor la fija con un
--    clic en el mapa de la ficha. Las fichas de un anuncio no la usan: su coordenada
--    es la del anuncio.
-- 3. `ficha_version`: las fichas PDF que se generan de una misma propiedad. "General"
--    no tiene fila —son los datos de la ficha tal cual—; cada versión guardada
--    (Ficha-Alsea, Ficha-…) es una copia editable de esos datos, hecha para
--    presentarla a un cliente. `datos` trae sólo lo que el PDF imprime:
--      {"titulo": "...", "precio": 0, "tamano_m2": 0, "folio": "...", "notas": "..."}
--    Se guardan los DATOS y no el PDF: el PDF lo imprime el navegador (listing.js) y
--    no hay almacenamiento de archivos en el stack.
--
-- Aditivo y se puede correr dos veces. En la copia de trabajo se aplica con
-- `search_path=dev,public` (ver README.md, "Copia de trabajo").
ALTER TABLE ficha ADD COLUMN IF NOT EXISTS folio text;
ALTER TABLE ficha ADD COLUMN IF NOT EXISTS lat   double precision;
ALTER TABLE ficha ADD COLUMN IF NOT EXISTS lng   double precision;

CREATE TABLE IF NOT EXISTS ficha_version (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES usuario (id) ON DELETE SET NULL,      -- quien la generó
  ficha_id   uuid NOT NULL REFERENCES ficha (id) ON DELETE CASCADE,
  cliente_id uuid REFERENCES cliente (id) ON DELETE SET NULL,      -- para quién se hizo, si aplica
  nombre     text NOT NULL,                                        -- "Alsea" → Ficha-Alsea.pdf
  datos      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ficha_version_ficha_idx ON ficha_version (ficha_id, created_at);

-- ──────────────── estatus y orden de clientes, archivos adjuntos (2026-10-05)
--
-- Tres cosas que pidió el equipo:
--
-- 1. `cliente.estatus`: en qué va la relación con el cliente (activo, inactivo,
--    contactando, por contactar). No es la etapa: la etapa sale de sus procesos; esto
--    lo marca el asesor y la lista de clientes filtra por ello. NULL es "sin estatus":
--    los clientes que ya existían no se clasificaron solos.
-- 2. `cliente.orden`: la posición en la lista de clientes, que se arrastra igual que
--    las propiedades de un cliente (`proceso.numero`). Es del equipo, no de cada quien.
--    NULL va arriba: un cliente nuevo aparece primero hasta que alguien lo acomode.
-- 3. `archivo`: los archivos que se suben. Hasta hoy "no había almacenamiento de
--    archivos en el stack" (ver ficha_version): un documento era sólo un nombre con
--    casilla y una foto era una liga. Un archivo cuelga de una ficha y es una de dos
--    cosas: adjunto de un documento (`documento_id`) o foto de la propiedad
--    (`documento_id` NULL; su liga `/api/archivos/<id>` va en `ficha.fotos`).
--    Viven en la base y no en disco a propósito: entran al respaldo nocturno sin tocar
--    el cron, la copia de trabajo los aísla con su esquema `dev`, y la API (que corre
--    como `nobody`) no necesita un volumen. El tope por archivo lo pone la API.
--
-- Aditivo y se puede correr dos veces. En la copia de trabajo se aplica con
-- `search_path=dev,public` (ver README.md, "Copia de trabajo").
ALTER TABLE cliente ADD COLUMN IF NOT EXISTS estatus text
  CHECK (estatus IN ('activo','inactivo','contactando','por_contactar'));
ALTER TABLE cliente ADD COLUMN IF NOT EXISTS orden integer;

CREATE TABLE IF NOT EXISTS archivo (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES usuario (id) ON DELETE SET NULL,      -- quien lo subió
  ficha_id     uuid NOT NULL REFERENCES ficha (id) ON DELETE CASCADE,
  documento_id uuid REFERENCES ficha_documento (id) ON DELETE CASCADE,  -- NULL: es una foto
  nombre       text NOT NULL,
  mime         text NOT NULL,
  tamano       integer NOT NULL,
  datos        bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS archivo_documento_idx ON archivo (documento_id);
CREATE INDEX IF NOT EXISTS archivo_ficha_idx ON archivo (ficha_id);

-- ───────────────────────────── varios contactos por cliente (2026-10-07)
--
-- Un cliente tenía un solo `contacto` de texto libre; el equipo trata con varias
-- personas del mismo cliente. `contactos` es la lista:
--   [{"nombre": "...", "correo": "...", "telefono": "..."}]   (las tres llaves opcionales)
-- jsonb y no tabla: son unos cuantos por cliente, se leen y se escriben siempre junto
-- con él, y nada los consulta por separado. La API deja sólo esas tres llaves.
--
-- `contacto` se queda (no se borra nada) pero la página ya no lo usa: lo que tuviera
-- pasa a ser el primer contacto, y al guardar `contactos` la página lo deja en NULL,
-- que es lo que impide que esta migración vuelva a sembrarlo si se corre otra vez.
--
-- Aditivo y se puede correr dos veces. En la copia de trabajo se aplica con
-- `search_path=dev,public` (ver README.md, "Copia de trabajo").
ALTER TABLE cliente ADD COLUMN IF NOT EXISTS contactos jsonb NOT NULL DEFAULT '[]'::jsonb;
UPDATE cliente SET contactos = jsonb_build_array(jsonb_build_object(
    CASE WHEN contacto ~ '^\S+@\S+$' THEN 'correo'
         WHEN contacto ~ '^[\d\s()+-]{7,}$' THEN 'telefono' ELSE 'nombre' END, btrim(contacto)))
  WHERE btrim(coalesce(contacto, '')) <> '' AND contactos = '[]'::jsonb;

-- ─────────────────────── terreno y construcción por separado (2026-10-08)
--
-- `listings` ya traía `plot_area_m2` y `built_area_m2` de los portales; faltaba el par
-- en las propiedades propias. `ficha.tamano_m2` sigue siendo la superficie con la que se
-- calcula el precio por m² (el terreno, cuando hay los dos datos) y `construccion_m2`
-- es la construida. NULL = no se sabe o no aplica (un terreno baldío).
--
-- Aditivo y se puede correr dos veces. En la copia de trabajo se aplica con
-- `search_path=dev,public` (ver README.md, "Copia de trabajo").
ALTER TABLE ficha ADD COLUMN IF NOT EXISTS construccion_m2 numeric;

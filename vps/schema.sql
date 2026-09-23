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
CREATE OR REPLACE FUNCTION asignar_zonas() RETURNS bigint AS $$
  WITH m AS (
    UPDATE listings l SET zona_id = z.id
    FROM zona z
    WHERE l.geom IS NOT NULL
      AND ST_Covers(z.geom, l.geom)
      AND l.zona_id IS DISTINCT FROM z.id
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
--   portal   — lat/lng publicada por la fuente; es la ubicación real
--   colonia  — centroide de una clave apretada del gazetteer de colonias
--   relleno  — el punto por defecto que sirve ML cuando el anuncio no publica
--              ubicación; no es una ubicación y no debe dibujarse como tal
-- `geo_error_m` es el error ESPERADO en metros, no el real: para 'colonia' es la
-- dispersión medida de esa clave sobre el corpus que sí trae coordenada.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS geo_origen  text
  CHECK (geo_origen IN ('portal','colonia','relleno'));
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

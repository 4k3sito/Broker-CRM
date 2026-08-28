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
-- user_id es uuid SIN foreign key: la identidad puede venir de Supabase Auth o de la
-- API propia (ver "Decisión abierta" en MIGRATION.md). Sin FK las dos opciones sirven.
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

-- Se llama después de cada carga (migrate_supabase.py, propdb.py load, zonas.py).
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
-- Parcial: la consulta que importa es "qué falta revisar", no el índice completo.
CREATE INDEX IF NOT EXISTS listings_por_revisar_idx ON listings (revisado_at NULLS FIRST)
  WHERE activo IS NOT false;

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

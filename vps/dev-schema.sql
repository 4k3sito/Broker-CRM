-- Copia aislada del CRM para la copia de trabajo (/srv/officelab-dev).
--
-- La API de dev (vps/docker-compose.dev.yml) comparte la base con producción, porque
-- duplicar 1.1 GB de inventario para probar un filtro no se paga solo. Eso aislaba el
-- código pero no los datos: cualquier cliente o tarea creada en dev la veían los
-- asesores. Este archivo crea el esquema `dev` con una copia de las tablas **del CRM**
-- (las que escribe un asesor), y la API de dev se conecta con
-- `search_path=dev,public`: lo que existe en `dev` gana, y el inventario (`listings`,
-- `zona`, `precio_historial`) se sigue leyendo de `public` sin copiarlo.
--
-- ⚠️ BORRA Y REHACE `dev`. Todo lo que se haya hecho en la copia de trabajo se pierde y
-- se reemplaza por una foto de producción. Correr sólo a propósito:
--
--   docker exec -i officelab-db-1 psql -U officelab -d officelab -v ON_ERROR_STOP=1 \
--     < /srv/officelab-dev/vps/dev-schema.sql
--
-- Después hay que aplicar a `dev` los bloques de schema.sql que la rama agregó (hoy, el
-- del pipeline; ver README.md). **Nunca schema.sql completo con search_path=dev**:
-- `CREATE TABLE IF NOT EXISTS listings` crearía un `dev.listings` vacío que taparía al
-- inventario de `public`.

BEGIN;
DROP SCHEMA IF EXISTS dev CASCADE;
CREATE SCHEMA dev;

-- LIKE … INCLUDING ALL copia defaults, CHECKs, índices y columnas generadas, pero no
-- las llaves foráneas: esas se rehacen abajo apuntando a las tablas de `dev`.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['usuario','sesion','reset_token','user_listing','cliente',
                           'ficha','proceso','ficha_documento','tarea','tarea_comentario'] LOOP
    EXECUTE format('CREATE TABLE dev.%I (LIKE public.%I INCLUDING ALL)', t, t);
  END LOOP;
END $$;

-- Datos: todo menos sesiones y tokens de recuperación. Las contraseñas se copian, así
-- que en dev se entra con las mismas credenciales que en producción, pero con una
-- sesión propia.
INSERT INTO dev.usuario          SELECT * FROM public.usuario;
INSERT INTO dev.user_listing     SELECT * FROM public.user_listing;
INSERT INTO dev.cliente          SELECT * FROM public.cliente;
INSERT INTO dev.ficha            SELECT * FROM public.ficha;
INSERT INTO dev.proceso          SELECT * FROM public.proceso;
INSERT INTO dev.ficha_documento  SELECT * FROM public.ficha_documento;
INSERT INTO dev.tarea            SELECT * FROM public.tarea;
INSERT INTO dev.tarea_comentario SELECT * FROM public.tarea_comentario;

ALTER TABLE dev.sesion           ADD FOREIGN KEY (user_id)    REFERENCES dev.usuario (id) ON DELETE CASCADE;
ALTER TABLE dev.reset_token      ADD FOREIGN KEY (user_id)    REFERENCES dev.usuario (id) ON DELETE CASCADE;
ALTER TABLE dev.user_listing     ADD FOREIGN KEY (user_id)    REFERENCES dev.usuario (id) ON DELETE CASCADE;
ALTER TABLE dev.cliente          ADD FOREIGN KEY (user_id)    REFERENCES dev.usuario (id) ON DELETE CASCADE;
ALTER TABLE dev.ficha            ADD FOREIGN KEY (user_id)    REFERENCES dev.usuario (id) ON DELETE CASCADE;
ALTER TABLE dev.proceso          ADD FOREIGN KEY (user_id)    REFERENCES dev.usuario (id) ON DELETE CASCADE;
ALTER TABLE dev.proceso          ADD FOREIGN KEY (cliente_id) REFERENCES dev.cliente (id) ON DELETE CASCADE;
ALTER TABLE dev.proceso          ADD FOREIGN KEY (ficha_id)   REFERENCES dev.ficha (id)   ON DELETE CASCADE;
ALTER TABLE dev.ficha_documento  ADD FOREIGN KEY (user_id)    REFERENCES dev.usuario (id) ON DELETE CASCADE;
ALTER TABLE dev.ficha_documento  ADD FOREIGN KEY (ficha_id)   REFERENCES dev.ficha (id)   ON DELETE CASCADE;
ALTER TABLE dev.tarea            ADD FOREIGN KEY (user_id)    REFERENCES dev.usuario (id) ON DELETE CASCADE;
ALTER TABLE dev.tarea            ADD FOREIGN KEY (asignado_a) REFERENCES dev.usuario (id) ON DELETE SET NULL;
ALTER TABLE dev.tarea            ADD FOREIGN KEY (cliente_id) REFERENCES dev.cliente (id) ON DELETE SET NULL;
ALTER TABLE dev.tarea_comentario ADD FOREIGN KEY (tarea_id)   REFERENCES dev.tarea (id)   ON DELETE CASCADE;
ALTER TABLE dev.tarea_comentario ADD FOREIGN KEY (user_id)    REFERENCES dev.usuario (id) ON DELETE CASCADE;
COMMIT;

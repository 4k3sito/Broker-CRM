# Runbook: setup del VPS (Fase 1 — solo la base de datos)

Instrucciones para un agente que se conecta por SSH al VPS y deja corriendo Postgres+PostGIS.
Ejecuta los pasos **en orden**. Cada paso trae su verificación: si la verificación no da lo
esperado, **detente y reporta** — no improvises un arreglo.

**Verificado** contra un VPS Hostinger con Ubuntu 24.04.4 (8 GB RAM, 2 CPU): la Fase 1 quedó
corriendo siguiendo estos pasos. Lo marcado como *hallazgo* salió de esa ejecución real.

Contexto del proyecto: `../MIGRATION.md`. Este runbook cubre **solo la Fase 1**.
La API, Caddy, el dominio y el cron de scrapers son fases posteriores y **no se tocan aquí**.

---

## 0. Antes de empezar

Pide al humano estos datos si no los tienes:

- IP o hostname del VPS, usuario SSH y forma de autenticación
- Confirmación de que el VPS es **Debian 12+ o Ubuntu 22.04+** (si es otro SO, detente y pregunta)

Verifica el terreno:

```bash
cat /etc/os-release | head -2
free -m | awk '/Mem:/ {print "RAM total: "$2" MB"}'
df -h / | tail -1
nproc
```

**Reglas duras:**
- Menos de 2 GB de RAM → detente y reporta. Postgres + los scrapers no caben cómodos.
- Si `docker` ya existe y hay contenedores corriendo (`docker ps`), **no los toques**. Reporta qué hay antes de seguir.

**Hallazgo — el template de Hostinger.** Un VPS aprovisionado con la plantilla "PostgreSQL" llega con
un stack en `/docker/postgresql-<sufijo>`: imagen `postgres:17` **sin PostGIS**, base vacía con nombre
generado, y el puerto publicado en `0.0.0.0`. No sirve para este proyecto — verifícalo antes de asumirlo:

```bash
docker exec <contenedor> psql -U <usuario> -d <base> -tAc \
  "SELECT count(*) FROM pg_available_extensions WHERE name='postgis';"   # 0 = no sirve
docker exec <contenedor> psql -U <usuario> -d <base> -c "\dt"           # confirma que está vacío
```

Si da 0 y no hay tablas, **pregunta al humano** antes de borrarlo. Con su visto bueno:

```bash
cd /docker/postgresql-<sufijo> && docker compose down -v && rm -rf /docker/postgresql-<sufijo>
```

---

## 1. Docker

```bash
command -v docker || (curl -fsSL https://get.docker.com | sudo sh)
sudo systemctl enable --now docker
```

**Verifica:**
```bash
docker compose version    # debe imprimir v2.x, no "command not found"
docker run --rm hello-world
```

Si el usuario SSH no es root, dale acceso al socket (y reconecta la sesión, el grupo no aplica en caliente):
```bash
sudo usermod -aG docker "$USER" && exec newgrp docker
```

---

## 2. Firewall

El puerto de Postgres **nunca** se abre a internet. El acceso remoto a la DB es por túnel SSH.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp     # para Caddy, Fase 3 — ábrelos ya, no estorban
sudo ufw --force enable
```

**Verifica:**
```bash
sudo ufw status
ss -tln | grep -v 127.0.0.1    # nada más que el 22 debe escuchar en 0.0.0.0
```

**Hallazgo — ufw no protege puertos de Docker.** Docker escribe sus reglas en la cadena `DOCKER` de
iptables, por debajo de las de ufw: un contenedor publicado en `0.0.0.0` queda accesible desde internet
**aunque ufw diga que el puerto está cerrado**. Lo único que protege la base es el bind `127.0.0.1:5432`
del `docker-compose.yml`. No lo cambies, y usa `ss -tln` (no `ufw status`) para saber qué está expuesto.

---

## 3. El repositorio

Repo público: `https://github.com/4k3sito/4k3sito.github.io`

```bash
sudo mkdir -p /srv && sudo chown "$USER" /srv
git clone https://github.com/4k3sito/4k3sito.github.io.git /srv/officelab
cd /srv/officelab/vps
```

**Verifica:**
```bash
ls docker-compose.yml schema.sql     # los dos deben existir
```

Si `vps/` no existe en el clon, el humano no ha hecho push de esos archivos a `main`.
Detente y pídeselo (o que te los pase por `scp`).

---

## 4. Configuración

```bash
cd /srv/officelab/vps
cp .env.example .env
PW=$(openssl rand -base64 24 | tr -d '/+=')
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$PW|" .env
sed -i "s|CONTRASEÑA|$PW|" .env
chmod 600 .env
```

**Verifica:**
```bash
grep -c 'CONTRASEÑA' .env || echo "ok: placeholder sustituido"   # no debe quedar ninguno
grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2 | wc -c            # > 20 caracteres
```

**Reporta la contraseña al humano una sola vez** y dile que la guarde: sin ella no hay acceso a la DB.
No la escribas en ningún otro archivo ni la subas a git (`.env` ya está en `.gitignore`).

---

## 5. Levantar la base

```bash
cd /srv/officelab/vps
docker compose up -d
docker compose logs -f db     # Ctrl-C cuando aparezca "database system is ready to accept connections"
```

El `schema.sql` **solo corre en un volumen vacío**. Si el volumen ya existía, las tablas no se
crean solas: ver "Reaplicar el esquema" abajo.

**Verifica** (esto es la prueba real de que la Fase 1 quedó):

```bash
docker compose exec db psql -U officelab -d officelab -c "\dt"
```
Esperado — exactamente 6 tablas:
```
 listings | user_listing | cliente | ficha | proceso | ficha_documento
```

```bash
docker compose exec db psql -U officelab -d officelab -c "SELECT postgis_version();"
docker compose exec db psql -U officelab -d officelab -c "\d listings" | grep geom
```
Esperado: una versión de PostGIS 3.x, y `geom | geography(Point,4326)`.

Si faltan tablas o `geom` no aparece, **detente y reporta el output completo**.

**Hallazgo — 43 tablas en vez de 6.** La imagen `postgis/postgis` instala por default el geocodificador
del censo de EE.UU. (`postgis_tiger_geocoder`, ~36 tablas) y `postgis_topology`. Inservibles en México
y ensucian cada `\dt` y cada respaldo. Bórralos (no afectan a `postgis` en sí):

```bash
docker compose exec -T db psql -U officelab -d officelab -c \
  "DROP EXTENSION IF EXISTS postgis_tiger_geocoder CASCADE;
   DROP EXTENSION IF EXISTS postgis_topology CASCADE;
   DROP SCHEMA IF EXISTS tiger, tiger_data, topology CASCADE;"
```

Verifica que PostGIS siguió vivo — debe devolver `2194`:
```bash
docker compose exec -T db psql -U officelab -d officelab -tAc \
  "SELECT ST_Distance('SRID=4326;POINT(-100.3161 25.6866)'::geography,
                      'SRID=4326;POINT(-100.3 25.7)'::geography)::int;"
```

Después de esto, `\dt public.*` debe listar **7**: las 6 del proyecto más `spatial_ref_sys`, que es de PostGIS.

---

## 6. Reaplicar el esquema (solo si el paso 5 no creó las tablas)

Pasa cuando el volumen ya tenía datos. `schema.sql` es idempotente, se puede correr de nuevo:

```bash
docker compose exec -T db psql -U officelab -d officelab < schema.sql
```

Repite la verificación del paso 5.

---

## 6b. La API (Fase 2a)

```bash
cd /srv/officelab/vps
docker compose up -d --build api
docker compose ps          # officelab-api-1 debe quedar Up, en 127.0.0.1:8000
```

**Verifica:**
```bash
docker compose exec -T api python main.py selfcheck    # "ok" — prueba el hashing sin DB
curl -s localhost:8000/api/health                      # {"ok":true}
curl -s -o /dev/null -w "%{http_code}\n" localhost:8000/api/me   # 401 sin sesión
```

**Crea la primera cuenta.** Con contraseña generada (no necesita TTY, la imprime una vez):
```bash
docker compose exec -T api python main.py adduser asesor@ejemplo.mx --generar --nombre "Nombre"
```
O escribiéndola tú, que sí necesita TTY (`-it`, no `-T`):
```bash
docker compose exec -it api python main.py adduser asesor@ejemplo.mx --nombre "Nombre"
docker compose exec -T api python main.py lsusers
```

Prueba el login de punta a punta:
```bash
curl -s -c /tmp/ck -X POST localhost:8000/api/login -H "Content-Type: application/json" \
  -d '{"email":"asesor@ejemplo.mx","password":"LA-QUE-PUSISTE"}'
curl -s -b /tmp/ck localhost:8000/api/me     # debe devolver el usuario
```

**Nota sobre `COOKIE_SECURE`:** mientras se prueba por HTTP plano tiene que estar en `0` en el `.env`.
En cuanto Caddy sirva HTTPS (Fase 3) se pone en `1`; si se queda en `0` la cookie de sesión viaja
por http y deja de estar protegida.

## 6c. Zonas geográficas

Los 51 municipios de Nuevo León como polígonos, para filtrar por zona:

```bash
cd /srv/officelab/vps
docker compose cp zonas.py api:/app/
docker compose exec -T api python zonas.py --estado "Nuevo León"
```

Tarda ~1 min (Nominatim permite 1 request/segundo). **Verifica** — deben ser 51, todas válidas,
y el área total ~64,000 km²:

```bash
docker compose exec -T db psql -U officelab -d officelab -c \
  "SELECT count(*), count(*) FILTER (WHERE ST_IsValid(geom::geometry)) AS validas,
          round(sum(ST_Area(geom))/1e6) AS km2 FROM zona;"
```

Si Overpass devuelve 504 en los 3 espejos, no es un error del script: está saturado. Reintenta
en unos minutos.

## 7. Cargar datos (opcional — requiere que el humano mande los JSONL)

`scrapers/data/` está en `.gitignore`: **el clon no trae datos**. El humano tiene que copiarlos:

```bash
# desde la máquina del humano, no desde el VPS:
scp scrapers/data/*.jsonl usuario@VPS:/srv/officelab/scrapers/data/
```

Luego, en el VPS:

```bash
cd /srv/officelab/scrapers
python3 -m venv .venv
.venv/bin/pip install -q "psycopg[binary]>=3.2"
set -a && . /srv/officelab/vps/.env && set +a
.venv/bin/python propdb.py selfcheck        # debe imprimir "ok"
.venv/bin/python propdb.py load
```

`load` espera los 5 JSONL (`inmuebles24`, `lamudi`, `mercadolibre`, `vivanuncios`, `pincali`).
Si el humano solo mandó algunos, aborta con `faltan: ...` — usa `--only`:

```bash
.venv/bin/python propdb.py load --only lamudi pincali
```

**Verifica:**
```bash
docker compose -f /srv/officelab/vps/docker-compose.yml exec db \
  psql -U officelab -d officelab -c \
  "SELECT source, count(*), count(geom) AS con_coords FROM listings GROUP BY source;"
```
Esperado: una fila por fuente cargada. `con_coords` en 0 para MercadoLibre es normal
(sus coordenadas se rellenan aparte con `ml_geo.py`).

Prueba de que lo geográfico sirve — buscar a 3 km del centro de Monterrey:
```bash
cd /srv/officelab/scrapers
.venv/bin/python propdb.py search --near 25.6866,-100.3161 --radius 3000 --limit 5
```

---

## 8. Respaldo diario

Sin esto, un `docker compose down -v` mal tecleado se lleva todo. Tres líneas:

```bash
mkdir -p /srv/backups
(crontab -l 2>/dev/null; echo '15 4 * * * cd /srv/officelab/vps && docker compose exec -T db pg_dump -U officelab officelab | gzip > /srv/backups/officelab-$(date +\%F).sql.gz && find /srv/backups -name "officelab-*.sql.gz" -mtime +14 -delete') | crontab -
```

**Verifica** (corre el respaldo una vez a mano):
```bash
cd /srv/officelab/vps && docker compose exec -T db pg_dump -U officelab officelab | gzip > /srv/backups/test.sql.gz
ls -lh /srv/backups/test.sql.gz     # debe pesar > 1 KB
```

---

## Lo que NO se hace en esta fase

- No abrir el puerto 5432 al exterior, ni cambiar el bind `127.0.0.1` del `docker-compose.yml`.
- No instalar Caddy, nginx ni certificados: eso es Fase 3.
- No configurar el cron de scrapers: es Fase 4, y necesita credenciales de proxy residencial que
  aquí no existen. Correrlos sin proxy desde la IP del VPS quema la IP con los portales.
- No tocar el proyecto de Supabase: sigue en producción hasta la Fase 5.
- No hacer `docker compose down -v` (la `-v` borra el volumen y con él la base).

## Ajuste opcional de Postgres

El default (`shared_buffers=128MB`) alcanza para arrancar. Solo si el VPS tiene 8 GB+ **y** el
humano reporta consultas lentas, agrega al servicio `db` del compose:

```yaml
    command: postgres -c shared_buffers=1GB -c work_mem=32MB -c maintenance_work_mem=512MB
```

## Qué reportar al terminar

1. SO, RAM, CPU y disco libre del VPS.
2. Versión de Docker y de PostGIS.
3. La lista de tablas que devolvió `\dt`.
4. Si se cargaron datos: el conteo por fuente.
5. La contraseña generada (una sola vez, para que el humano la guarde).
6. Cualquier paso que haya fallado, con el output completo.

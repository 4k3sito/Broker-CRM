#!/bin/bash
# Pruebas de la API que necesitan base de datos (`npm run probar:api`).
#
# Levanta un PostGIS desechable (la misma imagen que producción, con los datos en
# memoria), le aplica vps/schema.sql y corre cada `api/prueba_*.py` dentro de la imagen
# de la API. No toca la base de producción ni el esquema `dev`: todo vive en una red de
# Docker propia que se borra al terminar, pase lo que pase.
#
# `python main.py selfcheck` sigue siendo la prueba que corre sin base; esto es lo otro.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

red="officelab-prueba-$$"
db="$red-db"
limpiar() { docker rm -f "$db" >/dev/null 2>&1; docker network rm "$red" >/dev/null 2>&1; }
trap limpiar EXIT

docker build -q -t officelab-api-prueba api >/dev/null || { echo "no se pudo construir la imagen de la API"; exit 1; }
docker network create "$red" >/dev/null || exit 1
docker run -d --name "$db" --network "$red" --tmpfs /var/lib/postgresql/data \
    -e POSTGRES_USER=officelab -e POSTGRES_PASSWORD=prueba -e POSTGRES_DB=prueba \
    postgis/postgis:17-3.5 >/dev/null || exit 1

# Por TCP y no por el socket: durante el arranque la imagen levanta un servidor
# provisional que sólo escucha en el socket, y ése todavía no es el bueno.
for _ in $(seq 90); do
    docker exec "$db" pg_isready -h 127.0.0.1 -U officelab -d prueba -q 2>/dev/null && break
    sleep 1
done

# schema.sql no entra de una sola pasada en una base vacía: `user_listing` nombra a
# `usuario` antes de que exista (está escrito para crecer sobre la base que ya hay).
# Como es idempotente, se repite hasta que una pasada no deje errores.
errores=1
for _ in 1 2 3 4; do
    errores=$(docker exec -i "$db" psql -U officelab -d prueba -q < vps/schema.sql 2>&1 | grep -c '^ERROR')
    [ "$errores" = 0 ] && break
done
[ "$errores" = 0 ] || { echo "vps/schema.sql no se pudo aplicar a una base vacía"; exit 1; }

rc=0
for prueba in api/prueba_*.py; do
    docker run --rm --network "$red" -v "$PWD/api:/app:ro" -e PYTHONDONTWRITEBYTECODE=1 \
        -e DATABASE_URL="postgresql://officelab:prueba@$db:5432/prueba" \
        officelab-api-prueba python "$(basename "$prueba")" || rc=1
done
exit $rc

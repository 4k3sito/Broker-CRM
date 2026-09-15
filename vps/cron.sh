#!/bin/bash
# Fase 4: una corrida semanal de un scraper — barrido fresco → JSONL → PostGIS.
#
#   vps/cron.sh inmuebles24|lamudi|vivanuncios|mercadolibre|pincali
#   vps/cron.sh liveness     # marca activo/revisado_at de lo ya guardado
#   vps/cron.sh selfcheck    # verifica el entorno del cron, sin red ni base
#
# El crontab lo instala vps/SETUP.md. Un solo trabajo a la vez (flock): dos
# scrapers en paralelo se pelean los 2 vCPU y el ancho del proxy, que se paga por GB.
set -uo pipefail
SELF=$(readlink -f "$0")   # $0 es relativo: se resuelve antes del cd
cd /srv/officelab/scrapers || exit 1

f=${1:?uso: cron.sh <fuente|liveness|selfcheck>}
TL=${TL:-21600}          # tope duro 6 h: lamudi, la más lenta, tardó ~5 h en agosto
set -a; . /srv/officelab/vps/.env; set +a   # DATABASE_URL para propdb.py

# Única fuente cuyo script no se llama igual que su JSONL.
script_de() { [ "$1" = vivanuncios ] && echo viva_scraper.py || echo "$1_scraper.py"; }

if [ "$f" = selfcheck ]; then
    rc=0
    for s in inmuebles24 lamudi vivanuncios mercadolibre pincali; do
        [ -f "$(script_de "$s")" ] || { echo "falta $(script_de "$s")"; rc=1; }
    done
    [ -x .venv/bin/python ]  || { echo "falta scrapers/.venv/bin/python"; rc=1; }
    [ -r .env ]              || { echo "falta scrapers/.env (proxy residencial)"; rc=1; }
    [ -n "${DATABASE_URL:-}" ] || { echo "vps/.env no define DATABASE_URL"; rc=1; }
    "$SELF" fuente-inventada 2>/dev/null && { echo "el guardia de fuente no filtra"; rc=1; }
    [ $rc = 0 ] && echo "cron.sh listo"
    exit $rc
fi

# Sin esto un typo en el crontab haría `rm -f data/<typo>.jsonl` sin avisar.
case $f in
    inmuebles24|lamudi|vivanuncios|mercadolibre|pincali|liveness) ;;
    *) echo "fuente inválida: $f" >&2; exit 2 ;;
esac

mkdir -p logs data
exec >>"logs/$f-$(date +%F).log" 2>&1
exec 9>.cron.lock
flock -n 9 || { echo "$(date -Is) otra corrida en curso: salto $f"; exit 0; }
echo "=== $(date -Is) inicio $f"

if [ "$f" = liveness ]; then
    timeout $TL .venv/bin/python liveness.py; rc=$?
    echo "=== $(date -Is) fin $f liveness rc=$rc"
else
    # El .done es el checkpoint de reanudación: sin borrarlo el scraper cree que ya
    # terminó y no baja nada. El JSONL es scratch — lo bueno ya vive en Postgres.
    # Por eso la corrida normal arranca limpia. La excepción es la marca .resume,
    # que la corrida anterior deja al morir a media: entonces se conservan JSONL y
    # checkpoint y el scraper sigue donde quedó. Un nacional de Lamudi no cabe en
    # una sola ventana, y volver a empezar de cero tiraba las horas ya pagadas al
    # proxy. La marca es lo que se busca (y no lo contrario) para que una fuente
    # sin marca se comporte exactamente como antes: sin ella, barrido fresco.
    if [ -f "data/$f.jsonl.resume" ]; then
        rm -f "data/$f.jsonl.resume"
        echo "reanudando: $(wc -l < "data/$f.jsonl.done" 2>/dev/null || echo 0) consulta(s) ya completas"
    else
        rm -f "data/$f.jsonl" "data/$f.jsonl.done"
    fi
    timeout $TL .venv/bin/python "$(script_de "$f")" --out "data/$f.jsonl"; rs=$?
    # Cualquier final que no sea limpio (124 del timeout, o un crash) deja la marca:
    # el checkpoint sólo anota consultas AGOTADAS, así que reanudar nunca se salta
    # datos pendientes — a lo más re-camina la consulta que quedó a medias.
    [ $rs != 0 ] && touch "data/$f.jsonl.resume"
    # Aunque el timeout la corte a media corrida, lo que alcanzó a escribir se carga:
    # el upsert es idempotente y `load` ignora las líneas rotas.
    if [ -s "data/$f.jsonl" ]; then
        .venv/bin/python propdb.py load --only "$f"; rc=$?
    else
        echo "sin datos: el portal bloqueó la corrida entera"; rc=1
    fi
    # Control de calidad: revisa lo que quedó y, si algo huele mal, deja una tarjeta en
    # el tablero del equipo. Nunca tumba la corrida — avisar no es parte del trabajo.
    .venv/bin/python qa.py "$f" || echo "qa: no se pudo revisar la corrida"
    echo "=== $(date -Is) fin $f scrape rc=$rs load rc=$rc"
fi

find logs -name '*.log' -mtime +30 -delete
exit $rc

#!/bin/bash
# Scrapers v2: una corrida de un portal — barrido → PostGIS → detalle de lo nuevo.
#
#   vps/cron-v2.sh vivanuncios|lamudi|mercadolibre|pincali|inmuebles24
#   vps/cron-v2.sh detalle      # trabaja la cola de detalle de todos los portales
#   vps/cron-v2.sh selfcheck    # verifica el entorno, sin red ni base
#
# Convive con vps/cron.sh mientras los scrapers de antes sigan puestos: mismo flock,
# así que nunca corren dos a la vez (2 vCPU, y el proxy se paga por GB).
#
# Códigos de salida de `python -m v2 sweep`, que son el contrato:
#   0 completo · 1 quedaron consultas a medias (se reanuda sola la próxima vez)
#   3 el proxy rechazó la conexión (402/407): es la cuenta, no el portal
set -uo pipefail
cd /srv/officelab/scrapers || exit 1

f=${1:?uso: cron-v2.sh <fuente|detalle|selfcheck>}
TL=${TL:-21600}                     # tope duro 6 h por corrida
DETALLE_MIN=${DETALLE_MIN:-90}      # minutos de detalle tras cada barrido
# Tope de proxy por lote de detalle, en MB. Sólo cuenta para pincali e inmuebles24;
# los otros tres salen directo y su factura es cero.
DETALLE_MB=${DETALLE_MB:-400}
set -a; . /srv/officelab/vps/.env; set +a
PY=.venv/bin/python

if [ "$f" = selfcheck ]; then
    rc=0
    [ -x $PY ]     || { echo "falta scrapers/.venv/bin/python"; rc=1; }
    [ -r .env ]    || { echo "falta scrapers/.env (proxy residencial)"; rc=1; }
    [ -n "${DATABASE_URL:-}" ] || { echo "vps/.env no define DATABASE_URL"; rc=1; }
    $PY -m v2 selfcheck || rc=1
    $PY -m v2.db selfcheck || rc=1
    [ $rc = 0 ] && echo "cron-v2.sh listo"
    exit $rc
fi

case $f in
    vivanuncios|lamudi|mercadolibre|pincali|inmuebles24|detalle) ;;
    *) echo "fuente inválida: $f" >&2; exit 2 ;;
esac

mkdir -p logs
exec >>"logs/v2-$f-$(date +%F).log" 2>&1
exec 9>.cron.lock
flock -n 9 || { echo "$(date -Is) otra corrida en curso: salto $f"; exit 0; }
echo "=== $(date -Is) inicio v2 $f"

detalle() {     # $1 fuente, $2 minutos
    timeout $(( $2 * 60 + 600 )) $PY -m v2 detail "$1" --limit 100000 \
        --max-minutes "$2" --max-mb "$DETALLE_MB"; rd=$?
    # Lo que alcanzó a bajar se aplica aunque el lote haya terminado mal.
    [ -s "data/v2/$1.detail.jsonl" ] && $PY -m v2.db detail "$1"
    echo "--- detalle $1 rc=$rd"
    return $rd
}

if [ "$f" = detalle ]; then
    # La carga inicial son ~50-70 h por portal directo: se reparte en noches.
    for s in vivanuncios lamudi mercadolibre pincali inmuebles24; do
        detalle "$s" "$DETALLE_MIN" || [ $? != 3 ] || break    # proxy muerto: no insistir
    done
    echo "=== $(date -Is) fin v2 detalle"
    exit 0
fi

# Inmuebles24 paga proxy y su inventario es el de Vivanuncios: delta cada semana y
# barrido completo la primera semana del mes.
modo=full
[ "$f" = inmuebles24 ] && [ "$(date +%-d)" -gt 7 ] && modo=delta

timeout "$TL" $PY -m v2 sweep "$f" --mode "$modo"; rs=$?
tag=$f; [ "$modo" = delta ] && tag="$f.delta"
if [ $rs = 3 ]; then
    echo "PROXY SIN SALDO O SIN CREDENCIALES: no es el portal. No se carga nada."
    rc=1
elif [ -s "data/v2/$tag.jsonl" ]; then
    # Completa o a medias, lo que hay se carga: el upsert es idempotente.
    $PY -m v2.db load "$f" --mode "$modo"; rc=$?
    [ $rc = 0 ] && detalle "$f" "$DETALLE_MIN"
else
    echo "sin datos"; rc=1
fi
echo "=== $(date -Is) fin v2 $f modo=$modo scrape rc=$rs load rc=$rc"

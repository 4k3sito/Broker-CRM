#!/bin/bash
# Scrapers v2: una corrida de un portal — barrido → PostGIS → control de calidad →
# detalle de lo nuevo.
#
#   vps/cron-v2.sh vivanuncios|lamudi|mercadolibre|pincali|inmuebles24
#   vps/cron-v2.sh detalle      # trabaja la cola de detalle de los cinco, en paralelo
#   vps/cron-v2.sh selfcheck    # verifica el entorno, sin red ni base
#
# Candados. `.cron.lock`: un barrido a la vez, como siempre. `.portal-X.lock`:
# el barrido y el detalle del MISMO portal nunca corren juntos — dos visitantes desde
# una IP duplican el ritmo y a Lamudi le basta eso para contestar 401, y entonces la
# escalera sube al proxy y el detalle (100 KB por anuncio) se empieza a pagar. El
# detalle suelta el candado entre lotes; el barrido lo espera.
#
# Códigos de salida de `python -m v2 sweep`, que son el contrato:
#   0 completo · 1 quedaron consultas a medias (se reanuda sola la próxima vez)
#   3 el proxy rechazó la conexión (402/407): es la cuenta, no el portal
set -uo pipefail
cd /srv/officelab/scrapers || exit 1

f=${1:?uso: cron-v2.sh <fuente|detalle|selfcheck>}
TL=${TL:-32400}                     # tope duro 9 h: MercadoLibre nacional tarda 6 h 45
LOTE_MIN=${LOTE_MIN:-60}            # minutos de un lote de detalle (entre lotes se carga)
DETALLE_MIN=${DETALLE_MIN:-90}      # minutos de detalle tras cada barrido
DETALLE_H=${DETALLE_H:-6}           # horas que `detalle` trabaja antes de parar sola
# Tope de proxy del detalle, en MB, por portal y por invocación de este script. Los
# tres portales directos no deberían gastar nada: su tope es un fusible, no un presupuesto.
DETALLE_MB=${DETALLE_MB:-400}
DIRECTO_MB=${DIRECTO_MB:-30}
set -a; . /srv/officelab/vps/.env; set +a
PY=.venv/bin/python
FUENTES="vivanuncios lamudi mercadolibre pincali inmuebles24"

if [ "$f" = selfcheck ]; then
    rc=0
    [ -x $PY ]     || { echo "falta scrapers/.venv/bin/python"; rc=1; }
    [ -r .env ]    || { echo "falta scrapers/.env (proxy residencial)"; rc=1; }
    [ -n "${DATABASE_URL:-}" ] || { echo "vps/.env no define DATABASE_URL"; rc=1; }
    $PY -m v2 selfcheck || rc=1
    $PY -m v2.db selfcheck || rc=1
    $PY qa.py --selfcheck || rc=1
    [ $rc = 0 ] && echo "cron-v2.sh listo"
    exit $rc
fi

case $f in
    vivanuncios|lamudi|mercadolibre|pincali|inmuebles24|detalle) ;;
    *) echo "fuente inválida: $f" >&2; exit 2 ;;
esac

mkdir -p logs data/v2
exec >>"logs/v2-$f-$(date +%F).log" 2>&1

tope_mb() { case $1 in pincali) echo "$DETALLE_MB" ;; inmuebles24) echo "${I24_MB:-$DETALLE_MB}" ;;
                       *) echo "$DIRECTO_MB" ;; esac; }

# Trabaja la cola de detalle de un portal por lotes hasta agotar los minutos, el tope
# de proxy o la cola. Cada lote se carga a la base al terminar, así que matar esto
# pierde a lo más un lote.  $1 fuente · $2 minutos · $3 MB de proxy
detalle() {
    local s=$1 fin=$(( $(date +%s) + $2 * 60 )) quedan_mb=$3 rd=0 min mb salida
    while :; do
        min=$(( (fin - $(date +%s)) / 60 ))
        [ "$min" -lt 2 ] && break
        [ "$min" -gt "$LOTE_MIN" ] && min=$LOTE_MIN
        [ "$(awk -v m="$quedan_mb" 'BEGIN{print (m >= 1)}')" = 1 ] || { echo "--- detalle $s: tope de proxy alcanzado"; break; }
        # Inmuebles24 paga proxy y su gemelo de Vivanuncios le copia el detalle gratis:
        # su cola propia no se toca mientras a Vivanuncios le falte por bajar.
        if [ "$s" = inmuebles24 ] && [ "$($PY -m v2.db queue vivanuncios)" -gt 500 ]; then
            echo "--- $(date -Is) detalle inmuebles24: espera a la cola de vivanuncios"
            sleep 1800; continue
        fi
        [ "$($PY -m v2.db queue "$s")" = 0 ] && { echo "--- detalle $s: cola vacía"; break; }
        exec 8>".portal-$s.lock"
        flock -w $(( TL )) 8 || { echo "--- detalle $s: el portal sigue ocupado"; break; }
        timeout $(( min * 60 + 600 )) $PY -m v2 detail "$s" --limit 100000 \
            --max-minutes "$min" --max-mb "$quedan_mb" >"data/v2/$s.detail.out" 2>&1; rd=$?
        salida=$(grep -v ' INFO ' "data/v2/$s.detail.out" | tail -40); echo "$salida"
        # Lo que alcanzó a bajar se aplica aunque el lote haya terminado mal.
        [ -s "data/v2/$s.detail.jsonl" ] && $PY -m v2.db detail "$s"
        flock -u 8
        mb=$(sed -n 's/.*proxy bill \([0-9.]*\) MB.*/\1/p' <<<"$salida" | tail -1)
        quedan_mb=$(awk -v q="$quedan_mb" -v m="${mb:-0}" 'BEGIN{print q - m}')
        echo "--- $(date -Is) detalle $s rc=$rd proxy=${mb:-0} MB"
        [ "$rd" = 3 ] && { echo "PROXY SIN SALDO O SIN CREDENCIALES: detalle $s detenido"; break; }
        [ "$rd" = 124 ] && break
    done
    return "$rd"
}

if [ "$f" = detalle ]; then
    # La carga inicial son días por portal (a un visitante educado por sitio): cada
    # portal trabaja su cola por su cuenta. `DETALLE_H=400 vps/cron-v2.sh detalle`
    # la corre de corrido; sin eso, 6 h y para.
    exec 7>.detalle.lock
    flock -n 7 || { echo "$(date -Is) ya hay un detalle en curso"; exit 0; }
    echo "=== $(date -Is) inicio v2 detalle (${DETALLE_H} h)"
    for s in $FUENTES; do
        detalle "$s" $(( DETALLE_H * 60 )) "$(tope_mb "$s")" &
    done
    wait
    echo "=== $(date -Is) fin v2 detalle"
    exit 0
fi

exec 9>.cron.lock
flock -n 9 || { echo "$(date -Is) otra corrida en curso: salto $f"; exit 0; }
echo "=== $(date -Is) inicio v2 $f"

# La vigencia la da el propio barrido: `v2.db load` de un barrido completo da de baja
# lo que ninguno ha devuelto en 8 días (dos seguidos) y revive lo que reaparece. No hay
# pasada de liveness aparte.
# Inmuebles24 paga proxy y su inventario es el de Vivanuncios: delta cada semana y
# barrido completo la primera semana del mes.
modo=full
[ "$f" = inmuebles24 ] && [ "$(date +%-d)" -gt 7 ] && modo=delta

exec 8>".portal-$f.lock"
flock -w 5400 8 || echo "el detalle de $f no soltó el portal en 90 min: se barre de todos modos"
timeout "$TL" $PY -m v2 sweep "$f" --mode "$modo"; rs=$?
flock -u 8
tag=$f; [ "$modo" = delta ] && tag="$f.delta"
if [ $rs = 3 ]; then
    echo "PROXY SIN SALDO O SIN CREDENCIALES: no es el portal. No se carga nada."
    rc=1
elif [ -s "data/v2/$tag.jsonl" ]; then
    # Completa o a medias, lo que hay se carga: el upsert es idempotente.
    $PY -m v2.db load "$f" --mode "$modo"; rc=$?
else
    echo "sin datos"; rc=1
fi
# Control de calidad: nunca tumba la corrida — avisar no es parte del trabajo.
$PY qa.py "$f" --v2 --modo "$modo" || echo "qa: no se pudo revisar la corrida"
# Detalle de lo nuevo, salvo que la carga de detalle de fondo ya esté en eso.
if [ $rc = 0 ] && flock -n .detalle.lock true; then
    detalle "$f" "$DETALLE_MIN" "$(tope_mb "$f")"
fi
echo "=== $(date -Is) fin v2 $f modo=$modo scrape rc=$rs load rc=$rc"
find logs -name '*.log' -mtime +30 -delete
exit $rc

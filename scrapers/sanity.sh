#!/bin/bash
# Sanity check: la corrida MÁS PEQUEÑA que prueba que cada scraper extrae y trae
# coordenadas. Cada uno con timeout duro: el gasto del proxy se paga por GB.
cd /srv/officelab/scrapers
D=data/sanity; mkdir -p $D; V=.venv/bin/python
TL=${TL:-300}

corre() {
  local n=$1 f=$2; shift 2
  local t0=$SECONDS
  timeout $TL $V ${f}_scraper.py --out $D/$n.jsonl "$@" > $D/$n.log 2>&1
  local rc=$? dt=$((SECONDS-t0))
  local N=0 C=0
  [ -s $D/$n.jsonl ] && {
    N=$(wc -l < $D/$n.jsonl)
    C=$($V - <<PY
import json
c=0
for l in open("$D/$n.jsonl",encoding="utf-8"):
    try:
        d=json.loads(l)
        co=d.get("coordinates")
        c += bool(co and co.get("lat"))
    except Exception: pass
print(c)
PY
)
  }
  local pct=0; [ "$N" -gt 0 ] && pct=$((100*C/N))
  local kb=$(grep -oE "[0-9.]+ ?MB|[0-9.]+ ?KB" $D/$n.log | tail -1)
  echo "RESULT $n rc=$rc ${dt}s listings=$N coords=$C (${pct}%) wire=${kb:-n/d}"
  [ "$N" -eq 0 ] && echo "  DETALLE $n: $(tail -2 $D/$n.log | tr "\n" " " | cut -c1-150)"
}

echo "INICIO sanity check (timeout ${TL}s por scraper, vía proxy residencial)"
corre inmuebles24  inmuebles24  --states nuevo-leon --max-shards 1
corre lamudi       lamudi       --max-pages 1
corre vivanuncios  viva         --page-cap 1
corre mercadolibre mercadolibre --states nuevo-leon
corre pincali      pincali      --only terrenos-en-renta
echo "FIN sanity check"

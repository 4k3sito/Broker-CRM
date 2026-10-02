// Los dos mapas de la ficha —la ubicación de la propiedad y sus comparables— sobre
// MapLibre GL con teselas de OpenFreeMap.
//
// Sin llave y sin Google: las teselas son vectoriales, públicas y de OpenStreetMap
// (docs/INVESTIGACION-ENTORNO.md §3.5). MapLibre va vendorizado en web/vendor/ porque
// la CSP es `script-src 'self'`; su hoja de estilos NO se carga —DESIGN.md manda una
// sola hoja—, así que lo poco que el mapa necesita para acomodarse está en hermes.css
// y los controles (zoom, atribución) son marcado propio de listing.html.
//
// Mismo contrato que mapa.js: un objeto global con `pintar`, y si algo falla se dice
// en una nota en vez de dejar la caja vacía.
const Ubicacion = (() => {
  // El mapa base sigue al tema de la página, como el del tablero (mapa.js).
  const ESTILO = `https://tiles.openfreemap.org/styles/${document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'positron'}`;
  let map = null, pin = null, alFijar = null, esperando = false;

  function aviso(txt) {
    const n = document.getElementById('ubAviso');
    if (!n) return;
    n.textContent = txt ?? '';
    n.hidden = !txt;
  }

  function ponerPin(lat, lng) {
    if (!pin) {
      const el = document.createElement('div');
      el.className = 'ub-pin';
      pin = new maplibregl.Marker({ element: el, anchor: 'center' });
    }
    pin.setLngLat([lng, lat]).addTo(map);
  }

  // `lat`/`lng` pueden venir vacíos (propiedad sin ubicar): el mapa abre en el centro
  // de config.js y sin pin. `onFijar` recibe la coordenada del clic cuando se pidió.
  function pintar(el, { lat, lng, onFijar }) {
    alFijar = onFijar ?? null;
    if (!window.maplibregl) { aviso('No se pudo cargar el mapa.'); return; }
    const cfg = window.OL_CONFIG ?? {};
    const hay = lat != null && lng != null;
    const centro = hay ? [lng, lat] : (cfg.centro ?? [-100.36, 25.66]);
    if (!map) {
      try {
        map = new maplibregl.Map({
          container: el, style: ESTILO, center: centro, zoom: hay ? 15 : (cfg.zoom ?? 11),
          attributionControl: false,     // la atribución va escrita bajo el mapa
          cooperativeGestures: true,     // la rueda desplaza la página, no el mapa
          dragRotate: false, pitchWithRotate: false,
        });
      } catch (e) { aviso('Este navegador no puede dibujar el mapa.'); return; }
      map.touchZoomRotate.disableRotation();
      map.on('error', e => { if (!map.isStyleLoaded()) aviso('No se pudo cargar el mapa base.'); console.warn('mapa:', e.error?.message ?? e); });
      map.on('click', e => {
        if (!esperando || !alFijar) return;
        esperarClic(false);
        ponerPin(e.lngLat.lat, e.lngLat.lng);
        alFijar({ lat: +e.lngLat.lat.toFixed(6), lng: +e.lngLat.lng.toFixed(6) });
      });
    } else if (hay) {
      map.jumpTo({ center: centro, zoom: Math.max(map.getZoom(), 15) });
    }
    if (hay) ponerPin(lat, lng);
    else if (pin) { pin.remove(); }
  }

  // Modo "el siguiente clic fija la ubicación".
  function esperarClic(on) {
    esperando = !!on;
    if (map) map.getCanvas().classList.toggle('ub-cruz', esperando);
    document.getElementById('ubFijar')?.classList.toggle('on', esperando);
    aviso(esperando ? 'Haz clic en el mapa donde está la propiedad.' : null);
  }

  // ── Comparables ────────────────────────────────────────────────────────────
  // Segundo mapa, el de "Mercado comparable": una etiqueta con el precio por m² por
  // cada comparable y la propiedad resaltada. Mismo marcado de pin que el tablero
  // (`.map-pin`), para que se lea igual. `onPin` recibe el id del comparable.
  let mapaCmp = null, pinesCmp = [];
  const corto = n => n >= 1e6 ? `$${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
                   : n >= 1e3 ? `$${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k` : `$${n}`;

  function comparables(el, lista, { sujetoId, onPin } = {}) {
    const nota = txt => { const n = document.getElementById('mkAviso'); if (n) { n.textContent = txt ?? ''; n.hidden = !txt; } };
    if (!window.maplibregl) { nota('No se pudo cargar el mapa.'); return; }
    const conGeo = lista.filter(l => Number.isFinite(l.lat) && Number.isFinite(l.lng));
    if (!conGeo.length) { nota('Sin ubicaciones que mostrar.'); return; }
    // El contenedor se reescribe cada vez que se pinta la tarjeta: mapa nuevo.
    pinesCmp.forEach(m => m.remove());
    pinesCmp = [];
    mapaCmp?.remove();
    try {
      mapaCmp = new maplibregl.Map({
        container: el, style: ESTILO, attributionControl: false, cooperativeGestures: true,
        dragRotate: false, pitchWithRotate: false,
        bounds: conGeo.reduce((b, l) => b.extend([l.lng, l.lat]), new maplibregl.LngLatBounds()),
        fitBoundsOptions: { padding: 50, maxZoom: 15 },
      });
    } catch (e) { nota('Este navegador no puede dibujar el mapa.'); return; }
    mapaCmp.touchZoomRotate.disableRotation();
    mapaCmp.on('error', e => { if (!mapaCmp.isStyleLoaded()) nota('No se pudo cargar el mapa base.'); console.warn('mapa:', e.error?.message ?? e); });
    // El sujeto al final: queda encima de los comparables que le caen cerca.
    for (const l of conGeo.slice().sort((a, b) => (a.id === sujetoId) - (b.id === sujetoId))) {
      const pin = document.createElement('div');
      pin.className = 'map-pin' + (l.id === sujetoId ? ' on' : '');
      pin.textContent = l.precio != null ? corto(Math.round(l.precio)) : 's/p';
      pin.title = l.titulo ?? '';
      if (l.id !== sujetoId) pin.addEventListener('click', () => onPin?.(l.id));
      pinesCmp.push(new maplibregl.Marker({ element: pin, anchor: 'center' }).setLngLat([l.lng, l.lat]).addTo(mapaCmp));
    }
    const sin = lista.length - conGeo.length;
    nota(sin ? `${sin} de ${lista.length} sin ubicación` : null);
  }

  return {
    pintar, esperarClic, comparables,
    zoom: d => map && (d > 0 ? map.zoomIn() : map.zoomOut()),
    zoomCmp: d => mapaCmp && (d > 0 ? mapaCmp.zoomIn() : mapaCmp.zoomOut()),
  };
})();

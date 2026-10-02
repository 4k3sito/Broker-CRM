// Mapa del tablero, sincronizado con la rejilla. Pinta un pin con el precio por cada
// inmueble de la página visible; el hover en una tarjeta resalta su pin y el clic en
// un pin resalta su tarjeta. Con "Buscar al mover el mapa" activo, el centro y el
// radio visibles se vuelven el filtro `near`/`radio` que ya entiende la API — no hace
// falta un endpoint nuevo.
//
// Es MapLibre GL con teselas de OpenFreeMap, igual que los mapas de la ficha
// (ubicacion.js): sin llave y sin Google. Hasta el 2026-10-01 fue Google Maps; el
// contrato del objeto `Mapa` no cambió, así que app.js no se enteró del cambio.
// MapLibre va vendorizado (web/vendor/) y sin su hoja de estilos: el zoom y la
// atribución son marcado propio de index.html.
const Mapa = (() => {
  const cfg = window.OL_CONFIG ?? {};
  let map = null, pins = new Map(), opts = {}, seguir = false;

  const corto = n => n >= 1e6 ? `$${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
                   : n >= 1e3 ? `$${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k` : `$${n}`;

  function metros(a, b) {
    const R = 6371e3, r = x => x * Math.PI / 180;
    const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function nota(txt) {
    const n = document.getElementById('mapNote');
    if (!n) return;
    n.hidden = !txt; n.textContent = txt ?? '';
  }

  function init(el, o = {}) {
    opts = o;
    if (!window.maplibregl) { nota('No se pudo cargar el mapa.'); return; }
    const oscuro = document.documentElement.getAttribute('data-theme') === 'dark';
    try {
      map = new maplibregl.Map({
        container: el,
        style: `https://tiles.openfreemap.org/styles/${oscuro ? 'dark' : 'positron'}`,
        center: cfg.centro ?? [-100.36, 25.66], zoom: cfg.zoom ?? 11,
        attributionControl: false, dragRotate: false, pitchWithRotate: false,
      });
    } catch (e) { nota('Este navegador no puede dibujar el mapa.'); return; }
    map.touchZoomRotate.disableRotation();
    map.on('error', e => { if (!map.isStyleLoaded()) nota('No se pudo cargar el mapa base.'); console.warn('mapa:', e.error?.message ?? e); });
    // Sólo los movimientos de la persona disparan la búsqueda: los que hace el propio
    // tablero al encuadrar los resultados no traen `originalEvent` ni `usuario`.
    map.on('moveend', e => {
      if (!seguir || !opts.onMove || !(e.originalEvent || e.usuario)) return;
      const c = map.getCenter(), b = map.getBounds();
      const radio = Math.round(metros({ lat: c.lat, lng: c.lng }, { lat: c.lat, lng: b.getEast() }) / 100) * 100;
      opts.onMove({ lat: c.lat, lng: c.lng, radio: Math.max(500, Math.min(12000, radio)) });
    });
    document.getElementById('mapMas')?.addEventListener('click', () => map.zoomIn({}, { usuario: true }));
    document.getElementById('mapMenos')?.addEventListener('click', () => map.zoomOut({}, { usuario: true }));
  }

  function pintar(lista) {
    if (!map) return;
    pins.forEach(p => p.marker.remove());
    pins = new Map();
    const conGeo = lista.filter(l => Number.isFinite(l.lat) && Number.isFinite(l.lng));
    for (const l of conGeo) {
      const el = document.createElement('div');
      el.className = 'map-pin';
      el.textContent = l.precio?.monto != null ? corto(Math.round(l.precioTotal ?? l.precio.monto)) : 's/p';
      el.title = l.titulo ?? '';
      el.addEventListener('mouseenter', () => opts.onPinHover?.(l.id));
      el.addEventListener('mouseleave', () => opts.onPinHover?.(null));
      el.addEventListener('click', () => opts.onPin?.(l.id));
      pins.set(l.id, { el, marker: new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([l.lng, l.lat]).addTo(map) });
    }
    const sin = lista.length - conGeo.length;
    nota(sin ? `${sin} de ${lista.length} sin ubicación en esta página` : null);
    // Si el usuario está navegando el mapa, no se le mueve la cámara.
    if (!seguir && conGeo.length) {
      if (conGeo.length === 1) map.jumpTo({ center: [conGeo[0].lng, conGeo[0].lat], zoom: 15 });
      else map.fitBounds(conGeo.reduce((b, l) => b.extend([l.lng, l.lat]), new maplibregl.LngLatBounds()),
                         { padding: 60, maxZoom: 16, animate: false });
    }
  }

  function resaltar(id) {
    pins.forEach((p, k) => {
      p.el.classList.toggle('on', k === id);
      p.el.style.zIndex = k === id ? '10' : '';
    });
  }

  return {
    init, pintar, resaltar,
    seguir: v => { seguir = v; },
    resize: () => { map?.resize(); },
  };
})();

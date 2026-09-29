// Mapa de Google Maps sincronizado con la rejilla. Pinta un pin con el precio por
// cada inmueble de la página visible; el hover en una tarjeta resalta su pin y
// el clic en un pin resalta su tarjeta. Con "Buscar al mover el mapa" activo, el
// centro y el radio visibles se vuelven el filtro `near`/`radio` que ya entiende
// la API — no hace falta un endpoint nuevo.
//
// El script de Google se carga desde aquí (no desde el HTML) para poder mostrar
// un aviso claro si falta la llave, y porque la CSP no permite scripts inline.
const Mapa = (() => {
  const cfg = window.OL_CONFIG ?? {};
  let map = null, pins = new Map(), opts = {}, seguir = false, ignorarMov = false;
  let Marker = null, pendiente = null;

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

  function cargarGoogle() {
    return new Promise((ok, mal) => {
      if (window.google?.maps?.importLibrary) return ok();
      window.__olMapsListo = () => ok();
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(cfg.googleMapsKey)}` +
              `&v=weekly&loading=async&language=es&region=MX&callback=__olMapsListo`;
      s.async = true;
      s.onerror = () => mal(new Error('No se pudo cargar Google Maps'));
      document.head.appendChild(s);
    });
  }

  async function init(el, o = {}) {
    opts = o;
    if (!cfg.googleMapsKey || cfg.googleMapsKey.includes('PEGA_AQUI')) { nota('Falta la llave de Google Maps en config.js.'); return; }
    try { await cargarGoogle(); } catch (e) { nota(e.message + '. Revisa la llave o la CSP.'); return; }
    const { Map: GMap } = await google.maps.importLibrary('maps');
    ({ AdvancedMarkerElement: Marker } = await google.maps.importLibrary('marker'));
    const [lng, lat] = cfg.centro ?? [-100.36, 25.66];
    const oscuro = document.documentElement.getAttribute('data-theme') === 'dark';
    map = new GMap(el, {
      center: { lat, lng }, zoom: cfg.zoom ?? 11,
      mapId: cfg.googleMapId ?? 'DEMO_MAP_ID',
      colorScheme: oscuro ? 'DARK' : 'LIGHT',
      disableDefaultUI: true, zoomControl: true, clickableIcons: false, gestureHandling: 'greedy',
    });
    map.addListener('idle', () => {
      if (ignorarMov) { ignorarMov = false; return; }
      if (!seguir || !opts.onMove) return;
      const c = map.getCenter(), b = map.getBounds();
      if (!c || !b) return;
      const radio = Math.round(metros({ lat: c.lat(), lng: c.lng() }, { lat: c.lat(), lng: b.getNorthEast().lng() }) / 100) * 100;
      opts.onMove({ lat: c.lat(), lng: c.lng(), radio: Math.max(500, Math.min(12000, radio)) });
    });
    // Si la rejilla ya pintó antes de que cargara Google, se pinta ahora.
    if (pendiente) { const p = pendiente; pendiente = null; pintar(p); }
  }

  function pintar(lista) {
    if (!map || !Marker) { pendiente = lista; return; }
    pins.forEach(p => { p.marker.map = null; });
    pins = new Map();
    const conGeo = lista.filter(l => Number.isFinite(l.lat) && Number.isFinite(l.lng));
    for (const l of conGeo) {
      const el = document.createElement('div');
      el.className = 'map-pin';
      el.textContent = l.precio?.monto != null ? corto(Math.round(l.precioTotal ?? l.precio.monto)) : 's/p';
      el.title = l.titulo ?? '';
      el.addEventListener('mouseenter', () => opts.onPinHover?.(l.id));
      el.addEventListener('mouseleave', () => opts.onPinHover?.(null));
      const marker = new Marker({ map, position: { lat: l.lat, lng: l.lng }, content: el, gmpClickable: true });
      marker.addListener('click', () => opts.onPin?.(l.id));
      pins.set(l.id, { el, marker });
    }
    const sin = lista.length - conGeo.length;
    nota(sin ? `${sin} de ${lista.length} sin ubicación en esta página` : null);
    // Si el usuario está navegando el mapa, no se le mueve la cámara.
    if (!seguir && conGeo.length) {
      const b = new google.maps.LatLngBounds();
      conGeo.forEach(l => b.extend({ lat: l.lat, lng: l.lng }));
      ignorarMov = true;
      if (conGeo.length === 1) { map.setCenter(b.getCenter()); map.setZoom(15); }
      else map.fitBounds(b, 60);
    }
  }

  function resaltar(id) {
    pins.forEach((p, k) => {
      p.el.classList.toggle('on', k === id);
      p.marker.zIndex = k === id ? 10 : null;
    });
  }

  return {
    init, pintar, resaltar,
    seguir: v => { seguir = v; },
    resize: () => { if (map) google.maps.event.trigger(map, 'resize'); },
  };
})();

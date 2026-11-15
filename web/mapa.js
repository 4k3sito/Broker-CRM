// Mapa del tablero, sincronizado con la rejilla. Pinta un pin con el precio por cada
// inmueble de la página visible; el hover en una tarjeta resalta su pin y el clic en
// un pin resalta su tarjeta. Con "Buscar al mover el mapa" activo, el centro y el
// radio visibles se vuelven el filtro `near`/`radio` que ya entiende la API — no hace
// falta un endpoint nuevo.
//
// Agrupación (clusters): con muchos pines juntos el mapa era una mancha de precios. Los puntos van
// a una fuente GeoJSON con `cluster: true` y la agrupación la hace MapLibre; los pines y los
// grupos se siguen dibujando como marcado propio (HTML), según lo que la fuente dice que se ve
// en cada momento. Un grupo enseña cuántos inmuebles junta y un clic acerca hasta separarlos.
// El resalte tarjeta ↔ pin sigue valiendo: si el pin de una tarjeta está dentro de un grupo, se
// resalta el grupo.
//
// Es MapLibre GL con teselas de OpenFreeMap, igual que los mapas de la ficha
// (ubicacion.js): sin llave y sin Google. Hasta el 2026-10-01 fue Google Maps; el
// contrato del objeto `Mapa` no cambió, así que app.js no se enteró del cambio.
// MapLibre va vendorizado (web/vendor/) y sin su hoja de estilos: el zoom y la
// atribución son marcado propio de index.html.
const Mapa = (() => {
  const cfg = window.OL_CONFIG ?? {};
  const FUENTE = 'inmuebles', CAPA = 'inmuebles-sonda';
  let map = null, opts = {}, seguir = false;
  // `pins`: un pin (elemento y marcador) por inmueble con coordenadas de la página pintada; sólo
  // está en el mapa el que la fuente dice que no está agrupado. `grupos`: los grupos a la vista.
  let pins = new Map(), grupos = new Map();
  let geo = { type: 'FeatureCollection', features: [] };
  let version = 0;            // cada `pintar` sube la versión: lo que la fuente devuelve de una anterior se ignora
  let estiloListo = false;    // la fuente se monta en cada `style.load`: cambiar de tema la borra
  let resaltado = null;       // el inmueble resaltado (desde su tarjeta); null si ninguno
  let pinHover = null;        // el pin bajo el ratón o con foco
  let encuadrePendiente = null;   // un encuadre que no cupo porque el mapa estaba escondido

  const corto = n => n >= 1e6 ? `$${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
                   : n >= 1e3 ? `$${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k` : `$${n}`;

  // Lo que dice el pin, y su versión larga para el lector de pantalla. Un pin sin «/mes» ni
  // moneda era ambiguo: «$45k» podía ser una renta o un precio, en pesos o en dólares (R1-11).
  function textoPin(l) {
    const o = Anuncio.ofertas(l, opts.operacion?.())[0];
    if (o.monto == null) return { corto: 'Sin precio', largo: 'Sin precio' };
    const mon = Anuncio.moneda(l), usd = mon !== 'MXN';
    const unidad = (o.parcial ? '/m²' : '') + (o.op === 'Renta' ? '/mes' : '');
    return { corto: corto(Math.round(o.monto)) + unidad + (usd ? ` ${mon}` : ''),
             largo: `$${Math.round(o.monto).toLocaleString('es-MX')} ${mon}${o.parcial ? ' por m²' : ''}${o.op === 'Renta' ? ' al mes' : ''}` };
  }

  // El estilo de OpenFreeMap según el tema: claro «positron», oscuro «dark».
  const estilo = oscuro => `https://tiles.openfreemap.org/styles/${oscuro ? 'dark' : 'positron'}`;

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
        style: estilo(oscuro),
        center: cfg.centro ?? [-100.36, 25.66], zoom: cfg.zoom ?? 11,
        attributionControl: false, dragRotate: false, pitchWithRotate: false,
      });
    } catch (e) { nota('Este navegador no puede dibujar el mapa.'); return; }
    map.touchZoomRotate.disableRotation();
    map.on('style.load', () => { estiloListo = true; montarFuente(); });
    // Cada cuadro, lo que la fuente ve se compara con lo que está dibujado.
    map.on('render', sincronizar);
    map.on('error', e => { if (!map.isStyleLoaded()) nota('No se pudo cargar el mapa base.'); console.warn('mapa:', e.error?.message ?? e); });
    // Sólo los movimientos de la persona disparan la búsqueda: los que hace el propio
    // tablero al encuadrar los resultados no traen `originalEvent` ni `usuario`.
    map.on('moveend', e => {
      if (!seguir || !opts.onMove || !(e.originalEvent || e.usuario)) return;
      opts.onMove(area());
    });
    // Cambiar el tema desde el botón de la topbar (theme.js) no recargaba el mapa: en oscuro las
    // calles seguían en el estilo claro. `setStyle` deja los pines, que son marcado propio.
    document.addEventListener('ol-tema', e => { estiloListo = false; map.setStyle(estilo(!!e.detail?.oscuro)); });
    document.getElementById('mapMas')?.addEventListener('click', () => map.zoomIn({}, { usuario: true }));
    document.getElementById('mapMenos')?.addEventListener('click', () => map.zoomOut({}, { usuario: true }));
  }

  // Lo que el mapa enseña, como lo pide el filtro `near`/`radio`: el centro y la mitad
  // del ancho visible, acotada a lo que acepta el control de radio. null sin mapa.
  function area() {
    if (!map) return null;
    const c = map.getCenter(), b = map.getBounds();
    const radio = Math.round(metros({ lat: c.lat, lng: c.lng }, { lat: c.lat, lng: b.getEast() }) / 100) * 100;
    return { lat: c.lat, lng: c.lng, radio: Math.max(500, Math.min(12000, radio)) };
  }

  // La cámara, para guardarla en la URL y volver a ella al recargar. null si no se ha
  // movido de la de fábrica: esa no hace falta escribirla. `ir` no dispara la
  // búsqueda: el `moveend` que provoca no trae `originalEvent` ni `usuario`.
  function vista() {
    if (!map) return null;
    const c = map.getCenter(), [lng0, lat0] = cfg.centro ?? [-100.36, 25.66];
    const z = map.getZoom();
    if (Math.abs(c.lat - lat0) < 1e-5 && Math.abs(c.lng - lng0) < 1e-5 && Math.abs(z - (cfg.zoom ?? 11)) < 0.01) return null;
    return { lat: c.lat, lng: c.lng, zoom: z };
  }
  function ir({ lat, lng, zoom }) { map?.jumpTo({ center: [lng, lat], zoom }); }

  // La fuente de puntos y una capa invisible: sin ninguna capa que la use, MapLibre no carga sus
  // teselas y `querySourceFeatures` no devolvería nada.
  function montarFuente() {
    if (!map || map.getSource(FUENTE)) return;
    // `v` viaja en cada punto y, con `clusterProperties`, también en cada grupo.
    map.addSource(FUENTE, { type: 'geojson', data: geo, cluster: true, clusterRadius: 56, clusterMaxZoom: 17,
                            clusterProperties: { v: ['max', ['get', 'v']] } });
    map.addLayer({ id: CAPA, type: 'circle', source: FUENTE, paint: { 'circle-radius': 1, 'circle-opacity': 0 } });
  }

  function quitarPin(id, p) {
    if (!p.puesto) return;
    p.marker.remove(); p.puesto = false;
    // Un pin que se agrupa bajo el ratón no recibe `mouseleave`: se suelta aquí, o su tarjeta se quedaría resaltada.
    if (pinHover === id) { pinHover = null; opts.onPinHover?.(null); }
  }

  function crearGrupo(f) {
    const n = f.properties.point_count, id = f.properties.cluster_id;
    const el = document.createElement('div');
    el.className = 'map-cluster' + (n >= 50 ? ' g' : n >= 10 ? ' m' : '');
    el.textContent = n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
    el.title = `${n} inmuebles juntos. Clic para acercar`;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `${n} inmuebles agrupados. Acercar`);
    const acercar = async () => {
      try {
        const z = await map.getSource(FUENTE).getClusterExpansionZoom(id);
        // `usuario`: es la persona navegando, así que con «Buscar al mover el mapa» también busca.
        map.easeTo({ center: f.geometry.coordinates, zoom: Math.min(z + 0.5, 19) }, { usuario: true });
      } catch (e) { console.warn('mapa: no se pudo acercar el grupo', e); }
    };
    el.addEventListener('click', acercar);
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); acercar(); }
    });
    const g = { el, ids: null, marker: new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(f.geometry.coordinates).addTo(map) };
    // Qué inmuebles junta, para resaltar el grupo cuando se apunta a la tarjeta de uno de ellos.
    map.getSource(FUENTE).getClusterLeaves(id, 1000, 0)
      .then(hojas => { g.ids = new Set(hojas.map(h => h.properties.id)); aplicarResalte(); })
      .catch(() => {});
    return g;
  }

  // Dibuja lo que la fuente dice que se ve: pines sueltos y grupos. Se llama en cada cuadro, así
  // que no hace nada si no cambió el conjunto.
  function sincronizar() {
    if (!map || !map.getSource(FUENTE) || !map.isSourceLoaded(FUENTE)) return;
    const sueltos = new Set(), claves = new Set();
    for (const f of map.querySourceFeatures(FUENTE)) {
      const pr = f.properties;
      if (pr.v !== version) continue;                       // de un `pintar` anterior
      if (pr.cluster) {
        claves.add(pr.cluster_id);
        if (!grupos.has(pr.cluster_id)) grupos.set(pr.cluster_id, crearGrupo(f));
      } else sueltos.add(pr.id);
    }
    // No se sabe todavía qué hay a la vista (teselas sin cargar): se deja lo que está.
    if (!sueltos.size && !claves.size && geo.features.length) return;
    grupos.forEach((g, k) => { if (!claves.has(k)) { g.marker.remove(); grupos.delete(k); } });
    pins.forEach((p, id) => {
      if (sueltos.has(id)) { if (!p.puesto) { p.marker.addTo(map); p.puesto = true; } }
      else quitarPin(id, p);
    });
    aplicarResalte();
  }

  // `info` trae lo que el mapa no sabe: cuántos resultados tiene la búsqueda y qué página es.
  // Sólo se dibujan los de la página visible, y la nota lo dice (R1-11).
  function pintar(lista, info = {}) {
    if (!map) return;
    pins.forEach((p, id) => quitarPin(id, p));
    grupos.forEach(g => g.marker.remove());
    pins = new Map(); grupos = new Map();
    version++;
    const conGeo = lista.filter(l => Number.isFinite(l.lat) && Number.isFinite(l.lng));
    for (const l of conGeo) {
      const el = document.createElement('div');
      el.className = 'map-pin';
      // El precio de la operación que se busca: un local en renta y venta, buscando
      // renta, enseña su renta (`opts.operacion` es el filtro del tablero).
      const t = textoPin(l);
      el.textContent = t.corto;
      el.title = l.titulo ? `${t.largo} · ${l.titulo}` : t.largo;
      // Un pin es un botón: se alcanza con Tab, resalta su tarjeta al enfocarlo y Enter o
      // Espacio la llevan a la vista, como el clic.
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', `${t.largo}${l.titulo ? `, ${l.titulo}` : ''}. Ir a su tarjeta`);
      const hover = id => { pinHover = id; opts.onPinHover?.(id); };
      el.addEventListener('mouseenter', () => hover(l.id));
      el.addEventListener('mouseleave', () => hover(null));
      el.addEventListener('focus', () => hover(l.id));
      el.addEventListener('blur', () => hover(null));
      el.addEventListener('click', () => opts.onPin?.(l.id));
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onPin?.(l.id); }
      });
      // El marcador no se agrega al mapa aquí: `sincronizar` lo hace si el pin no está agrupado.
      pins.set(l.id, { el, puesto: false, marker: new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([l.lng, l.lat]) });
    }
    geo = { type: 'FeatureCollection', features: conGeo.map(l => ({
      type: 'Feature', properties: { id: l.id, v: version }, geometry: { type: 'Point', coordinates: [l.lng, l.lat] } })) };
    const fuente = map.getSource(FUENTE);
    if (fuente) fuente.setData(geo);
    else if (estiloListo) montarFuente();     // si no, `style.load` la monta con este `geo`
    map.triggerRepaint();
    const sin = lista.length - conGeo.length;
    const fmt = n => n.toLocaleString('es-MX');
    // «70 de 11,093 · página 1»: sin esto parecía que el mapa enseñaba todo el resultado.
    const parte = lista.length ? `${fmt(conGeo.length)} de ${fmt(info.total ?? lista.length)} · página ${info.pagina ?? 1}` : '';
    nota(parte ? parte + (sin ? ` · ${fmt(sin)} sin ubicación` : '') : null);
    // Si el usuario está navegando el mapa, no se le mueve la cámara.
    if (!seguir && conGeo.length) {
      encuadrePendiente = conGeo.map(l => [l.lng, l.lat]);
      encuadrar();
    } else encuadrePendiente = null;
  }

  // Encuadra los puntos de la última página. Con el mapa escondido (rejilla sola, o la lista en
  // el teléfono) el contenedor mide 0 y el encuadre saldría mal: queda pendiente hasta `resize`.
  function encuadrar() {
    const c = encuadrePendiente, cont = map.getContainer();
    if (!c || !cont.clientWidth || !cont.clientHeight) return;
    encuadrePendiente = null;
    if (c.length === 1) map.jumpTo({ center: c[0], zoom: 15 });
    else map.fitBounds(c.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds()), { padding: 60, maxZoom: 16, animate: false });
  }

  // El resalte desde la tarjeta: el pin del inmueble, o el grupo que lo contiene.
  function resaltar(id) { resaltado = id; aplicarResalte(); }
  function aplicarResalte() {
    pins.forEach((p, k) => {
      p.el.classList.toggle('on', k === resaltado);
      p.el.style.zIndex = k === resaltado ? '10' : '';
    });
    grupos.forEach(g => {
      const on = resaltado != null && !!g.ids?.has(resaltado);
      g.el.classList.toggle('on', on);
      g.el.style.zIndex = on ? '10' : '';
    });
  }

  return {
    init, pintar, resaltar, area, vista, ir,
    seguir: v => { seguir = v; },
    resize: () => { map?.resize(); encuadrar(); },
  };
})();

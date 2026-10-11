// El anuncio en el navegador, definido una vez. La API manda filas de `listings` (o
// una ficha propia disfrazada de anuncio); aquí se convierten en el objeto que pintan
// el tablero, la ficha y comparar, y aquí viven las reglas que dependen de él: qué
// precio se enseña, cuál es el total, cómo se llaman su estado, su operación y su
// fuente.
//
// Existe porque cada página tenía su propia traducción y ya no decían lo mismo: el
// tablero guardaba el precio como `{ monto, moneda }` y la ficha como número; comparar
// llamaba «Renta» a una ficha propia sin operación; la nota de $/m² del segundo precio
// salía en el tablero y no en la ficha. Una regla de precio que cambie, cambia aquí.
//
// No toca la red ni el DOM: recibe datos y devuelve datos. El marcado es de cada
// página. Usa `mx` de texto.js, que se carga antes. Sus pruebas están en pruebas/web/ (`npm run probar:web`).
const Anuncio = (() => {
  const ESTADOS = ['Nuevo', 'Revisado', 'Contactado', 'Rentado', 'Descartado'];
  const ESTADO_API = { Nuevo: 'new', Revisado: 'reviewed', Contactado: 'contacted', Rentado: 'rented', Descartado: 'discarded' };
  const ESTADO_DE_API = Object.fromEntries(Object.entries(ESTADO_API).map(([k, v]) => [v, k]));
  const OPERACION_DE_API = { rent: 'Renta', rental: 'Renta', sale: 'Venta' };
  // Cómo se llama cada fuente en pantalla. Trae también portales que ya no se scrapean:
  // sus anuncios siguen en el inventario.
  const FUENTES = {
    inmuebles24: 'Inmuebles24', lamudi: 'Lamudi', vivanuncios: 'Vivanuncios', mercadolibre: 'MercadoLibre',
    pincali: 'Pincali', easybroker: 'EasyBroker', metroscubicos: 'Metros²',
    propiedadesmx: 'PropiedadesMX', propiedadesmexico: 'PropiedadesMX',
    pipeline: 'Pipeline',   // las fichas propias (ver _origen en la API)
  };

  const num = v => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n; };

  // `location` llega como texto, como JSON en texto o como objeto, según el portal.
  function lugar(loc) {
    if (loc == null) return null;
    let v = loc;
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s.startsWith('{')) return s;
      try { v = JSON.parse(s); } catch { return s; }
    }
    return (v && typeof v === 'object') ? (v.name ?? null) : null;
  }

  // Fila de la API → anuncio. `precio` es el número que publicó el portal: si `porM2`
  // está puesto es $/m² y el total viene en `precioTotal` (ver `total`).
  function de(l) {
    return {
      id: l.id,
      fuente: l.source ?? 'desconocido',
      codigo: l.source === 'pipeline' ? null : (l.external_id ?? null),   // el uuid de la ficha no es un código
      titulo: l.title ?? l.broker_name ?? null,
      direccion: lugar(l.location) ?? l.neighborhood ?? null,
      zona: l.zona ?? null,
      precio: l.price_numeric ?? null,
      moneda: l.currency ?? 'MXN',
      porM2: l.price_is_per_m2 ?? false,
      precioTotal: l.precio_total ?? null,
      alt: l.operacion_alt
        ? { monto: l.precio_alt, op: l.operacion_alt, porM2: l.precio_alt_por_m2 ?? false, total: l.precio_alt_total }
        : null,
      fotos: (l.images?.length ? l.images : (l.image ? [l.image] : [])),
      url: l.url ?? null, whatsapp: l.whatsapp ?? null, mapsUrl: l.maps_url ?? null,
      status: ESTADO_DE_API[l.status] ?? 'Nuevo',
      starred: l.starred ?? false,
      notes: l.notes ?? '',
      tipo: l.property_type ?? null,
      size: l.property_size_m2 ?? null,
      terreno: l.terreno_m2 ?? null, construccion: l.construccion_m2 ?? null,
      // Una ficha propia no siempre dice si es renta o venta: sin operación, no "Renta".
      transaccion: OPERACION_DE_API[l.transaction_type] ?? (l.source === 'pipeline' ? null : 'Renta'),
      descripcion: l.description ?? null, features: l.features ?? [],
      // Coordenadas para el mapa. Se aceptan los nombres más comunes; si la API no las
      // manda, el inmueble simplemente no lleva pin.
      lat: num(l.lat ?? l.latitude ?? l.geo?.lat ?? l.location?.lat),
      lng: num(l.lng ?? l.lon ?? l.longitude ?? l.geo?.lng ?? l.location?.lng),
      geoOrigen: l.geo_origen ?? null,
    };
  }

  // ── Precio ─────────────────────────────────────────────────────────────────
  // Varios portales publican "$700" queriendo decir "$700 por m²". Enseñar ese número
  // como total convierte un terreno de 7.5 MDP en uno de $700.

  // Lo que cuesta el inmueble entero, o null si no se sabe.
  const total = a => a.porM2 ? a.precioTotal : a.precio;

  // $/m²: del total y la superficie; sin superficie, sólo si el portal lo publicó así.
  function porMetro(a) {
    const t = total(a);
    return t && a.size ? t / a.size : (a.porM2 ? a.precio : null);
  }

  // El número que se pinta como precio. `unitario` es el $/m² publicado del que salió
  // el total; `parcial` avisa de que no hay total y lo que se enseña ES el unitario.
  function precioVisible(a) {
    if (a.precio == null) return null;
    if (!a.porM2) return { monto: a.precio, parcial: false, unitario: null };
    return a.precioTotal
      ? { monto: a.precioTotal, parcial: false, unitario: a.precio }
      : { monto: a.precio, parcial: true, unitario: a.precio };
  }

  // La segunda oferta de un inmueble que está en renta Y en venta, ya en texto: null
  // si no la hay. `precio` es null cuando se sabe que existe pero aún no su monto, y
  // `nota` trae el $/m² publicado cuando lo que se enseña es el total calculado.
  function segundoPrecio(a) {
    const alt = a.alt;
    if (!alt?.op) return null;
    const etiqueta = alt.op === 'rent' ? 'También en renta' : 'También en venta';
    if (alt.monto == null) return { etiqueta, precio: null, nota: null };
    const conTotal = alt.porM2 && alt.total;
    const unidad = alt.porM2 && !conTotal ? '/m²' : '';
    const sufijo = alt.op === 'rent' ? '/mes' : '';
    return {
      etiqueta,
      precio: `$${mx(Math.round(conTotal ? alt.total : alt.monto))}${unidad}${sufijo}`,
      nota: conTotal ? `($${mx(alt.monto)}/m²)` : null,
    };
  }

  // ── Etiquetas y ubicación ──────────────────────────────────────────────────

  // El estado del asesor, en la clave que guarda la API.
  const estadoApi = estado => ESTADO_API[estado] ?? estado;
  // El nombre de una fuente a partir de su clave (`anuncio.fuente`, o una faceta).
  const fuente = clave => FUENTES[clave] ?? clave;
  // Dónde está, en una línea: la dirección, y a falta de ella el municipio.
  const ubicacion = a => a.direccion ?? a.zona ?? null;

  return { ESTADOS, de, total, porMetro, precioVisible, segundoPrecio, estadoApi, fuente, ubicacion };
})();

const STATUSES = ['Nuevo', 'Revisado', 'Contactado', 'Rentado', 'Descartado'];

const STATUS_FROM_API = { new: 'Nuevo', reviewed: 'Revisado', contacted: 'Contactado', rented: 'Rentado', discarded: 'Descartado' };
const STATUS_TO_API   = { Nuevo: 'new', Revisado: 'reviewed', Contactado: 'contacted', Rentado: 'rented', Descartado: 'discarded' };

const FUENTE_CONFIG = {
  easybroker:        { label: 'EasyBroker',    badge: 'eb'     },
  inmuebles24:       { label: 'Inmuebles24',   badge: 'i24'    },
  lamudi:            { label: 'Lamudi',        badge: 'lamudi' },
  vivanuncios:       { label: 'Vivanuncios',   badge: 'viva'   },
  metroscubicos:     { label: 'Metros²',       badge: 'metro'  },
  mercadolibre:      { label: 'MercadoLibre',  badge: 'ml'     },
  propiedadesmexico: { label: 'PropMX',        badge: 'pmx'    },
};

const TXN_FROM_API = { rent: 'Renta', rental: 'Renta', sale: 'Venta' };

// Tramas de plano para las tarjetas sin foto: van sobre tinta, nunca gris plano.
const TONES = [
  { img:'radial-gradient(circle at 35% 30%, rgba(239,237,230,.95) 0 1px, transparent 1.4px)', size:'7px 7px' },
  { img:'radial-gradient(circle at 50% 50%, rgba(239,237,230,.85) 0 1.2px, transparent 1.6px)', size:'10px 10px' },
  { img:'repeating-linear-gradient(45deg, rgba(239,237,230,.55) 0 1px, transparent 1px 6px)', size:'auto' },
  { img:'radial-gradient(circle at 20% 70%, rgba(239,237,230,.9) 0 1px, transparent 1.5px)', size:'5px 5px' },
  { img:'repeating-linear-gradient(-30deg, rgba(239,237,230,.45) 0 2px, transparent 2px 9px)', size:'auto' },
  { img:'radial-gradient(circle at 60% 40%, rgba(239,237,230,.8) 0 1.6px, transparent 2px)', size:'13px 13px' },
];
const ICON_BUILDING_LG = `<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 21V7l9-4 9 4v14"/><polyline points="9 22 9 12 15 12 15 22"/><path d="M3 7h18"/></svg>`;


let listings      = [];
let listingsMap   = {};
let currentUser   = null;
let filterStatus  = 'Todos';
let filterFuente  = 'all';
let filterZona    = 'all';   // municipio, del catálogo /api/zonas
let filterStarred = false;
let searchQ       = '';
let searchStreet  = '';
let priceMin      = '';
let priceMax      = '';
let filtersOpen   = false;
let page          = 1;
const PAGE_SIZE   = 70;

// ── Data ────────────────────────────────────────────────────────────────────

function parseLocation(loc) {
  if (loc == null) return null;
  let v = loc;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s.startsWith('{')) return s;
    try { v = JSON.parse(s); } catch { return s; }
  }
  return (v && typeof v === 'object') ? (v.name ?? null) : null;
}

function adaptListing(l) {
  return {
    id:       l.id,
    fuente:   l.source ?? 'desconocido',
    codigo:   l.external_id ?? null,
    titulo:   l.title  ?? l.broker_name ?? null,
    direccion: parseLocation(l.location) ?? l.neighborhood ?? null,
    precio:   l.price_numeric != null
                ? { monto: l.price_numeric, moneda: l.currency ?? 'MXN' }
                : null,
    porM2:    l.price_is_per_m2 ?? false,
    alt:      l.operacion_alt
                ? { monto: l.precio_alt, op: l.operacion_alt,
                    porM2: l.precio_alt_por_m2 ?? false, total: l.precio_alt_total }
                : null,
    precioTotal: l.precio_total ?? null,
    fotos:    (l.images?.length ? l.images : (l.image ? [l.image] : [])),
    url:      l.url ?? null,
    whatsapp: l.whatsapp ?? null,
    status:   STATUS_FROM_API[l.status] ?? 'Nuevo',
    starred:  l.starred ?? false,
    notes:    l.notes   ?? '',
    tipo:       l.property_type ?? null,
    size:       l.property_size_m2 ?? null,
    transaccion: TXN_FROM_API[l.transaction_type] ?? 'Renta',
  };
}

let totalFiltrado = 0;
let facetas = { total: 0, destacados: 0, por_estado: {}, por_fuente: {} };

// Los filtros del tablero, tal como los espera la API. El filtrado ocurre en SQL:
// antes se bajaba la tabla entera (~25 MB) y se filtraba en el navegador.
function filtrosActuales(extra = {}) {
  return API.qs({
    q: searchStreet || searchQ,
    estado: filterStatus !== 'Todos' ? STATUS_TO_API[filterStatus] : '',
    fuente: filterFuente !== 'all' ? filterFuente : '',
    zona: filterZona !== 'all' ? filterZona : '',
    favoritos: filterStarred,
    precio_min: priceMin,
    precio_max: priceMax,
    ...extra,
  });
}

async function cargarPagina() {
  const [lista, f] = await Promise.all([
    API.get(`/listings${filtrosActuales({ page, per_page: PAGE_SIZE })}`),
    // Las facetas ignoran el filtro de estado a propósito: alimentan las píldoras.
    API.get(`/listings/facets${API.qs({
      q: searchStreet || searchQ,
      fuente: filterFuente !== 'all' ? filterFuente : '',
    zona: filterZona !== 'all' ? filterZona : '',
      favoritos: filterStarred,
      precio_min: priceMin,
      precio_max: priceMax,
    })}`),
  ]);
  listings = lista.items.map(adaptListing);
  listingsMap = Object.fromEntries(listings.map(l => [l.id, l]));
  totalFiltrado = lista.total;
  facetas = f;
}

// ── Per-user state ─────────────────────────────────────────────────────────────

function setState(id, patch) {
  const l = listingsMap[id];
  if (!l) return;
  if (patch.status  !== undefined) l.status  = patch.status;
  if (patch.starred !== undefined) l.starred = patch.starred;
  if (patch.notes   !== undefined) l.notes   = patch.notes;

  API.put(`/listings/${encodeURIComponent(id)}/estado`, {
    status:  STATUS_TO_API[l.status] ?? l.status,
    starred: l.starred,
    notes:   l.notes,
  }).catch(err => console.warn('No se pudo guardar el estado:', err.message));
}

// ── Filters ──────────────────────────────────────────────────────────────────

// Compara sin acentos ni mayúsculas; exige que TODAS las palabras del query
// aparezcan (orden libre). Cubre "san pedro garcia" → "San Pedro Garza García".
const norm = s => (s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function matchesText(haystack, query) {
  const h = norm(haystack);
  return norm(query).split(/\s+/).filter(Boolean).every(t => h.includes(t));
}
console.assert(matchesText('San Pedro Garza García', 'san pedro garcia'), 'matchesText: acentos/orden');
console.assert(!matchesText('Centro, Monterrey', 'san pedro'), 'matchesText: no falso positivo');

// Las ciudades salen del catálogo de zonas, no del inventario cargado: con 2,475
// municipios, derivarlas de la página visible daría una lista distinta en cada filtro.
async function buildCiudadFilters() {
  const zonas = await API.get('/zonas').catch(() => []);
  const group = document.getElementById('ciudad-group');
  if (!zonas.length) { group.innerHTML = ''; return; }
  group.innerHTML =
    '<span class="filter-group-label">Ciudad</span>' +
    `<button class="pill${filterZona === 'all' ? ' active' : ''}" data-group="zona" data-val="all">Todo México</button>` +
    zonas.slice(0, 12).map(z =>
      `<button class="pill${filterZona === z.norm ? ' active' : ''}" data-group="zona" data-val="${escAttr(z.norm)}">` +
      `${escAttr(z.nombre)}<span class="pill-count">${z.listings.toLocaleString('es-MX')}</span></button>`).join('');
}

function buildFuenteFilters(porFuente) {
  const fuentes = Object.keys(porFuente).sort();
  const group = document.getElementById('fuente-group');
  group.innerHTML =
    '<span class="filter-group-label">Fuente</span>' +
    `<button class="pill${filterFuente === 'all' ? ' active' : ''}" data-group="source" data-fuente="all" data-val="Todas">Todas</button>` +
    fuentes.map(f => {
      const label = FUENTE_CONFIG[f]?.label ?? f;
      return `<button class="pill${filterFuente === f ? ' active' : ''}" data-group="source" data-fuente="${f}" data-val="${label}">${label}</button>`;
    }).join('');
}

// ── Search ───────────────────────────────────────────────────────────────────

function escAttr(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

let sugerenciaPeticion = 0;

async function renderSuggestions(q) {
  const box = document.getElementById('searchSuggestions');
  if (q.length < 2 || searchStreet) { box.classList.remove('open'); return; }
  // Cada tecla dispara una petición; solo la última puede pintar.
  const mia = ++sugerenciaPeticion;
  const matches = await API.get(`/ubicaciones?q=${encodeURIComponent(q)}`).catch(() => []);
  if (mia !== sugerenciaPeticion) return;
  if (!matches.length) { box.classList.remove('open'); return; }
  box.innerHTML =
    '<div class="suggestions-header"><span>Ubicaciones</span></div>' +
    matches.map(s =>
      `<div class="suggestion-row" data-text="${escAttr(s.text)}">
        <svg class="suggestion-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
        </svg>
        <span class="suggestion-text">${escAttr(s.text)}</span>
        <span class="suggestion-count">${s.count}</span>
      </div>`
    ).join('');
  box.classList.add('open');
}

function selectSuggestion(text) {
  searchStreet = text;
  searchQ = '';
  const input = document.getElementById('searchInput');
  input.value = '';
  input.placeholder = 'Buscar en esta ubicación…';
  document.getElementById('searchChipText').textContent = text;
  document.getElementById('searchChip').style.display = '';
  document.getElementById('searchSuggestions').classList.remove('open');
  page = 1;
  render();
}

function clearStreetFilter() {
  searchStreet = '';
  document.getElementById('searchInput').placeholder = 'Buscar por dirección, título…';
  document.getElementById('searchChip').style.display = 'none';
  page = 1;
  render();
}

// ── Rendering ────────────────────────────────────────────────────────────────

// Varios portales publican "$700" queriendo decir "$700 por m²". Mostrar ese número
// como total convierte un terreno de 7.5 MDP en uno de $700: se muestra el total
// calculado y, en chico, el precio unitario del que salió.
function fmtPrice(precio, l) {
  if (!precio || precio.monto == null) return null;
  const curr = precio.moneda === 'MN' ? 'MXN' : (precio.moneda ?? '');
  if (l?.porM2) {
    const unit = `$${precio.monto.toLocaleString('es-MX')}/m²`;
    return l.precioTotal
      ? { n: Math.round(l.precioTotal).toLocaleString('es-MX'), curr, nota: unit }
      : { n: precio.monto.toLocaleString('es-MX'), curr, nota: 'por m²', parcial: true };
  }
  return { n: precio.monto.toLocaleString('es-MX'), curr };
}

// Un inmueble puede ofrecerse en renta Y venta. El segundo precio se muestra como
// línea aparte para que el asesor vea las dos opciones sin abrir el anuncio.
function altPriceHtml(alt) {
  if (!alt?.op) return '';
  const etiqueta = alt.op === 'rent' ? 'También en renta' : 'También en venta';
  // Se sabe que se ofrece en las dos, pero el precio aún no se ha rescatado.
  if (alt.monto == null) return `<div class="price-alt">${etiqueta}</div>`;
  const monto = alt.porM2 && alt.total ? alt.total : alt.monto;
  const unidad = alt.porM2 && alt.total ? '' : (alt.porM2 ? '/m²' : '');
  const sufijo = alt.op === 'rent' ? '/mes' : '';
  const nota = alt.porM2 && alt.total ? ` ($${alt.monto.toLocaleString('es-MX')}/m²)` : '';
  return `<div class="price-alt">${etiqueta}: <strong>$${Math.round(monto).toLocaleString('es-MX')}${unidad}${sufijo}</strong>${nota}</div>`;
}

const ICON_EXTERNAL = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
const ICON_BUILDING = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 21V7l9-4 9 4v14"/><polyline points="9 22 9 12 15 12 15 22"/><path d="M3 7h18"/></svg>`;

const ICON_PIN = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;

function renderCard(l, i) {
  const cfg    = FUENTE_CONFIG[l.fuente];
  const blabel = (cfg?.label ?? l.fuente).toUpperCase();
  const p      = fmtPrice(l.precio, l);
  const photo  = l.fotos?.[0] ?? null;
  // Si el precio ya es por m², repetirlo aquí sería decir dos veces lo mismo.
  const ppm    = l.porM2 ? '' :
    ((l.precio?.monto && l.size) ? `$${Math.round(l.precio.monto / l.size).toLocaleString('es-MX')} / M²` : '');
  const detalle = `listing.html?id=${encodeURIComponent(l.id)}`;

  // Sin foto: trama de plano sobre tinta. Cada tarjeta toma una del set para que
  // una rejilla sin fotos no se vea como un bloque plano repetido.
  const imgHtml = photo
    ? `<img src="${photo}" alt="" loading="lazy">`
    : `<div class="card-img-blueprint" style="background-image:${TONES[i % TONES.length].img};background-size:${TONES[i % TONES.length].size}"></div>
       <div class="card-img-icon">${ICON_BUILDING_LG}</div>`;

  const sufijo = l.transaccion === 'Renta' ? 'MXN / mes' : 'MXN';
  const priceHtml = p
    ? `<div class="card-price"><strong>$${p.n}</strong><span class="currency">${sufijo}</span></div>` +
      (p.nota ? `<span class="price-note">${p.nota}${p.parcial ? '' : ' × ' + l.size + ' m²'}</span>` : '')
    : `<div class="card-price"><strong class="no-price">Sin precio</strong></div>`;

  const opciones = STATUSES.map(st =>
    `<option value="${st}"${st === l.status ? ' selected' : ''}>${st}</option>`).join('');

  return `<article class="card ${l.starred ? 'starred' : ''} status-${l.status.toLowerCase()}" data-id="${escAttr(l.id)}">
    <div class="card-img">
      ${imgHtml}
      <span class="badge badge-src">${blabel}</span>
      ${l.fotos?.length ? `<span class="badge badge-foto">FOTO 1/${l.fotos.length}</span>` : ''}
      ${l.size ? `<span class="badge badge-size">${Math.round(l.size).toLocaleString('es-MX')} M²</span>` : ''}
      <button class="btn-star" title="${l.starred ? 'Quitar destacado' : 'Destacar'}">${l.starred ? '&#9733;' : '&#9734;'}</button>
    </div>
    <div class="card-body">
      <div class="card-top">
        <div style="min-width:0">
          ${priceHtml}
          ${ppm ? `<div class="card-ppm">${ppm}</div>` : ''}
          ${altPriceHtml(l.alt)}
        </div>
        <a class="card-ver" href="${detalle}">Ver ${ICON_EXTERNAL}</a>
      </div>
      ${l.titulo ? `<div class="card-title">${escAttr(l.titulo)}</div>` : ''}
      ${l.direccion ? `<div class="card-dir">${ICON_PIN}${escAttr(l.direccion)}</div>` : ''}
      <div class="card-tags">
        ${l.tipo ? `<span class="tag tag-tipo">${escAttr(l.tipo)}</span>` : ''}
        <span class="tag tag-txn">${l.transaccion}</span>
        ${l.codigo ? `<span class="tag tag-cod">${escAttr(l.codigo)}</span>` : ''}
      </div>
      <div class="card-sep"></div>
      <div class="card-status">
        <span class="status-dot" style="background:var(--s-${l.status.toLowerCase()})"></span>
        <select class="status-select s-${l.status}">${opciones}</select>
      </div>
      <textarea class="notes-area" placeholder="AGREGAR NOTAS…">${escAttr(l.notes)}</textarea>
    </div>
  </article>`;
}

function renderStats() {
  const n = e => facetas.por_estado[STATUS_TO_API[e]] ?? 0;
  const celda = (num, label, color) =>
    `<div class="stat"><span class="stat-num" style="color:${color}">${num.toLocaleString('es-MX')}</span>` +
    `<span class="stat-label">${label}</span></div>`;
  document.getElementById('statsBar').innerHTML =
    `<div class="stat stat-main"><span class="stat-num">${totalFiltrado.toLocaleString('es-MX')}</span>` +
    `<span class="stat-label">Propiedades visibles</span></div>` +
    celda(n('Nuevo'),      'nuevos',      'var(--s-nuevo)') +
    celda(n('Revisado'),   'revisados',   'var(--s-revisado)') +
    celda(n('Contactado'), 'contactados', 'var(--s-contactado)') +
    celda(n('Rentado'),    'rentados',    'var(--s-rentado)') +
    celda(facetas.destacados, '★ destacados', 'var(--accent)');
}

// Cuántos listados habría si solo cambiara el filtro de estado (el resto sigue aplicado).
function renderStatusCounts() {
  document.querySelectorAll('.pill[data-group="status"]').forEach(pill => {
    const val = pill.dataset.val;
    const n = val === 'Todos' ? facetas.total : (facetas.por_estado[STATUS_TO_API[val]] ?? 0);
    pill.querySelector('.pill-count').textContent = n;
  });
}

function renderPagination(totalPages) {
  const box = document.getElementById('pagination');
  if (totalPages <= 1) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <button class="btn-clear" id="page-prev" ${page <= 1 ? 'disabled' : ''}>&larr; Anterior</button>
    <span>P&#225;gina ${page} de ${totalPages}</span>
    <button class="btn-clear" id="page-next" ${page >= totalPages ? 'disabled' : ''}>Siguiente &rarr;</button>
  `;
  document.getElementById('page-prev')?.addEventListener('click', () => { page--; render(); window.scrollTo({ top: 0 }); });
  document.getElementById('page-next')?.addEventListener('click', () => { page++; render(); window.scrollTo({ top: 0 }); });
}

let renderEnCurso = null;

async function render() {
  // Un clic rápido en varios filtros dispararía peticiones que llegan desordenadas;
  // encadenarlas garantiza que la última en salir es la que se pinta.
  renderEnCurso = (renderEnCurso ?? Promise.resolve()).then(_render).catch(err => {
    console.error(err);
    document.getElementById('grid').innerHTML =
      `<p class="empty">No se pudo cargar los listados.<br>${err.message}</p>`;
  });
  return renderEnCurso;
}

async function _render() {
  await cargarPagina();

  document.getElementById('countNum').textContent   = totalFiltrado;
  document.getElementById('countTotal').textContent = facetas.total;
  renderStats();
  renderStatusCounts();
  buildFuenteFilters(facetas.por_fuente);

  const grid = document.getElementById('grid');
  if (!listings.length) {
    grid.innerHTML = `<div class="empty">
      ${ICON_BUILDING}
      <p>Sin resultados para esta b&#250;squeda.</p>
    </div>`;
    document.getElementById('pagination').innerHTML = '';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(totalFiltrado / PAGE_SIZE));
  if (page > totalPages) { page = totalPages; return _render(); }
  renderPagination(totalPages);

  grid.innerHTML = listings.map(renderCard).join('');

  grid.querySelectorAll('.card').forEach(card => {
    const id = card.dataset.id;

    card.querySelector('.btn-star').addEventListener('click', () => {
      setState(id, { starred: !listingsMap[id].starred });
      render();
    });

    card.querySelector('.status-select').addEventListener('change', e => {
      setState(id, { status: e.target.value });
      e.target.className = 'status-select s-' + e.target.value;
      const l = listingsMap[id];
      card.className = `card ${l.starred ? 'starred' : ''} status-${e.target.value.toLowerCase()}`;
      render();
    });

    card.querySelector('.notes-area').addEventListener('blur', e => {
      setState(id, { notes: e.target.value });
    });
  });
}

// ── Export ───────────────────────────────────────────────────────────────────

function exportCSV() {
  // ponytail: exporta la página visible. Si algún día hace falta el filtro completo,
  // se agrega ?formato=csv a /api/listings y lo arma el servidor.
  const filtered = listings;
  const header = ['ID', 'Fuente', 'Precio', 'Moneda', 'Título', 'Dirección', 'Estado', 'Destacado', 'Notas', 'URL', 'WhatsApp'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = filtered.map(l => [
    l.id, l.fuente ?? '', l.precio?.monto ?? '', l.precio?.moneda ?? '',
    l.titulo ?? '', l.direccion ?? '', l.status, l.starred ? 'Sí' : 'No',
    l.notes, l.url ?? '', l.whatsapp ?? '',
  ]);
  const csv = '﻿' + [header, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  a.download = `officescrapper_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}

// ── Events ───────────────────────────────────────────────────────────────────

document.getElementById('filterbar').addEventListener('click', e => {
  const pill = e.target.closest('.pill');
  if (!pill) return;
  const group = pill.dataset.group;

  if (group === 'starred') {
    filterStarred = !pill.classList.contains('active');
    pill.classList.toggle('active', filterStarred);
  } else if (group === 'status') {
    document.querySelectorAll('.pill[data-group="status"]').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    filterStatus = pill.dataset.val;
  } else if (group === 'source') {
    document.querySelectorAll('.pill[data-group="source"]').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    filterFuente = pill.dataset.fuente;
  } else if (group === 'zona') {
    document.querySelectorAll('.pill[data-group="zona"]').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    filterZona = pill.dataset.val;
  }
  page = 1;
  render();
});

const searchInput = document.getElementById('searchInput');
searchInput.addEventListener('input', e => {
  searchQ = e.target.value.trim();
  page = 1;
  renderSuggestions(searchQ);
  render();
});
searchInput.addEventListener('focus', e => {
  if (e.target.value.trim().length >= 2) renderSuggestions(e.target.value.trim());
});
searchInput.addEventListener('blur', () => {
  setTimeout(() => document.getElementById('searchSuggestions').classList.remove('open'), 150);
});

document.getElementById('searchSuggestions').addEventListener('mousedown', e => {
  const row = e.target.closest('.suggestion-row');
  if (!row) return;
  e.preventDefault();
  selectSuggestion(row.dataset.text);
});

document.getElementById('searchChipClose').addEventListener('click', clearStreetFilter);
document.getElementById('export-btn').addEventListener('click', exportCSV);

document.getElementById('price-toggle').addEventListener('click', () => {
  filtersOpen = !filtersOpen;
  document.getElementById('price-toggle').classList.toggle('active', filtersOpen);
  document.getElementById('advPanel').hidden = !filtersOpen;
});
document.getElementById('priceMin').addEventListener('input', e => { priceMin = e.target.value; page = 1; render(); });
document.getElementById('priceMax').addEventListener('input', e => { priceMax = e.target.value; page = 1; render(); });
document.getElementById('price-clear').addEventListener('click', () => {
  priceMin = ''; priceMax = ''; page = 1;
  document.getElementById('priceMin').value = '';
  document.getElementById('priceMax').value = '';
  render();
});

// ── Auth ─────────────────────────────────────────────────────────────────────
document.getElementById('logout-btn').addEventListener('click', async () => {
  await API.logout().catch(() => {});
  location.replace('login.html');
});

// ── Init ─────────────────────────────────────────────────────────────────────

API.me()
  .then(async user => {
    currentUser = user;
    document.getElementById('authBox').hidden = true;
    document.getElementById('userBox').hidden = false;
    document.getElementById('userEmail').textContent = user.email;
    await buildCiudadFilters();
    await render();          // render() ya trae listados y facetas del servidor
  })
  .catch(err => {
    // El 401 lo maneja api.js redirigiendo al login; aquí solo quedan fallos reales.
    console.error(err);
    document.getElementById('countNum').textContent = 'Error';
    document.getElementById('grid').innerHTML =
      `<p class="empty">No se pudo cargar los listados.<br>${err.message}</p>`;
  });

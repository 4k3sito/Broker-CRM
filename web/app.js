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

const TONES = [
  'linear-gradient(135deg,#A9B6B0,#C8C2B2)',
  'linear-gradient(135deg,#B7AE9E,#9FA9A6)',
  'linear-gradient(135deg,#9CABB4,#BEB6A6)',
  'linear-gradient(135deg,#BDB1A0,#A6AD99)',
  'linear-gradient(135deg,#A4B0AE,#C5BBA8)',
  'linear-gradient(135deg,#B0A898,#98A7A4)',
];

let listings      = [];
let listingsMap   = {};
let currentUser   = null;
let filterStatus  = 'Todos';
let filterFuente  = 'all';
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

function buildFuenteFilters(porFuente) {
  const fuentes = Object.keys(porFuente).sort();
  const group = document.getElementById('fuente-group');
  group.innerHTML =
    '<span class="filter-group-label">Fuente</span>' +
    '<button class="pill active" data-group="source" data-fuente="all" data-val="Todas las fuentes">Todas las fuentes</button>' +
    fuentes.map(f => {
      const label = FUENTE_CONFIG[f]?.label ?? f;
      return `<button class="pill" data-group="source" data-fuente="${f}" data-val="${label}">${label}</button>`;
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

const ICON_EXTERNAL = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
const ICON_BUILDING = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 21V7l9-4 9 4v14"/><polyline points="9 22 9 12 15 12 15 22"/><path d="M3 7h18"/></svg>`;

const ICON_PIN = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;

function renderCard(l, i) {
  const cfg    = FUENTE_CONFIG[l.fuente];
  const badge  = cfg?.badge  ?? 'other';
  const blabel = (cfg?.label ?? l.fuente).toUpperCase();
  const p      = fmtPrice(l.precio, l);
  const photo  = l.fotos?.[0] ?? null;
  // Si el precio ya es por m², repetirlo aquí sería decir dos veces lo mismo.
  const ppm    = l.porM2 ? '' :
    ((l.precio?.monto && l.size) ? `$${Math.round(l.precio.monto / l.size).toLocaleString('es-MX')} / m²` : '');

  const imgHtml = photo
    ? `<img src="${photo}" alt="foto" loading="lazy">`
    : `<div class="card-img-placeholder" style="background:${TONES[i % TONES.length]}">${ICON_BUILDING}</div>`;
  const detailHref = `listing.html?id=${l.id}`;

  // "/mes" solo en renta: pegárselo a una venta convierte un terreno de 7 MDP en
  // una mensualidad imposible.
  const sufijo = l.transaccion === 'Renta' ? '/mes' : '';
  const priceHtml = p
    ? `<div class="card-price">$${p.n}<span class="currency">${p.curr}${sufijo}</span>` +
      (p.nota ? `<span class="price-note">${p.nota}${p.parcial ? '' : ' × ' + l.size + ' m²'}</span>` : '') +
      `</div>`
    : `<div class="card-price"><span class="no-price">Sin precio</span></div>`;

  const statusOptions = STATUSES.map(st =>
    `<option value="${st}"${st === l.status ? ' selected' : ''}>${st}</option>`
  ).join('');

  return `<article class="card ${l.starred ? 'starred' : ''} status-${l.status.toLowerCase()}" data-id="${l.id}">
    <div class="card-img">
      <a class="card-photo-link" href="${detailHref}">${imgHtml}</a>
      <span class="badge-src ${badge}">${blabel}</span>
      <span class="badge-fotos">FOTO 1/${l.fotos.length || 1}</span>
      ${l.size ? `<span class="badge-size">${l.size} m²</span>` : ''}
      <button class="btn-star ${l.starred ? 'on' : 'off'}" title="${l.starred ? 'Quitar destacado' : 'Destacar'}">
        ${l.starred ? '&#9733;' : '&#9734;'}
      </button>
    </div>
    <div class="card-body">
      <div class="card-top">
        <div>
          ${priceHtml}
          ${ppm ? `<div class="card-ppm">${ppm}</div>` : ''}
        </div>
        <div class="card-links">
          ${l.url      ? `<a href="${l.url}" class="card-link" target="_blank" rel="noopener">Ver ${ICON_EXTERNAL}</a>`
            : (l.fuente === 'easybroker' && l.codigo ? `<span class="card-link" title="Búscalo en EasyBroker por este código">ID ${l.codigo}</span>` : '')}
          ${l.whatsapp ? `<a href="https://wa.me/${l.whatsapp.replace(/\D/g,'')}" class="card-link wa" target="_blank" rel="noopener">WhatsApp ${ICON_EXTERNAL}</a>` : ''}
        </div>
      </div>
      ${l.titulo    ? `<a class="card-title" href="${detailHref}">${l.titulo}</a>`       : ''}
      ${l.direccion ? `<div class="card-location">${ICON_PIN}${l.direccion}</div>` : ''}
      <div class="card-tags">
        ${l.tipo ? `<span class="tag-tipo">${l.tipo}</span>` : ''}
        <span class="tag-txn">${l.transaccion}</span>
        ${l.codigo ? `<span class="tag-code">${l.codigo}</span>` : ''}
      </div>
      <div class="card-divider"></div>
      <div class="card-status-row">
        <span class="status-dot" style="background:var(--s-${l.status.toLowerCase()})"></span>
        <select class="status-select s-${l.status}">${statusOptions}</select>
      </div>
      <textarea class="notes-area" placeholder="Agregar notas&#8230;">${l.notes}</textarea>
    </div>
  </article>`;
}

function renderStats() {
  const n = e => facetas.por_estado[STATUS_TO_API[e]] ?? 0;
  document.getElementById('statsBar').innerHTML = `
    <div class="stat-item stat-main"><span class="stat-num">${totalFiltrado}</span><span class="stat-label">listados visibles</span></div>
    <div class="stat-item"><span class="stat-num" style="color:var(--s-nuevo)">${n('Nuevo')}</span><span class="stat-label">nuevos</span></div>
    <div class="stat-item"><span class="stat-num" style="color:var(--s-revisado)">${n('Revisado')}</span><span class="stat-label">revisados</span></div>
    <div class="stat-item"><span class="stat-num" style="color:var(--s-contactado)">${n('Contactado')}</span><span class="stat-label">contactados</span></div>
    <div class="stat-item"><span class="stat-num" style="color:var(--s-rentado)">${n('Rentado')}</span><span class="stat-label">rentados</span></div>
    <div class="stat-item"><span class="stat-num" style="color:var(--accent)">${facetas.destacados}</span><span class="stat-label">&#9733; destacados</span></div>
  `;
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
    await render();          // render() ya trae listados y facetas del servidor
  })
  .catch(err => {
    // El 401 lo maneja api.js redirigiendo al login; aquí solo quedan fallos reales.
    console.error(err);
    document.getElementById('countNum').textContent = 'Error';
    document.getElementById('grid').innerHTML =
      `<p class="empty">No se pudo cargar los listados.<br>${err.message}</p>`;
  });

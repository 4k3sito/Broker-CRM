const SUPABASE_URL = 'https://fbtyjwpeymnguetrcwzt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Ke4bAiGgcM6bMxaOk-u2Zw_S9AMSo1C';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
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

let listings      = [];
let listingsMap   = {};
let filterStatus  = 'Todos';
let filterFuente  = 'all';
let filterStarred = false;
let searchQ       = '';
let searchStreet  = '';
let locationIndex = [];

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
    titulo:   l.title  ?? l.broker_name ?? null,
    direccion: parseLocation(l.location) ?? l.neighborhood ?? null,
    precio:   l.price_numeric != null
                ? { monto: l.price_numeric, moneda: l.currency ?? 'MXN' }
                : null,
    fotos:    (l.images?.length ? l.images : (l.image ? [l.image] : [])),
    url:      l.url ?? null,
    whatsapp: l.whatsapp ?? null,
    status:   STATUS_FROM_API[l.status] ?? 'Nuevo',
    starred:  l.starred ?? false,
    notes:    l.notes   ?? '',
  };
}

async function fetchAllListings() {
  const { data, error } = await db.from('listings').select('*').order('id');
  if (error) throw new Error(error.message);
  return data;
}

// ── State ────────────────────────────────────────────────────────────────────

function setState(id, patch) {
  const l = listingsMap[id];
  if (!l) return;
  if (patch.status  !== undefined) l.status  = patch.status;
  if (patch.starred !== undefined) l.starred = patch.starred;
  if (patch.notes   !== undefined) l.notes   = patch.notes;

  const dbPatch = {};
  if (patch.status  !== undefined) dbPatch.status  = STATUS_TO_API[patch.status] ?? patch.status;
  if (patch.starred !== undefined) dbPatch.starred = patch.starred;
  if (patch.notes   !== undefined) dbPatch.notes   = patch.notes;

  db.from('listings').update(dbPatch).eq('id', id)
    .then(({ error }) => { if (error) console.warn('Update failed:', error.message); });
}

// ── Filters ──────────────────────────────────────────────────────────────────

function computeFiltered() {
  const q = searchQ.toLowerCase();
  return listings.filter(l => {
    if (filterStatus !== 'Todos' && l.status  !== filterStatus) return false;
    if (filterFuente !== 'all'   && l.fuente  !== filterFuente) return false;
    if (filterStarred && !l.starred) return false;
    if (searchStreet && !(l.direccion ?? '').toLowerCase().includes(searchStreet.toLowerCase())) return false;
    if (q && !(l.direccion ?? '').toLowerCase().includes(q) &&
             !(l.titulo    ?? '').toLowerCase().includes(q)) return false;
    return true;
  });
}

function buildFuenteFilters(data) {
  const fuentes = [...new Set(data.map(l => l.fuente))].sort();
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

function buildLocationIndex(data) {
  const map = {};
  data.forEach(l => {
    const key = (l.direccion ?? '').trim();
    if (key) map[key] = (map[key] || 0) + 1;
  });
  locationIndex = Object.entries(map)
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count);
}

function renderSuggestions(q) {
  const box = document.getElementById('searchSuggestions');
  if (q.length < 2 || searchStreet) { box.classList.remove('open'); return; }
  const ql = q.toLowerCase();
  const matches = locationIndex.filter(s => s.text.toLowerCase().includes(ql)).slice(0, 8);
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
  render();
}

function clearStreetFilter() {
  searchStreet = '';
  document.getElementById('searchInput').placeholder = 'Buscar por dirección, título…';
  document.getElementById('searchChip').style.display = 'none';
  render();
}

// ── Rendering ────────────────────────────────────────────────────────────────

function fmtPrice(precio) {
  if (!precio || precio.monto == null) return null;
  const n    = precio.monto.toLocaleString('es-MX');
  const curr = precio.moneda === 'MN' ? 'MXN' : (precio.moneda ?? '');
  return { n, curr };
}

const ICON_EXTERNAL = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
const ICON_BUILDING = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 21V7l9-4 9 4v14"/><polyline points="9 22 9 12 15 12 15 22"/><path d="M3 7h18"/></svg>`;

function renderCard(l, i) {
  const cfg    = FUENTE_CONFIG[l.fuente];
  const badge  = cfg?.badge  ?? 'other';
  const blabel = (cfg?.label ?? l.fuente).toUpperCase();
  const p      = fmtPrice(l.precio);
  const photo  = l.fotos?.[0] ?? null;

  const imgHtml = photo
    ? `<img src="${photo}" alt="foto" loading="lazy">`
    : `<div class="card-img-placeholder">${ICON_BUILDING}</div>`;

  const priceHtml = p
    ? `<div class="card-price">$${p.n}<span class="currency">${p.curr}/mes</span></div>`
    : `<div class="card-price"><span class="no-price">Precio no indicado</span></div>`;

  const statusOptions = STATUSES.map(st =>
    `<option value="${st}"${st === l.status ? ' selected' : ''}>${st}</option>`
  ).join('');

  return `<article class="card ${l.starred ? 'starred' : ''} status-${l.status.toLowerCase()}" data-id="${l.id}" style="animation-delay:${Math.min(i,8)*0.04}s">
    <div class="card-img">
      ${imgHtml}
      <span class="badge-src ${badge}">${blabel}</span>
      <button class="btn-star ${l.starred ? 'on' : 'off'}" title="${l.starred ? 'Quitar destacado' : 'Destacar'}">
        ${l.starred ? '&#9733;' : '&#9734;'}
      </button>
    </div>
    <div class="card-body">
      <div class="card-top">
        <div>
          ${priceHtml}
          ${l.titulo    ? `<div class="card-title">${l.titulo}</div>`       : ''}
          ${l.direccion ? `<div class="card-location">${l.direccion}</div>` : ''}
        </div>
        <div class="card-links">
          ${l.url      ? `<a href="${l.url}" class="card-link" target="_blank" rel="noopener">Ver listing ${ICON_EXTERNAL}</a>` : ''}
          ${l.whatsapp ? `<a href="https://wa.me/${l.whatsapp.replace(/\D/g,'')}" class="card-link wa" target="_blank" rel="noopener">WhatsApp ${ICON_EXTERNAL}</a>` : ''}
        </div>
      </div>
      <select class="status-select s-${l.status}">${statusOptions}</select>
      <textarea class="notes-area" placeholder="Agregar notas&#8230;">${l.notes}</textarea>
    </div>
  </article>`;
}

function renderStats(filtered) {
  const counts = {};
  STATUSES.forEach(s => counts[s] = 0);
  filtered.forEach(l => { if (counts[l.status] !== undefined) counts[l.status]++; });
  const stars = filtered.filter(l => l.starred).length;
  document.getElementById('statsBar').innerHTML = `
    <div class="stat-item"><span class="stat-num">${filtered.length}</span><span class="stat-label">listados</span></div>
    <div class="statsbar-sep"></div>
    <div class="stat-item"><span class="stat-num" style="color:var(--s-nuevo-c)">${counts['Nuevo']}</span><span class="stat-label">nuevos</span></div>
    <div class="stat-item"><span class="stat-num" style="color:var(--s-revisado-c)">${counts['Revisado']}</span><span class="stat-label">revisados</span></div>
    <div class="stat-item"><span class="stat-num" style="color:var(--s-contactado-c)">${counts['Contactado']}</span><span class="stat-label">contactados</span></div>
    <div class="stat-item"><span class="stat-num" style="color:var(--s-rentado-c)">${counts['Rentado']}</span><span class="stat-label">rentados</span></div>
    <div class="statsbar-sep"></div>
    <div class="stat-item"><span class="stat-num">${stars}</span><span class="stat-label">&#9733; destacados</span></div>
  `;
}

function render() {
  const filtered = computeFiltered();
  document.getElementById('countNum').textContent   = filtered.length;
  document.getElementById('countTotal').textContent = listings.length;
  renderStats(filtered);

  const grid = document.getElementById('grid');
  if (!filtered.length) {
    grid.innerHTML = `<div class="empty">
      ${ICON_BUILDING}
      <p>Sin resultados para esta b&#250;squeda.</p>
    </div>`;
    return;
  }

  grid.innerHTML = filtered.map(renderCard).join('');

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
      renderStats(computeFiltered());
    });

    card.querySelector('.notes-area').addEventListener('blur', e => {
      setState(id, { notes: e.target.value });
    });
  });
}

// ── Export ───────────────────────────────────────────────────────────────────

function exportCSV() {
  const filtered = computeFiltered();
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
  render();
});

const searchInput = document.getElementById('searchInput');
searchInput.addEventListener('input', e => {
  searchQ = e.target.value.trim();
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

// ── Init ─────────────────────────────────────────────────────────────────────

fetchAllListings()
  .then(raw => {
    listings = raw.map(adaptListing);
    listingsMap = Object.fromEntries(listings.map(l => [l.id, l]));
    buildLocationIndex(listings);
    buildFuenteFilters(listings);
    render();
  })
  .catch(err => {
    console.error(err);
    document.getElementById('countNum').textContent = 'Error';
    document.getElementById('grid').innerHTML =
      `<p class="empty">No se pudo cargar los listings desde Supabase.<br>Revisa la consola para m&#225;s detalles.</p>`;
  });

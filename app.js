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
let locationIndex = [];
let priceMin      = '';
let priceMax      = '';
let filtersOpen   = false;
let page          = 1;
let authResolved  = false;
const PAGE_SIZE   = 70;

function redirectToLogin() {
  window.location.replace('login.html');
}

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

// Only the columns adaptListing() actually reads — the table also carries
// description/features/price_raw/etc. that would otherwise bloat every fetch.
const LISTING_COLUMNS = 'id,source,external_id,title,broker_name,location,neighborhood,' +
  'price_numeric,currency,images,image,url,whatsapp,property_type,property_size_m2,transaction_type';

async function fetchAllListings() {
  // PostgREST caps each request at 1000 rows; page through until exhausted.
  const PAGE = 1000;
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from('listings').select(LISTING_COLUMNS)
      .order('id').range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}

// ── Per-user state ─────────────────────────────────────────────────────────────

// Overlay this user's saved status/starred/notes onto the loaded listings.
async function loadUserState() {
  // reset to defaults (handles logout too)
  for (const l of listings) { l.status = 'Nuevo'; l.starred = false; l.notes = ''; }
  if (!currentUser) return;
  const { data, error } = await db.from('user_listing')
    .select('listing_id,status,starred,notes').eq('user_id', currentUser.id);
  if (error) { console.warn('Carga de estado falló:', error.message); return; }
  for (const r of data) {
    const l = listingsMap[r.listing_id];
    if (!l) continue;
    l.status  = STATUS_FROM_API[r.status] ?? 'Nuevo';
    l.starred = r.starred ?? false;
    l.notes   = r.notes ?? '';
  }
}

function setState(id, patch) {
  const l = listingsMap[id];
  if (!l) return;
  if (!currentUser) { alert('Inicia sesión para guardar notas y favoritos.'); return; }
  if (patch.status  !== undefined) l.status  = patch.status;
  if (patch.starred !== undefined) l.starred = patch.starred;
  if (patch.notes   !== undefined) l.notes   = patch.notes;

  // One row per (user, listing); upsert merges with what's already there.
  db.from('user_listing').upsert({
    user_id:    currentUser.id,
    listing_id: id,
    status:     STATUS_TO_API[l.status] ?? l.status,
    starred:    l.starred,
    notes:      l.notes,
    updated_at: new Date().toISOString(),
  }).then(({ error }) => { if (error) console.warn('Update failed:', error.message); });
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

function passesExcept(l, exclude) {
  if (exclude !== 'status'  && filterStatus !== 'Todos' && l.status !== filterStatus) return false;
  if (exclude !== 'source'  && filterFuente !== 'all'   && l.fuente !== filterFuente) return false;
  if (exclude !== 'starred' && filterStarred && !l.starred) return false;
  if (searchStreet && !matchesText(l.direccion, searchStreet)) return false;
  if (searchQ && !matchesText(l.direccion, searchQ) && !matchesText(l.titulo, searchQ)) return false;
  if (priceMin !== '' && (l.precio?.monto ?? 0) < Number(priceMin)) return false;
  if (priceMax !== '' && (l.precio?.monto ?? Infinity) > Number(priceMax)) return false;
  return true;
}

function computeFiltered() {
  return listings.filter(l => passesExcept(l, null));
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
  const matches = locationIndex.filter(s => matchesText(s.text, q)).slice(0, 8);
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

function fmtPrice(precio) {
  if (!precio || precio.monto == null) return null;
  const n    = precio.monto.toLocaleString('es-MX');
  const curr = precio.moneda === 'MN' ? 'MXN' : (precio.moneda ?? '');
  return { n, curr };
}

const ICON_EXTERNAL = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
const ICON_BUILDING = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 21V7l9-4 9 4v14"/><polyline points="9 22 9 12 15 12 15 22"/><path d="M3 7h18"/></svg>`;

const ICON_PIN = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;

function renderCard(l, i) {
  const cfg    = FUENTE_CONFIG[l.fuente];
  const badge  = cfg?.badge  ?? 'other';
  const blabel = (cfg?.label ?? l.fuente).toUpperCase();
  const p      = fmtPrice(l.precio);
  const photo  = l.fotos?.[0] ?? null;
  const ppm    = (l.precio?.monto && l.size) ? `$${Math.round(l.precio.monto / l.size).toLocaleString('es-MX')} / m²` : '';

  const imgHtml = photo
    ? `<img src="${photo}" alt="foto" loading="lazy">`
    : `<div class="card-img-placeholder" style="background:${TONES[i % TONES.length]}">${ICON_BUILDING}</div>`;
  const detailHref = `listing.html?id=${l.id}`;

  const priceHtml = p
    ? `<div class="card-price">$${p.n}<span class="currency">${p.curr}/mes</span></div>`
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

function renderStats(filtered) {
  const counts = {};
  STATUSES.forEach(s => counts[s] = 0);
  filtered.forEach(l => { if (counts[l.status] !== undefined) counts[l.status]++; });
  const stars = filtered.filter(l => l.starred).length;
  document.getElementById('statsBar').innerHTML = `
    <div class="stat-item stat-main"><span class="stat-num">${filtered.length}</span><span class="stat-label">listados visibles</span></div>
    <div class="stat-item"><span class="stat-num" style="color:var(--s-nuevo)">${counts['Nuevo']}</span><span class="stat-label">nuevos</span></div>
    <div class="stat-item"><span class="stat-num" style="color:var(--s-revisado)">${counts['Revisado']}</span><span class="stat-label">revisados</span></div>
    <div class="stat-item"><span class="stat-num" style="color:var(--s-contactado)">${counts['Contactado']}</span><span class="stat-label">contactados</span></div>
    <div class="stat-item"><span class="stat-num" style="color:var(--s-rentado)">${counts['Rentado']}</span><span class="stat-label">rentados</span></div>
    <div class="stat-item"><span class="stat-num" style="color:var(--accent)">${stars}</span><span class="stat-label">&#9733; destacados</span></div>
  `;
}

// Faceted counts on the status pills: how many listings would match if only
// the status filter changed (all other active filters still applied).
function renderStatusCounts() {
  const base = listings.filter(l => passesExcept(l, 'status'));
  document.querySelectorAll('.pill[data-group="status"]').forEach(pill => {
    const val = pill.dataset.val;
    const n = val === 'Todos' ? base.length : base.filter(l => l.status === val).length;
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

function render() {
  const filtered = computeFiltered();
  document.getElementById('countNum').textContent   = filtered.length;
  document.getElementById('countTotal').textContent = listings.length;
  renderStats(filtered);
  renderStatusCounts();

  const grid = document.getElementById('grid');
  if (!filtered.length) {
    grid.innerHTML = `<div class="empty">
      ${ICON_BUILDING}
      <p>Sin resultados para esta b&#250;squeda.</p>
    </div>`;
    document.getElementById('pagination').innerHTML = '';
    return;
  }

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  if (page > totalPages) page = totalPages;
  if (page < 1) page = 1;
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  renderPagination(totalPages);

  grid.innerHTML = pageItems.map(renderCard).join('');

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
document.getElementById('logout-btn').addEventListener('click', () => db.auth.signOut());

// Single source of truth: react to whatever auth state Supabase reports.
db.auth.onAuthStateChange((_event, session) => {
  currentUser = session?.user ?? null;
  document.getElementById('authBox').hidden = !!currentUser;
  document.getElementById('userBox').hidden = !currentUser;
  if (currentUser) document.getElementById('userEmail').textContent = currentUser.email;
  if (!currentUser && authResolved) {
    redirectToLogin();
    return;
  }
  // ponytail: setTimeout libera el lock de auth; llamar db.from(...) aquí dentro
  // deadlockea el cliente supabase-js (gotcha documentado).
  if (listings.length) setTimeout(() => loadUserState().then(render), 0);
});

// ── Init ─────────────────────────────────────────────────────────────────────

db.auth.getSession()
  .then(async ({ data, error }) => {
    if (error) throw new Error(error.message);
    authResolved = true;
    currentUser = data.session?.user ?? null;
    if (!currentUser) {
      redirectToLogin();
      return;
    }

    const raw = await fetchAllListings();
    listings = raw.map(adaptListing);
    listingsMap = Object.fromEntries(listings.map(l => [l.id, l]));
    buildLocationIndex(listings);
    buildFuenteFilters(listings);
    await loadUserState();
    render();
  })
  .catch(err => {
    console.error(err);
    document.getElementById('countNum').textContent = 'Error';
    document.getElementById('grid').innerHTML =
      `<p class="empty">No se pudo cargar los listings desde Supabase.<br>Revisa la consola para m&#225;s detalles.</p>`;
  });

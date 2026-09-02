// Tablero de propiedades. El filtro es una "sentencia editable": cada criterio es
// un token que se quita con la ×, y `+ filtro` (⌘K) abre la paleta para agregar
// otro. Sustituye a las filas de píldoras — con diez filtros posibles, una fila
// por filtro no cabía en la barra y el asesor no veía qué tenía aplicado.
// Todo el filtrado ocurre en SQL: antes se bajaba la tabla entera (~25 MB).

const STATUSES = ['Nuevo', 'Revisado', 'Contactado', 'Rentado', 'Descartado'];
const STATUS_FROM_API = { new: 'Nuevo', reviewed: 'Revisado', contacted: 'Contactado', rented: 'Rentado', discarded: 'Descartado' };
const STATUS_TO_API   = { Nuevo: 'new', Revisado: 'reviewed', Contactado: 'contacted', Rentado: 'rented', Descartado: 'discarded' };

const FUENTE_CONFIG = {
  inmuebles24:       { label: 'Inmuebles24'  },
  lamudi:            { label: 'Lamudi'       },
  vivanuncios:       { label: 'Vivanuncios'  },
  mercadolibre:      { label: 'MercadoLibre' },
  pincali:           { label: 'Pincali'      },
  propiedadesmx:     { label: 'PropiedadesMX'},
  propiedadesmexico: { label: 'PropiedadesMX'},
};

const TXN_FROM_API = { rent: 'Renta', rental: 'Renta', sale: 'Venta' };
const TIPOS  = ['oficina', 'local', 'bodega', 'terreno', 'edificio'];
const ORDENES = { recientes: 'Recientes', precio_asc: 'Precio ↑', precio_desc: 'Precio ↓', m2_desc: 'Más m²' };

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
                                .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const mx  = n => Number(n).toLocaleString('es-MX');

const ICON_EXTERNAL = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
const ICON_PIN = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
const ICON_BUILDING_LG = `<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 21V7l9-4 9 4v14"/><polyline points="9 22 9 12 15 12 15 22"/><path d="M3 7h18"/></svg>`;

// ── Estado ───────────────────────────────────────────────────────────────────

// Un solo objeto con lo que la API entiende. Los tokens son una vista de esto,
// no una estructura paralela: así no hay dos verdades que sincronizar.
const F = {
  q: '', tipo: '', operacion: '', zona: '', fuente: '',
  precio_min: '', precio_max: '', m2_min: '', m2_max: '',
  near: '', radio: 2000, orden: 'recientes',
};
let filterStatus  = 'Todos';
let filterStarred = false;
let searchStreet  = '';
let page = 1;
const PAGE_SIZE = 70;

let listings = [], listingsMap = {}, totalFiltrado = 0;
let facetas = { total: 0, destacados: 0, por_estado: {}, por_fuente: {} };
let zonas = [];

// ── Tokens: la sentencia ─────────────────────────────────────────────────────

// Cada entrada sabe pintarse (`label`) y limpiarse (`clear`). El editor concreto
// lo resuelve `abrirEditor`; aquí sólo vive lo que comparten.
const CAMPOS = {
  tipo:      { kind: 'Tipo',      grupo: 'Inmueble',  hint: 'oficina, local…',
               label: () => F.tipo[0].toUpperCase() + F.tipo.slice(1), clear: () => { F.tipo = ''; } },
  operacion: { kind: 'Operación', grupo: 'Inmueble',  hint: 'renta o venta',
               label: () => (F.operacion === 'rent' ? 'en renta' : 'en venta'),
               clear: () => { F.operacion = ''; } },
  zona:      { kind: 'Zona',      grupo: 'Ubicación', hint: 'municipio',
               label: () => zonas.find(z => z.norm === F.zona)?.nombre ?? F.zona,
               clear: () => { F.zona = ''; } },
  radio:     { kind: 'Radio',     grupo: 'Ubicación', hint: 'a N km de un punto',
               label: () => `a ${(F.radio / 1000).toFixed(1).replace(/\.0$/, '')} km de ${F.near}`,
               clear: () => { F.near = ''; } },
  precio:    { kind: 'Precio',    grupo: 'Números',   hint: 'mín — máx',
               label: () => rango(F.precio_min, F.precio_max, v => `$${mx(v)}`),
               clear: () => { F.precio_min = ''; F.precio_max = ''; } },
  m2:        { kind: 'M²',        grupo: 'Números',   hint: 'superficie',
               label: () => rango(F.m2_min, F.m2_max, v => `${mx(v)} m²`),
               clear: () => { F.m2_min = ''; F.m2_max = ''; } },
  fuente:    { kind: 'Fuente',    grupo: 'Origen',    hint: 'portal de origen',
               label: () => FUENTE_CONFIG[F.fuente]?.label ?? F.fuente,
               clear: () => { F.fuente = ''; } },
  orden:     { kind: 'Orden',     grupo: 'Vista',     hint: 'cómo se ordena',
               label: () => ORDENES[F.orden], clear: () => { F.orden = 'recientes'; } },
};

function rango(min, max, fmt) {
  if (min && max) return `${fmt(min)} — ${fmt(max)}`;
  if (max) return `hasta ${fmt(max)}`;
  return `desde ${fmt(min)}`;
}

// Qué tokens están puestos ahora mismo. El orden es el de CAMPOS: estable entre
// renders, para que un token no salte de sitio al cambiar otro.
const activos = () => Object.keys(CAMPOS).filter(k =>
  k === 'radio'  ? !!F.near :
  k === 'precio' ? !!(F.precio_min || F.precio_max) :
  k === 'm2'     ? !!(F.m2_min || F.m2_max) :
  k === 'orden'  ? F.orden !== 'recientes' : !!F[k]);

console.assert(activos().length === 0, 'sin filtros no debe haber tokens');

// ── Datos ────────────────────────────────────────────────────────────────────

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
    id: l.id,
    fuente: l.source ?? 'desconocido',
    codigo: l.external_id ?? null,
    titulo: l.title ?? l.broker_name ?? null,
    direccion: parseLocation(l.location) ?? l.neighborhood ?? l.zona ?? null,
    precio: l.price_numeric != null ? { monto: l.price_numeric, moneda: l.currency ?? 'MXN' } : null,
    porM2: l.price_is_per_m2 ?? false,
    alt: l.operacion_alt
      ? { monto: l.precio_alt, op: l.operacion_alt, porM2: l.precio_alt_por_m2 ?? false, total: l.precio_alt_total }
      : null,
    precioTotal: l.precio_total ?? null,
    fotos: (l.images?.length ? l.images : (l.image ? [l.image] : [])),
    url: l.url ?? null,
    whatsapp: l.whatsapp ?? null,
    status: STATUS_FROM_API[l.status] ?? 'Nuevo',
    starred: l.starred ?? false,
    notes: l.notes ?? '',
    tipo: l.property_type ?? null,
    size: l.property_size_m2 ?? null,
    transaccion: TXN_FROM_API[l.transaction_type] ?? 'Renta',
  };
}

const paramsBase = () => ({
  q: searchStreet || F.q,
  tipo: F.tipo, operacion: F.operacion, zona: F.zona, fuente: F.fuente,
  precio_min: F.precio_min, precio_max: F.precio_max,
  m2_min: F.m2_min, m2_max: F.m2_max,
  near: F.near, radio: F.near ? F.radio : '',
  favoritos: filterStarred,
});

async function cargarPagina() {
  const [lista, f] = await Promise.all([
    API.get(`/listings${API.qs({ ...paramsBase(), orden: F.orden,
      estado: filterStatus !== 'Todos' ? STATUS_TO_API[filterStatus] : '',
      page, per_page: PAGE_SIZE })}`),
    // Las facetas ignoran el filtro de estado a propósito: alimentan las píldoras.
    API.get(`/listings/facets${API.qs(paramsBase())}`),
  ]);
  listings = lista.items.map(adaptListing);
  listingsMap = Object.fromEntries(listings.map(l => [l.id, l]));
  totalFiltrado = lista.total ?? listings.length;
  // Los valores por defecto evitan que una respuesta incompleta tumbe el render:
  // peor un contador en cero que una página en blanco.
  facetas = { total: 0, destacados: 0, por_estado: {}, por_fuente: {}, ...(f ?? {}) };
}

function setState(id, patch) {
  const l = listingsMap[id];
  if (!l) return;
  Object.assign(l, patch);
  API.put(`/listings/${encodeURIComponent(id)}/estado`, {
    status: STATUS_TO_API[l.status] ?? l.status, starred: l.starred, notes: l.notes,
  }).catch(err => console.warn('No se pudo guardar el estado:', err.message));
}

// ── Precio ───────────────────────────────────────────────────────────────────

// Varios portales publican "$700" queriendo decir "$700 por m²". Mostrar ese
// número como total convierte un terreno de 7.5 MDP en uno de $700: se muestra el
// total calculado y, en chico, el precio unitario del que salió.
function fmtPrice(precio, l) {
  if (!precio || precio.monto == null) return null;
  const curr = precio.moneda === 'MN' ? 'MXN' : (precio.moneda ?? '');
  if (l?.porM2) {
    const unit = `$${mx(precio.monto)}/m²`;
    return l.precioTotal
      ? { n: mx(Math.round(l.precioTotal)), curr, nota: unit }
      : { n: mx(precio.monto), curr, nota: 'por m²', parcial: true };
  }
  return { n: mx(precio.monto), curr };
}

// Un inmueble puede ofrecerse en renta Y venta. El segundo precio va como línea
// aparte para que el asesor vea las dos opciones sin abrir el anuncio.
function altPriceHtml(alt) {
  if (!alt?.op) return '';
  const etiqueta = alt.op === 'rent' ? 'También en renta' : 'También en venta';
  if (alt.monto == null) return `<div class="price-alt">${etiqueta}</div>`;
  const monto = alt.porM2 && alt.total ? alt.total : alt.monto;
  const unidad = alt.porM2 && alt.total ? '' : (alt.porM2 ? '/m²' : '');
  const sufijo = alt.op === 'rent' ? '/mes' : '';
  const nota = alt.porM2 && alt.total ? ` ($${mx(alt.monto)}/m²)` : '';
  return `<div class="price-alt">${etiqueta}: <strong>$${mx(Math.round(monto))}${unidad}${sufijo}</strong>${nota}</div>`;
}

// ── Tarjeta ──────────────────────────────────────────────────────────────────

function renderCard(l) {
  const blabel = (FUENTE_CONFIG[l.fuente]?.label ?? l.fuente).toUpperCase();
  const p = fmtPrice(l.precio, l);
  const foto = l.fotos?.[0] ?? null;
  // Si el precio ya es por m², repetirlo aquí sería decir dos veces lo mismo.
  const ppm = !l.porM2 && l.precio?.monto && l.size
    ? `$${mx(Math.round(l.precio.monto / l.size))} / m²` : '';
  const sufijo = l.transaccion === 'Renta' ? 'MXN / mes' : 'MXN';

  const imgHtml = foto
    ? `<img src="${esc(foto)}" alt="" loading="lazy">`
    : `<div class="card-img-blueprint"></div><div class="card-img-icon">${ICON_BUILDING_LG}</div>`;

  const priceHtml = p
    ? `<div class="card-price"><strong>$${p.n}</strong><span class="currency">${sufijo}</span></div>` +
      (p.nota ? `<span class="price-note">${p.nota}${p.parcial ? '' : ' × ' + mx(l.size) + ' m²'}</span>` : '')
    : `<div class="card-price"><strong class="no-price">Sin precio</strong></div>`;

  return `<article class="card ${l.starred ? 'starred' : ''} status-${l.status.toLowerCase()}" data-id="${esc(l.id)}">
    <div class="card-img">
      ${imgHtml}
      <span class="badge badge-src">${esc(blabel)}</span>
      ${l.fotos?.length ? `<span class="badge badge-foto">FOTO 1/${l.fotos.length}</span>` : ''}
      ${l.size ? `<span class="badge badge-size">${mx(Math.round(l.size))} m&#178;</span>` : ''}
      <button class="btn-star" title="${l.starred ? 'Quitar destacado' : 'Destacar'}">${l.starred ? '&#9733;' : '&#9734;'}</button>
    </div>
    <div class="card-body">
      <div class="card-top">
        <div style="min-width:0">
          ${priceHtml}
          ${ppm ? `<div class="card-ppm">${ppm}</div>` : ''}
          ${altPriceHtml(l.alt)}
        </div>
        <a class="card-ver" href="listing.html?id=${encodeURIComponent(l.id)}">Ver ${ICON_EXTERNAL}</a>
      </div>
      ${l.titulo ? `<div class="card-title">${esc(l.titulo)}</div>` : ''}
      ${l.direccion ? `<div class="card-dir">${ICON_PIN}${esc(l.direccion)}</div>` : ''}
      <div class="card-tags">
        ${l.tipo ? `<span class="tag-tipo">${esc(l.tipo)}</span>` : ''}
        <span class="tag-txn">${l.transaccion}</span>
        ${l.codigo ? `<span class="tag-cod">${esc(l.codigo)}</span>` : ''}
      </div>
      <div class="card-sep"></div>
      <div class="card-status">
        <span class="status-dot" style="background:var(--s-${l.status.toLowerCase()})"></span>
        <select class="status-select s-${l.status}" aria-label="Estado de seguimiento">
          ${STATUSES.map(st => `<option${st === l.status ? ' selected' : ''}>${st}</option>`).join('')}
        </select>
      </div>
    </div>
  </article>`;
}

// ── Sentencia y paleta ───────────────────────────────────────────────────────

function renderTokens() {
  const act = activos();
  document.getElementById('tokens').innerHTML = act.map(k => `
    <span class="tok">
      <button class="tok-edit" data-campo="${k}">
        <span class="tok-kind">${esc(CAMPOS[k].kind)}</span>${esc(CAMPOS[k].label())}
      </button>
      <button class="tok-del" data-campo="${k}" title="Quitar">&times;</button>
    </span>`).join('');
  document.getElementById('qbar-clear').hidden = !act.length;
  document.getElementById('qbarSentence').textContent = act.length
    ? 'Equivale a: ' + act.map(k => `${CAMPOS[k].kind.toLowerCase()}: ${CAMPOS[k].label()}`).join(' + ')
    : 'Sin filtros: el catálogo completo.';
}

function renderPalette(q = '') {
  const n = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const hit = k => !q || n(CAMPOS[k].kind + ' ' + CAMPOS[k].grupo + ' ' + CAMPOS[k].hint).includes(n(q));
  const items = Object.keys(CAMPOS).filter(hit);
  document.getElementById('palList').innerHTML = items.length
    ? items.map((k, i) => `
        <button class="qpop-item${i === 0 ? ' sel' : ''}" data-campo="${k}">
          <span class="qpop-group">${esc(CAMPOS[k].grupo)}</span>${esc(CAMPOS[k].kind)}
          <span class="qpop-hint">${esc(CAMPOS[k].hint)}</span>
        </button>`).join('')
    : '<div class="qpop-empty">Ning&#250;n filtro coincide con esa palabra.</div>';
}

function abrirPaleta(v) {
  const pal = document.getElementById('palette');
  pal.hidden = !v;
  if (!v) return;
  cerrarEditor();
  const input = document.getElementById('palInput');
  input.value = '';
  renderPalette();
  input.focus();
}

const cerrarEditor = () => { document.getElementById('editor').hidden = true; };

// Un editor por tipo de campo. Devuelve el HTML del cuerpo; los eventos se
// delegan en el contenedor, así que ninguno necesita registrar los suyos.
function cuerpoEditor(campo) {
  const chips = (lista, actual, attr = 'v') => `<div class="qpop-chips">` + lista.map(o =>
    `<button class="qpop-chip${o.v === actual ? ' on' : ''}" data-${attr}="${esc(o.v)}">${esc(o.label)}` +
    (o.count != null ? `<span>${mx(o.count)}</span>` : '') + `</button>`).join('') + `</div>`;

  if (campo === 'tipo')      return chips(TIPOS.map(t => ({ v: t, label: t })), F.tipo);
  if (campo === 'operacion') return chips([{ v: 'rent', label: 'en renta' }, { v: 'sale', label: 'en venta' }], F.operacion);
  if (campo === 'orden')     return chips(Object.entries(ORDENES).map(([v, label]) => ({ v, label })), F.orden);
  if (campo === 'fuente')    return chips(Object.keys(facetas.por_fuente).sort().map(f =>
                                    ({ v: f, label: FUENTE_CONFIG[f]?.label ?? f, count: facetas.por_fuente[f] })), F.fuente);
  if (campo === 'zona')      return chips(zonas.slice(0, 24).map(z =>
                                    ({ v: z.norm, label: z.nombre, count: z.listings })), F.zona);
  if (campo === 'radio') return `
    <div class="qpop-row">
      <input class="qpop-num" id="edNear" value="${esc(F.near)}" placeholder="25.6329, -100.3577">
      <input type="range" min="500" max="12000" step="500" value="${F.radio}" id="edRadio" style="width:132px;accent-color:var(--accent)">
      <span class="qpop-title" id="edRadioTxt">${(F.radio / 1000).toFixed(1)} km</span>
    </div>`;
  const [min, max, fmt] = campo === 'precio'
    ? ['precio_min', 'precio_max', 'M&#237;n'] : ['m2_min', 'm2_max', 'M&#237;n m&#178;'];
  return `
    <div class="qpop-row">
      <input class="qpop-num" type="number" id="edMin" value="${esc(F[min])}" placeholder="${fmt}" data-k="${min}">
      <span class="qpop-dash">&mdash;</span>
      <input class="qpop-num" type="number" id="edMax" value="${esc(F[max])}" placeholder="M&#225;x" data-k="${max}">
    </div>`;
}

function abrirEditor(campo) {
  abrirPaleta(false);
  const ed = document.getElementById('editor');
  ed.dataset.campo = campo;
  ed.innerHTML = `
    <div class="qpop-head">
      <span class="qpop-title">${esc(CAMPOS[campo].kind)}</span>
      <button class="qpop-x" id="edClose">&times;</button>
    </div>
    ${cuerpoEditor(campo)}
    <div class="qpop-foot">
      <span>${mx(totalFiltrado)} coinciden</span>
      <button class="qpop-ok" id="edOk">Listo</button>
    </div>`;
  ed.hidden = false;
  ed.querySelector('input')?.focus();
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderStats() {
  const n = e => facetas.por_estado[STATUS_TO_API[e]] ?? 0;
  const celda = (num, label, color) =>
    `<div class="stat"><span class="stat-num" style="color:${color}">${mx(num)}</span>` +
    `<span class="stat-label">${label}</span></div>`;
  document.getElementById('statsBar').innerHTML =
    `<div class="stat stat-main"><span class="stat-num">${mx(totalFiltrado)}</span>` +
    `<span class="stat-label">listados visibles</span></div>` +
    celda(n('Nuevo'), 'nuevos', 'var(--s-nuevo)') +
    celda(n('Revisado'), 'revisados', 'var(--s-revisado)') +
    celda(n('Contactado'), 'contactados', 'var(--s-contactado)') +
    celda(n('Rentado'), 'rentados', 'var(--s-rentado)') +
    celda(facetas.destacados, '★ destacados', 'var(--accent)');
}

function renderStatusPills() {
  const n = v => v === 'Todos' ? facetas.total : (facetas.por_estado[STATUS_TO_API[v]] ?? 0);
  document.getElementById('statusPills').innerHTML = ['Todos', ...STATUSES].map(v =>
    `<button class="pill${filterStatus === v ? ' active' : ''}" data-group="status" data-val="${v}">` +
    `${v}<span class="pill-count">${mx(n(v))}</span></button>`).join('');
  document.getElementById('pill-starred').classList.toggle('active', filterStarred);
  document.getElementById('starredCount').textContent = mx(facetas.destacados);
}

function renderPagination(totalPages) {
  const box = document.getElementById('pagination');
  if (totalPages <= 1) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <button class="btn-clear" id="page-prev" ${page <= 1 ? 'disabled' : ''}>&larr; Anterior</button>
    <span>P&#225;gina ${mx(page)} de ${mx(totalPages)}</span>
    <button class="btn-clear" id="page-next" ${page >= totalPages ? 'disabled' : ''}>Siguiente &rarr;</button>`;
  const ir = d => { page += d; render(); window.scrollTo({ top: 0 }); };
  document.getElementById('page-prev')?.addEventListener('click', () => ir(-1));
  document.getElementById('page-next')?.addEventListener('click', () => ir(1));
}

let renderEnCurso = null;

function render() {
  // Un clic rápido en varios filtros dispararía peticiones que llegan desordenadas;
  // encadenarlas garantiza que la última en salir es la que se pinta.
  renderEnCurso = (renderEnCurso ?? Promise.resolve()).then(_render).catch(err => {
    console.error(err);
    document.getElementById('grid').innerHTML =
      `<div class="empty"><h2>No se pudo cargar el inventario</h2><p>${esc(err.message)}</p></div>`;
  });
  return renderEnCurso;
}

async function _render() {
  await cargarPagina();

  document.getElementById('countNum').textContent = mx(totalFiltrado);
  document.getElementById('countTotal').textContent = mx(facetas.total);
  document.getElementById('footCount').textContent = `${mx(totalFiltrado)} RESULTADOS`;
  document.getElementById('footFuentes').textContent =
    `${Object.keys(facetas.por_fuente).length} FUENTES`;
  renderTokens();
  renderStats();
  renderStatusPills();

  const grid = document.getElementById('grid');
  if (!listings.length) {
    grid.innerHTML = `<div class="empty">
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35M8 11h6"/></svg>
      <h2>Ning&#250;n inmueble cumple estos filtros</h2>
      <p>Quita un token de la sentencia, ampl&#237;a el radio, o limpia todo para volver al cat&#225;logo completo.</p>
      <button class="btn-solid" id="empty-clear">Limpiar filtros</button>
    </div>`;
    document.getElementById('empty-clear').addEventListener('click', limpiarTodo);
    document.getElementById('pagination').innerHTML = '';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(totalFiltrado / PAGE_SIZE));
  if (page > totalPages) { page = totalPages; return _render(); }
  renderPagination(totalPages);
  grid.innerHTML = listings.map(renderCard).join('');
}

function limpiarTodo() {
  Object.values(CAMPOS).forEach(c => c.clear());
  F.q = ''; searchStreet = ''; filterStatus = 'Todos'; filterStarred = false;
  document.getElementById('searchInput').value = '';
  document.getElementById('searchChip').hidden = true;
  abrirPaleta(false); cerrarEditor();
  page = 1; render();
}

// ── Autocompletado de ubicación ──────────────────────────────────────────────

let sugerenciaPeticion = 0;

async function renderSuggestions(q) {
  const box = document.getElementById('searchSuggestions');
  if (q.length < 2 || searchStreet) { box.classList.remove('open'); return; }
  // Cada tecla dispara una petición; sólo la última puede pintar.
  const mia = ++sugerenciaPeticion;
  const matches = await API.get(`/ubicaciones?q=${encodeURIComponent(q)}`).catch(() => []);
  if (mia !== sugerenciaPeticion || !matches.length) { box.classList.remove('open'); return; }
  box.innerHTML = '<div class="suggestions-header"><span>Ubicaciones</span></div>' +
    matches.map(s => `<div class="suggestion-row" data-text="${esc(s.text)}">
        <svg class="suggestion-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
        <span class="suggestion-text">${esc(s.text)}</span>
        <span class="suggestion-count">${mx(s.count)}</span>
      </div>`).join('');
  box.classList.add('open');
}

// ── Export ───────────────────────────────────────────────────────────────────

function exportCSV() {
  // ponytail: exporta la página visible. Si hace falta el filtro completo, se
  // agrega ?formato=csv a /api/listings y lo arma el servidor.
  const header = ['ID', 'Fuente', 'Precio', 'Moneda', 'Título', 'Dirección', 'Estado', 'Destacado', 'Notas', 'URL', 'Teléfono'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const filas = listings.map(l => [l.id, l.fuente, l.precio?.monto ?? '', l.precio?.moneda ?? '',
    l.titulo ?? '', l.direccion ?? '', l.status, l.starred ? 'Sí' : 'No', l.notes, l.url ?? '', l.whatsapp ?? '']);
  const csv = '﻿' + [header, ...filas].map(r => r.map(q).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  a.download = `officelab_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ── Eventos ──────────────────────────────────────────────────────────────────

document.getElementById('qbar').addEventListener('click', e => {
  const del = e.target.closest('.tok-del');
  if (del) { CAMPOS[del.dataset.campo].clear(); page = 1; cerrarEditor(); return render(); }
  const edit = e.target.closest('.tok-edit');
  if (edit) return abrirEditor(edit.dataset.campo);
  const pal = e.target.closest('.qpop-item');
  if (pal) return abrirEditor(pal.dataset.campo);
  if (e.target.closest('#qbar-add')) return abrirPaleta(document.getElementById('palette').hidden);
  if (e.target.closest('#qbar-clear')) return limpiarTodo();
  if (e.target.closest('#edClose') || e.target.closest('#edOk')) return cerrarEditor();

  const chip = e.target.closest('.qpop-chip');
  if (chip) {
    const campo = document.getElementById('editor').dataset.campo;
    const v = chip.dataset.v;
    // Volver a tocar el chip activo lo quita: es la forma más corta de deshacer.
    const destino = { tipo: 'tipo', operacion: 'operacion', zona: 'zona', fuente: 'fuente', orden: 'orden' }[campo];
    F[destino] = (F[destino] === v && campo !== 'orden') ? '' : v;
    if (campo === 'orden' && F.orden === v) F.orden = 'recientes';
    page = 1; render();
  }
});

document.getElementById('qbar').addEventListener('input', e => {
  if (e.target.id === 'palInput') return renderPalette(e.target.value.trim());
  if (e.target.id === 'edMin' || e.target.id === 'edMax') { F[e.target.dataset.k] = e.target.value; page = 1; return render(); }
  if (e.target.id === 'edNear') { F.near = e.target.value.trim(); page = 1; return render(); }
  if (e.target.id === 'edRadio') {
    F.radio = Number(e.target.value);
    document.getElementById('edRadioTxt').textContent = `${(F.radio / 1000).toFixed(1)} km`;
    if (F.near) { page = 1; render(); }
  }
});

document.getElementById('statebar').addEventListener('click', e => {
  if (e.target.closest('#export-btn')) return exportCSV();
  const pill = e.target.closest('.pill');
  if (!pill) return;
  if (pill.dataset.group === 'starred') filterStarred = !filterStarred;
  else if (pill.dataset.group === 'status') filterStatus = pill.dataset.val;
  page = 1; render();
});

document.getElementById('grid').addEventListener('click', e => {
  const card = e.target.closest('.card');
  if (!card || !e.target.closest('.btn-star')) return;
  setState(card.dataset.id, { starred: !listingsMap[card.dataset.id].starred });
  render();
});

document.getElementById('grid').addEventListener('change', e => {
  const sel = e.target.closest('.status-select');
  if (!sel) return;
  const card = sel.closest('.card');
  setState(card.dataset.id, { status: sel.value });
  render();
});

const searchInput = document.getElementById('searchInput');
searchInput.addEventListener('input', e => {
  F.q = e.target.value.trim(); page = 1;
  renderSuggestions(F.q); render();
});
searchInput.addEventListener('blur', () => {
  setTimeout(() => document.getElementById('searchSuggestions').classList.remove('open'), 150);
});
document.getElementById('searchSuggestions').addEventListener('mousedown', e => {
  const row = e.target.closest('.suggestion-row');
  if (!row) return;
  e.preventDefault();
  searchStreet = row.dataset.text;
  F.q = '';
  searchInput.value = '';
  document.getElementById('searchChipText').textContent = searchStreet;
  document.getElementById('searchChip').hidden = false;
  document.getElementById('searchSuggestions').classList.remove('open');
  page = 1; render();
});
document.getElementById('searchChipClose').addEventListener('click', () => {
  searchStreet = '';
  document.getElementById('searchChip').hidden = true;
  page = 1; render();
});

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); abrirPaleta(true); }
  if (e.key === 'Escape') { abrirPaleta(false); cerrarEditor(); }
});
// Un clic fuera cierra los popovers; dentro de .qbar los maneja su propio listener.
document.addEventListener('click', e => {
  if (!e.target.closest('.qbar')) { abrirPaleta(false); cerrarEditor(); }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await API.logout().catch(() => {});
  location.replace('login.html');
});

// ── Init ─────────────────────────────────────────────────────────────────────

API.me().then(async () => {
  document.getElementById('authBox').hidden = true;
  document.getElementById('userBox').hidden = false;
  zonas = await API.get('/zonas').catch(() => []);
  await render();
}).catch(err => {
  // El 401 lo maneja api.js redirigiendo al login; aquí sólo quedan fallos reales.
  console.error(err);
  document.getElementById('grid').innerHTML =
    `<div class="empty"><h2>No se pudo cargar el inventario</h2><p>${esc(err.message)}</p></div>`;
});

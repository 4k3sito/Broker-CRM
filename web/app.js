// Tablero de propiedades. El filtro es una "sentencia editable": cada criterio es
// un token que se quita con la ×, y `+ filtro` (⌘K) abre la paleta para agregar
// otro. Sustituye a las filas de píldoras — con diez filtros posibles, una fila
// por filtro no cabía en la barra y el asesor no veía qué tenía aplicado.
// Todo el filtrado ocurre en SQL: antes se bajaba la tabla entera (~25 MB).

// El anuncio —su forma, sus precios y sus etiquetas— viene de anuncio.js.

// Dos pestañas, la misma página: Bolsa Inmobiliaria (anuncios sin ficha) y
// Catálogo (lo que ya tiene ficha o se presentó a un cliente). Sólo cambia `ficha=`
// en la API; Catálogo suma los filtros de cliente y etapa. En el código y en la URL
// la pestaña sigue siendo `inmobiliaria`: así se llamó en pantalla hasta el 2026-10-06.
const TAB = new URLSearchParams(location.search).get('tab') === 'inmobiliaria' ? 'inmobiliaria' : 'bolsa';
const INMO = TAB === 'inmobiliaria';
// Cómo se llama la vista con que abre el mapa (config.js).
const CENTRO_NOMBRE = window.OL_CONFIG?.centroNombre ?? 'Monterrey';
try { sessionStorage.setItem('ol-tab', TAB); } catch { /* sin persistencia */ }
document.title = `${INMO ? 'Catálogo' : 'Bolsa Inmobiliaria'} · OfficeLab`;

const TIPOS  = ['oficina', 'local', 'bodega', 'terreno', 'edificio'];
const ORDENES = { recientes: 'Recientes', precio_asc: 'Precio ↑', precio_desc: 'Precio ↓', m2_desc: 'Más m²' };


const ICON_EXTERNAL = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
const ICON_PIN = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
const ICON_BUILDING_LG = `<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 21V7l9-4 9 4v14"/><polyline points="9 22 9 12 15 12 15 22"/><path d="M3 7h18"/></svg>`;

// ── Estado ───────────────────────────────────────────────────────────────────

// Un solo objeto con lo que la API entiende. Los tokens son una vista de esto,
// no una estructura paralela: así no hay dos verdades que sincronizar.
const F = {
  q: '', operacion: '', fuente: '',
  precio_min: '', precio_max: '', m2_min: '', m2_max: '', m2_de: '', ppm_min: '', ppm_max: '',
  near: '', radio: 2000, orden: 'recientes',
  cliente: null,   // { id, nombre } cuando se llegó con ?cliente=<id>: sus criterios son los filtros
  // Sólo Inmobiliaria: a qué cliente se presentó y en qué etapa va el proceso.
  pcliente: '', etapas: [], asesor: '',
  // Los tres de la barra fija. `lugares` guarda el objeto completo y no sólo el id
  // porque el chip tiene que poder decir "Monterrey" sin volver a preguntarle a la API.
  lugares: [],     // [{ valor:'m40', nombre:'Monterrey', estado:'Nuevo León' }]
  tipos: [],       // ['local','bodega']
};

// Los cuatro tipos que ofrece el filtro. `oficina` se queda con cero anuncios por
// decisión de producto —van a llegar— y `edificio` se fue porque nunca pudo devolver
// nada: no es un valor que produzca tipo_norm(). Misma lista que TIPOS_COM en la API.
const TIPOS_COM = ['oficina', 'local', 'bodega', 'terreno'];
const MAX_LUGARES = 20;          // igual que en la API
let filterStatus  = 'Todos';
let filterStarred = false;
let searchStreet  = '';
let page = 1;
const PAGE_SIZE = 70;

let listings = [], listingsMap = {}, totalFiltrado = 0;
let facetas = { total: 0, destacados: 0, por_estado: {}, por_fuente: {} };
let zonas = [];
// Selección múltiple: sobrevive a cambios de página y de filtro. Guarda el
// inmueble completo para que la bandeja no dependa de la página visible.
const seleccion = new Map();
const MAX_COMPARAR = 4;
const MAX_FUSION = 30;      // el tope de la API (duplicados.MAX_FUSION)

// ── Tokens: la sentencia ─────────────────────────────────────────────────────

// Cada entrada sabe pintarse (`label`) y limpiarse (`clear`). El editor concreto
// lo resuelve `abrirEditor`; aquí sólo vive lo que comparten.
// Ubicación, precio y tipo NO están aquí: viven en la barra fija de arriba (`fb-`),
// que es donde el asesor los busca. La paleta se queda con lo secundario.
// De qué superficie habla el filtro de m². Vacío: la del anuncio, sea cual sea.
const M2_DE = { terreno: 'terreno', construccion: 'construcción' };
const CAMPOS = {
  radio:     { kind: 'Radio',     grupo: 'Ubicación', hint: 'a N km de un punto',
               label: () => `a ${(F.radio / 1000).toFixed(1).replace(/\.0$/, '')} km de ${F.nearTxt || F.near}`,
               clear: () => { F.near = ''; F.nearTxt = ''; } },
  m2:        { kind: 'M²',        grupo: 'Números',   hint: 'superficie: terreno o construcción',
               label: () => rango(F.m2_min, F.m2_max, v => `${mx(v)} m²`) + (M2_DE[F.m2_de] ? ` de ${M2_DE[F.m2_de]}` : ''),
               clear: () => { F.m2_min = ''; F.m2_max = ''; F.m2_de = ''; } },
  ppm:       { kind: '$/m²',      grupo: 'Números',   hint: 'precio por metro cuadrado',
               label: () => rango(F.ppm_min, F.ppm_max, v => `$${mx(v)}/m²`),
               clear: () => { F.ppm_min = ''; F.ppm_max = ''; } },
  // No se ofrece en la paleta: sólo aparece cuando se llega desde un cliente. Quitarlo
  // quita los filtros que trajo; editarlo lleva al cliente.
  cliente:   { kind: 'Cliente',   grupo: 'CRM',       hint: '', oculto: true,
               label: () => F.cliente?.nombre ?? '',
               clear: () => { if (F.cliente) quitarCriterios(); } },
  fuente:    { kind: 'Fuente',    grupo: 'Origen',    hint: 'portal de origen',
               label: () => Anuncio.fuente(F.fuente),
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
  k === 'm2'     ? !!(F.m2_min || F.m2_max) :
  k === 'ppm'    ? !!(F.ppm_min || F.ppm_max) :
  k === 'orden'  ? F.orden !== 'recientes' : !!F[k]);

console.assert(activos().length === 0, 'sin filtros no debe haber tokens');

// ── Datos ────────────────────────────────────────────────────────────────────

const paramsBase = () => ({
  q: searchStreet || F.q,
  lugar: F.lugares.map(l => l.valor), tipo: F.tipos,
  operacion: F.operacion, fuente: F.fuente,
  precio_min: F.precio_min, precio_max: F.precio_max,
  m2_min: F.m2_min, m2_max: F.m2_max, m2_de: (F.m2_min || F.m2_max) ? F.m2_de : '',
  ppm_min: F.ppm_min, ppm_max: F.ppm_max,
  near: F.near, radio: F.near ? F.radio : '',
  favoritos: filterStarred,
  ficha: INMO ? 'con' : 'sin',
  // 'sin' no es un cliente: es "lo que no se le ha presentado a nadie".
  pcliente: INMO && F.pcliente !== 'sin' ? F.pcliente : '', sin_cliente: INMO && F.pcliente === 'sin',
  etapa: INMO ? F.etapas : [],
  asesor: INMO ? F.asesor : '',
});

async function cargarPagina() {
  const [lista, f] = await Promise.all([
    API.get(`/listings${API.qs({ ...paramsBase(), orden: F.orden,
      estado: filterStatus !== 'Todos' ? Anuncio.estadoApi(filterStatus) : '',
      page, per_page: PAGE_SIZE })}`),
    // Las facetas ignoran el filtro de estado a propósito: alimentan las píldoras.
    API.get(`/listings/facets${API.qs(paramsBase())}`),
  ]);
  listings = lista.items.map(Anuncio.de);
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
    status: Anuncio.estadoApi(l.status), starred: l.starred, notes: l.notes,
  }).catch(err => {
    // Que no se pierda en silencio: la tarjeta volvía sola a su estado anterior.
    console.warn('No se pudo guardar el estado:', err.message);
    toast(`No se pudo guardar el cambio: ${err.message}`);
  });
}

// ── Precio ───────────────────────────────────────────────────────────────────

// Las reglas son de anuncio.js; aquí sólo se escriben. Un total calculado se redondea;
// el precio publicado se enseña tal cual.
function fmtPrice(l) {
  const v = Anuncio.precioVisible(l);
  if (!v) return null;
  if (v.parcial) return { n: mx(v.monto), nota: 'por m²', parcial: true };
  return v.unitario != null ? { n: mx(Math.round(v.monto)), nota: `$${mx(v.unitario)}/m²` } : { n: mx(v.monto) };
}

// El segundo precio va como línea aparte para que el asesor vea las dos opciones sin
// abrir el anuncio.
function altPriceHtml(l) {
  const s = Anuncio.segundoPrecio(l);
  if (!s) return '';
  if (!s.precio) return `<div class="price-alt">${s.etiqueta}</div>`;
  return `<div class="price-alt">${s.etiqueta}: <strong>${s.precio}</strong>${s.nota ? ' ' + s.nota : ''}</div>`;
}

// ── Tarjeta ──────────────────────────────────────────────────────────────────

function renderCard(l) {
  const blabel = Anuncio.fuente(l.fuente).toUpperCase();
  const p = fmtPrice(l);
  const foto = l.fotos?.[0] ?? null;
  // Si el precio ya es por m², repetirlo aquí sería decir dos veces lo mismo.
  const pm = l.porM2 ? null : Anuncio.porMetro(l);
  const ppm = pm ? `$${mx(Math.round(pm))} / m²` : '';
  const sufijo = l.transaccion === 'Renta' ? `${Anuncio.moneda(l)} / mes` : Anuncio.moneda(l);

  const imgHtml = foto
    ? `<img src="${esc(foto)}" alt="" loading="lazy">`
    : `<div class="card-img-blueprint"></div><div class="card-img-icon">${ICON_BUILDING_LG}</div>`;

  // Varios anuncios del mismo inmueble: la tarjeta enseña entre qué precios se ofrece.
  const rg = Anuncio.rango(l), dup = Anuncio.resumen(l);
  const priceHtml = rg
    ? `<div class="card-price rango"><strong>${dineroCorto(rg.min)}</strong><span class="card-a">a</span><strong>${dineroCorto(rg.max)}</strong><span class="currency">${sufijo}</span></div>`
    : p
    ? `<div class="card-price"><strong>$${p.n}</strong><span class="currency">${sufijo}</span></div>` +
      (p.nota ? `<span class="price-note">${p.nota}${p.parcial ? '' : ' × ' + mx(l.size) + ' m²'}</span>` : '')
    : `<div class="card-price"><strong class="no-price">Sin precio</strong></div>`;

  const sel = seleccion.has(l.id);
  return `<article class="card ${l.starred ? 'starred' : ''}${sel ? ' sel' : ''} status-${l.status.toLowerCase()}" data-id="${esc(l.id)}">
    <div class="card-img">
      ${imgHtml}
      <span class="badge badge-src">${esc(l.fuentes.length > 1 ? `${l.fuentes.length} PORTALES` : blabel)}</span>
      ${l.fotos?.length ? `<span class="badge badge-foto">FOTO 1/${l.fotos.length}</span>` : ''}
      ${superficies(l.terreno, l.construccion, l.size).map(([k, v]) => `<span class="badge badge-size" title="${k}">${k === 'Superficie' ? '' : k === 'Terreno' ? 'Terreno ' : 'Constr. '}${m2Txt(v)}</span>`).join('')}
      <button class="card-chk" title="Seleccionar" aria-pressed="${sel}">${sel ? '&#10003;' : ''}</button>
      <button class="btn-star" title="${l.starred ? 'Quitar destacado' : 'Destacar'}">${l.starred ? '&#9733;' : '&#9734;'}</button>
    </div>
    <div class="card-body">
      <div class="card-top">
        <div style="min-width:0">
          ${priceHtml}
          ${ppm ? `<div class="card-ppm">${ppm}</div>` : ''}
          ${altPriceHtml(l)}
          ${dup ? `<div class="card-dup" title="Anuncios del mismo inmueble, fusionados en esta tarjeta">${dup}</div>` : ''}
        </div>
        <a class="card-ver" href="listing.html?id=${encodeURIComponent(l.id)}">Ver ${ICON_EXTERNAL}</a>
      </div>
      ${l.titulo ? `<div class="card-title">${esc(l.titulo)}</div>` : ''}
      ${Anuncio.ubicacion(l) ? `<div class="card-dir">${ICON_PIN}${esc(Anuncio.ubicacion(l))}</div>` : ''}
      <div class="card-tags">
        ${l.tipo ? `<span class="tag-tipo">${esc(l.tipo)}</span>` : ''}
        ${l.transaccion ? `<span class="tag-txn">${esc(l.transaccion)}</span>` : ''}
        ${l.codigo ? `<span class="tag-cod">${esc(l.codigo)}</span>` : ''}
      </div>
      <div class="card-sep"></div>
      <div class="card-status">
        <span class="status-dot" style="background:var(--s-${l.status.toLowerCase()})"></span>
        <select class="status-select s-${l.status}" aria-label="Estado de seguimiento">
          ${Anuncio.ESTADOS.map(st => `<option${st === l.status ? ' selected' : ''}>${st}</option>`).join('')}
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
  // La sentencia tiene que contar TAMBIÉN los tres de la barra fija. Cuando no lo
  // hacía, la página se contradecía: los chips decían "Monterrey · 2 tipos" y aquí
  // abajo se leía "Sin filtros: el catálogo completo".
  const frases = [
    ...FB_CLAVES.filter(k => fbPuesto[k]()).map(k => `${FB_TITULO[k].toLowerCase()}: ${fbResumen[k]()}`),
    ...act.map(k => `${CAMPOS[k].kind.toLowerCase()}: ${CAMPOS[k].label()}`),
  ];
  document.getElementById('qbar-clear').hidden = !frases.length;
  document.getElementById('qbarSentence').textContent = frases.length
    ? 'Equivale a: ' + frases.join(' + ')
    : 'Sin filtros: el catálogo completo.';
}

function renderPalette(q = '') {
  const n = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const hit = k => !q || n(CAMPOS[k].kind + ' ' + CAMPOS[k].grupo + ' ' + CAMPOS[k].hint).includes(n(q));
  const items = Object.keys(CAMPOS).filter(k => !CAMPOS[k].oculto && hit(k));
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
                                    ({ v: f, label: Anuncio.fuente(f), count: facetas.por_fuente[f] })), F.fuente);
  if (campo === 'zona')      return chips(zonas.slice(0, 24).map(z =>
                                    ({ v: z.norm, label: z.nombre, count: z.listings })), F.zona);
  if (campo === 'radio') return `
    <div class="qpop-row">
      <input class="qpop-num" id="edNear" value="${esc(F.near)}" placeholder="25.6329, -100.3577">
      <input type="range" min="500" max="12000" step="500" value="${F.radio}" id="edRadio" style="width:132px;accent-color:var(--accent)">
      <span class="qpop-title" id="edRadioTxt">${(F.radio / 1000).toFixed(1)} km</span>
    </div>`;
  const [min, max, fmt] = campo === 'precio' ? ['precio_min', 'precio_max', 'M&#237;n']
    : campo === 'ppm' ? ['ppm_min', 'ppm_max', 'M&#237;n $/m&#178;']
    : ['m2_min', 'm2_max', 'M&#237;n m&#178;'];
  return `
    <div class="qpop-row">
      <input class="qpop-num" type="number" id="edMin" value="${esc(F[min])}" placeholder="${fmt}" data-k="${min}">
      <span class="qpop-dash">&mdash;</span>
      <input class="qpop-num" type="number" id="edMax" value="${esc(F[max])}" placeholder="M&#225;x" data-k="${max}">
    </div>${campo === 'm2' ? `
    <div class="qpop-row qpop-de">
      <select class="qpop-num" id="edM2De" aria-label="De qu&#233; superficie">
        <option value="">Cualquier superficie</option>
        <option value="terreno"${F.m2_de === 'terreno' ? ' selected' : ''}>S&#243;lo terreno</option>
        <option value="construccion"${F.m2_de === 'construccion' ? ' selected' : ''}>S&#243;lo construcci&#243;n</option>
      </select>
    </div>` : ''}`;
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
  const n = e => facetas.por_estado[Anuncio.estadoApi(e)] ?? 0;
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
  const n = v => v === 'Todos' ? facetas.total : (facetas.por_estado[Anuncio.estadoApi(v)] ?? 0);
  document.getElementById('statusPills').innerHTML = ['Todos', ...Anuncio.ESTADOS].map(v =>
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
  renderTokens();
  renderFB();
  renderStatusPills();
  renderTray();

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
    Mapa.pintar([]);
    return;
  }

  const totalPages = Math.max(1, Math.ceil(totalFiltrado / PAGE_SIZE));
  if (page > totalPages) { page = totalPages; return _render(); }
  renderPagination(totalPages);
  grid.innerHTML = listings.map(renderCard).join('');
  // La ficha usa esto para anterior/siguiente sin volver al tablero.
  try { sessionStorage.setItem('ol-nav', JSON.stringify(listings.map(l => String(l.id)))); } catch { /* sin contexto */ }
  Mapa.pintar(listings);
}

function limpiarTodo() {
  Object.values(CAMPOS).forEach(c => c.clear());
  F.lugares = []; F.tipos = []; F.operacion = ''; F.precio_min = ''; F.precio_max = '';
  F.pcliente = ''; F.etapas = []; F.asesor = '';
  fbCerrar();
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
  const filas = listings.map(l => [l.id, l.fuente, l.precio ?? '', l.precio != null ? l.moneda : '',
    l.titulo ?? '', Anuncio.ubicacion(l) ?? '', l.status, l.starred ? 'Sí' : 'No', l.notes, l.url ?? '', l.whatsapp ?? '']);
  const csv = '﻿' + [header, ...filas].map(r => r.map(q).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  a.download = `officelab_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ── Barra fija: Ubicación, Precio y Tipo ─────────────────────────────────────
//
// Los tres filtros que el asesor usa siempre, visibles sin abrir nada. Lo que los
// define es el BORRADOR: lo que se toca dentro del popover no filtra hasta pulsar
// "Aplicar". Sin eso, marcar cuatro tipos dispara cuatro consultas contra 467k filas
// y la lista brinca bajo el dedo mientras se elige. Esc, un clic fuera o la ✕ del
// popover descartan el borrador; la ✕ del chip sí limpia de inmediato, porque quitar
// un filtro no necesita confirmarse.

const FB_CLAVES = ['ubicacion', 'precio', 'tipo', ...(INMO ? ['cliente', 'asesor', 'etapa'] : [])];
if (INMO) document.querySelectorAll('.fb-chip[data-f="cliente"], .fb-chip[data-f="asesor"], .fb-chip[data-f="etapa"]').forEach(c => { c.hidden = false; });
const FB_TITULO = { ubicacion: 'Ubicación', precio: 'Precio', tipo: 'Tipo de inmueble',
                    cliente: 'Presentada a', asesor: 'La presentó', etapa: 'Etapa del proceso' };
const cap = s => String(s ?? '').charAt(0).toUpperCase() + String(s ?? '').slice(1);

let fbAbierto = null;     // cuál popover está abierto, o null
let fbDraft = null;       // el borrador; se tira si no se aplica
let fbPeticion = 0;       // descarta respuestas del autocompletado que llegan tarde

// Sólo dígitos: el campo se escribe con separadores de miles en vivo.
const fbNum = v => {
  const n = Number(String(v ?? '').replace(/\D/g, ''));
  return Number.isFinite(n) && n > 0 ? n : '';
};

// Formatea para el campo sin confiar en lo que traiga el borrador: acepta número, el
// texto ya formateado, vacío o basura, y nunca devuelve "NaN".
const fbImporte = v => { const n = fbNum(v); return n ? mx(n) : ''; };

const fbResumen = {
  // Sin lugares elegidos pero buscando cerca de un punto, "Todo México" sería mentira:
  // manda el mapa (o el punto que se escribió en el filtro de radio).
  ubicacion: () => !F.lugares.length
      ? (!F.near ? 'Todo México' : F.nearTxt === CENTRO_NOMBRE ? `${CENTRO_NOMBRE} (mapa)`
         : F.nearTxt ? 'Zona del mapa' : 'Cerca de un punto')
    : F.lugares.length === 1 ? F.lugares[0].nombre
    : `${F.lugares[0].nombre} +${F.lugares.length - 1}`,
  precio: () => {
    const op = { rent: 'Renta', sale: 'Venta' }[F.operacion] ?? '';
    const r = (F.precio_min || F.precio_max) ? rango(F.precio_min, F.precio_max, v => `$${mx(v)}`) : '';
    return [op, r].filter(Boolean).join(' · ') || 'Cualquiera';
  },
  tipo: () => !F.tipos.length ? 'Todos'
    : F.tipos.length === 1 ? cap(F.tipos[0]) : `${F.tipos.length} tipos`,
  cliente: () => F.pcliente === 'sin' ? 'Sin cliente' : F.pcliente ? (clientesCache?.find(c => String(c.id) === F.pcliente)?.nombre ?? '1 cliente') : 'Todos',
  asesor: () => F.asesor ? (equipoCache?.find(u => String(u.id) === F.asesor)?.nombre ?? '1 asesor') : 'Todos',
  etapa: () => !F.etapas.length ? 'Todas'
    : F.etapas.length === 1 ? etapaLabel(F.etapas[0]) : `${F.etapas.length} etapas`,
};

const fbPuesto = {
  ubicacion: () => F.lugares.length > 0 || !!F.near,
  precio: () => !!(F.operacion || F.precio_min || F.precio_max),
  tipo: () => F.tipos.length > 0,
  cliente: () => !!F.pcliente,
  asesor: () => !!F.asesor,
  etapa: () => F.etapas.length > 0,
};

function renderFB() {
  for (const k of FB_CLAVES) {
    document.getElementById(`fbv-${k}`).textContent = fbResumen[k]();
    const chip = document.querySelector(`.fb-chip[data-f="${k}"]`);
    chip.classList.toggle('on', fbPuesto[k]());
    chip.querySelector('.fb-x').hidden = !fbPuesto[k]();
  }
}

function fbCerrar() {
  fbAbierto = null; fbDraft = null;
  document.getElementById('fbPop').hidden = true;
  document.getElementById('fbScrim').hidden = true;
  document.querySelectorAll('.fb-open').forEach(b => b.setAttribute('aria-expanded', 'false'));
}

function fbAbrir(k) {
  if (fbAbierto === k) return fbCerrar();
  cerrarEditor(); abrirPaleta(false);
  fbAbierto = k;
  // Copia, no referencia: `lugares` y `tipos` se editan dentro del popover y tienen
  // que poder tirarse enteros al cancelar.
  fbDraft = { lugares: F.lugares.slice(), tipos: F.tipos.slice(),
              operacion: F.operacion, min: F.precio_min, max: F.precio_max, sug: [],
              pcliente: F.pcliente, etapas: F.etapas.slice(), asesor: F.asesor };
  const pop = document.getElementById('fbPop');
  pop.dataset.f = k;
  pop.hidden = false;
  document.getElementById('fbScrim').hidden = false;
  document.querySelector(`.fb-open[data-f="${k}"]`).setAttribute('aria-expanded', 'true');
  fbPintarPop();
  pop.querySelector('input:not([type=checkbox])')?.focus();
}

function fbPintarPop() {
  const cuerpo = { ubicacion: fbCuerpoUbicacion, precio: fbCuerpoPrecio, tipo: fbCuerpoTipo,
                   cliente: fbCuerpoCliente, asesor: fbCuerpoAsesor, etapa: fbCuerpoEtapa }[fbAbierto]();
  document.getElementById('fbPop').innerHTML = `
    <div class="fb-head">
      <span class="fb-title">${esc(FB_TITULO[fbAbierto])}</span>
      <button class="fb-close" data-fb="cerrar" title="Cerrar">&times;</button>
    </div>
    ${cuerpo}
    <div class="fb-foot">
      <button class="fb-limpia" data-fb="limpia">Limpiar</button>
      <button class="fb-aplica" data-fb="aplica">Aplicar</button>
    </div>`;
  if (fbAbierto === 'ubicacion') { fbPintarSeleccion(); fbPintarSugerencias(); }
}

// El input vive fuera de lo que se repinta: si se redibujara con cada tecla, el
// cursor se perdería a media palabra.
function fbCuerpoUbicacion() {
  return `
    <input class="fb-in" id="fbBuscaLugar" type="search" autocomplete="off"
           placeholder="Municipio o colonia: Monterrey, Contry&#8230;">
    <div class="fb-sels" id="fbSels"></div>
    <div class="fb-sugs" id="fbSugs"></div>
    <p class="fb-nota" id="fbNota">Municipios y colonias.</p>`;
}

function fbPintarSeleccion() {
  document.getElementById('fbSels').innerHTML = fbDraft.lugares.map((l, i) => `
    <span class="fb-sel">${esc(l.nombre)}<span class="fb-sel-e">${esc(l.contexto ?? '')}</span>
      <button class="fb-sel-x" data-quita="${i}" title="Quitar">&times;</button></span>`).join('');
  const tope = fbDraft.lugares.length >= MAX_LUGARES;
  document.getElementById('fbBuscaLugar').disabled = tope;
  document.getElementById('fbNota').textContent = tope
    ? `Máximo ${MAX_LUGARES} municipios a la vez.`
    : 'Municipios y colonias. Las colonias vienen de INEGI y no cubren todo el país.';
}

function fbPintarSugerencias() {
  document.getElementById('fbSugs').innerHTML = fbDraft.sug.map(s => `
    <button class="fb-sug" data-add="${esc(s.valor)}">${esc(s.nombre)}<span class="fb-sug-e">${esc(s.contexto ?? '')}</span>
      <span class="fb-sug-n">${mx(s.anuncios)}</span></button>`).join('');
}

async function fbBuscarLugares(q) {
  const mio = ++fbPeticion;
  if (q.length < 2) { fbDraft.sug = []; return fbPintarSugerencias(); }
  let r = [];
  try { r = await API.get(`/lugares${API.qs({ q })}`); } catch { r = []; }
  // Una respuesta vieja que llega tarde no puede pisar a una nueva.
  if (mio !== fbPeticion || fbAbierto !== 'ubicacion') return;
  const ya = new Set(fbDraft.lugares.map(l => l.valor));
  fbDraft.sug = r.filter(s => !ya.has(s.valor));
  fbPintarSugerencias();
}

function fbCuerpoPrecio() {
  const seg = [['rent', 'Renta'], ['sale', 'Venta']].map(([v, l]) =>
    `<button class="fb-seg${fbDraft.operacion === v ? ' on' : ''}" data-op="${esc(v)}">${esc(l)}</button>`).join('');
  return `
    <div class="fb-segs">${seg}</div>
    <div class="fb-rango">
      <input class="fb-in fb-num" id="fbMin" inputmode="numeric" placeholder="M&#237;nimo"
             value="${esc(fbImporte(fbDraft.min))}">
      <span class="fb-guion">&mdash;</span>
      <input class="fb-in fb-num" id="fbMax" inputmode="numeric" placeholder="M&#225;ximo"
             value="${esc(fbImporte(fbDraft.max))}">
    </div>
    <p class="fb-nota">Pesos, total del inmueble. Lo que el portal publica por m&#178; ya sale
      multiplicado por su superficie. Tocar la operaci&#243;n activa la quita.</p>`;
}

function fbCuerpoTipo() {
  return '<div class="fb-cajas">' + TIPOS_COM.map(v => `
    <label class="fb-caja">
      <input type="checkbox" data-tipo="${esc(v)}"${fbDraft.tipos.includes(v) ? ' checked' : ''}>
      <span>${esc(cap(v))}</span>
    </label>`).join('') + '</div>';
}

// Inmobiliaria: un cliente a la vez (la pregunta es "¿qué le hemos presentado a X?")
// y varias etapas, con las mismas casillas que Tipo.
function fbCuerpoCliente() {
  const cs = clientesCache ?? [];
  if (!clientesCache) return '<p class="fb-nota">Cargando clientes&#8230;</p>';
  const fijos = [{ id: '', nombre: 'Todos los clientes' }, { id: 'sin', nombre: 'Sin cliente asignado' }];
  return '<div class="fb-cajas fb-cajas-lista">' + [...fijos, ...cs].map(c => `
    <label class="fb-caja">
      <input type="radio" name="fbCliente" data-pcliente="${esc(c.id)}"${String(fbDraft.pcliente) === String(c.id) ? ' checked' : ''}>
      <span>${esc(c.nombre)}</span>
    </label>`).join('') + '</div>';
}
// Las propiedades que presentó un asesor, con el cliente que sea (`proceso.trae_id`: la
// columna «Presentó» de la tabla de cada cliente). Se combina con Cliente y Etapa.
let equipoCache = null;
async function cargarEquipo() {
  if (!equipoCache) equipoCache = await API.get('/equipo').catch(() => []);
  return equipoCache;
}
function fbCuerpoAsesor() {
  if (!equipoCache) return '<p class="fb-nota">Cargando asesores&#8230;</p>';
  return '<div class="fb-cajas fb-cajas-lista">' + [{ id: '', nombre: 'Todos los asesores' }, ...equipoCache].map(u => `
    <label class="fb-caja">
      <input type="radio" name="fbAsesor" data-asesor="${esc(u.id)}"${String(fbDraft.asesor) === String(u.id) ? ' checked' : ''}>
      <span>${esc(u.nombre || u.email)}</span>
    </label>`).join('') + '</div>';
}
function fbCuerpoEtapa() {
  return '<div class="fb-cajas">' + ETAPAS.map(e => `
    <label class="fb-caja">
      <input type="checkbox" data-etapa="${esc(e.key)}"${fbDraft.etapas.includes(e.key) ? ' checked' : ''}>
      <span>${esc(e.label)}</span>
    </label>`).join('') + '</div>';
}

function fbLimpiarBorrador() {
  if (fbAbierto === 'cliente') fbDraft.pcliente = '';
  if (fbAbierto === 'asesor') fbDraft.asesor = '';
  if (fbAbierto === 'etapa') fbDraft.etapas = [];
  if (fbAbierto === 'ubicacion') { fbDraft.lugares = []; fbDraft.sug = []; }
  if (fbAbierto === 'tipo') fbDraft.tipos = [];
  if (fbAbierto === 'precio') { fbDraft.operacion = ''; fbDraft.min = ''; fbDraft.max = ''; }
  fbPintarPop();
}

function fbAplicar() {
  if (fbAbierto === 'cliente') {
    F.pcliente = fbDraft.pcliente;
    // Sin cliente no hay proceso, y sin proceso no hay etapa: las dos juntas no
    // devolverían nada nunca.
    if (F.pcliente === 'sin') { F.etapas = []; F.asesor = ''; }
  }
  if (fbAbierto === 'etapa' && fbDraft.etapas.length && F.pcliente === 'sin') F.pcliente = '';
  if (fbAbierto === 'etapa') F.etapas = fbDraft.etapas.slice();
  if (fbAbierto === 'asesor') {
    F.asesor = fbDraft.asesor;
    // Sin cliente no hay proceso, y sin proceso nadie la presentó.
    if (F.asesor && F.pcliente === 'sin') F.pcliente = '';
  }
  if (fbAbierto === 'ubicacion') F.lugares = fbDraft.lugares.slice(0, MAX_LUGARES);
  if (fbAbierto === 'tipo') F.tipos = fbDraft.tipos.slice();
  if (fbAbierto === 'precio') {
    let min = fbNum(fbDraft.min), max = fbNum(fbDraft.max);
    // Un mínimo mayor que el máximo no devuelve nada nunca. Voltearlos es lo que
    // la persona quiso decir, y decírselo con una pantalla vacía sería peor.
    if (min && max && min > max) [min, max] = [max, min];
    F.operacion = fbDraft.operacion; F.precio_min = min || ''; F.precio_max = max || '';
  }
  fbCerrar(); page = 1; render();
}

function fbQuitar(k) {
  // Con lugares elegidos la ✕ quita los lugares; sin ellos, lo que el chip dice es el
  // filtro de cercanía, y es eso lo que quita.
  if (k === 'ubicacion') { if (F.lugares.length) F.lugares = []; else { F.near = ''; F.nearTxt = ''; } }
  if (k === 'tipo') F.tipos = [];
  if (k === 'cliente') F.pcliente = '';
  if (k === 'etapa') F.etapas = [];
  if (k === 'asesor') F.asesor = '';
  if (k === 'precio') { F.operacion = ''; F.precio_min = ''; F.precio_max = ''; }
  if (fbAbierto === k) fbCerrar();
  page = 1; render();
}

document.getElementById('fb').addEventListener('click', e => {
  const x = e.target.closest('.fb-x');
  if (x) return fbQuitar(x.dataset.x);
  const abre = e.target.closest('.fb-open');
  if (abre) return fbAbrir(abre.dataset.f);
});

document.getElementById('fbPop').addEventListener('click', e => {
  const acc = e.target.closest('[data-fb]')?.dataset.fb;
  if (acc === 'cerrar') return fbCerrar();
  if (acc === 'limpia') return fbLimpiarBorrador();
  if (acc === 'aplica') return fbAplicar();

  const add = e.target.closest('.fb-sug');
  if (add) {
    const s = fbDraft.sug.find(x => x.valor === add.dataset.add);
    if (s && fbDraft.lugares.length < MAX_LUGARES) {
      fbDraft.lugares.push({ valor: s.valor, nombre: s.nombre, contexto: s.contexto });
      fbDraft.sug = fbDraft.sug.filter(x => x.valor !== s.valor);
      document.getElementById('fbBuscaLugar').value = '';
      fbPintarSeleccion(); fbPintarSugerencias();
    }
    return;
  }
  const quita = e.target.closest('.fb-sel-x');
  if (quita) {
    fbDraft.lugares.splice(Number(quita.dataset.quita), 1);
    return fbPintarSeleccion();
  }
  const seg = e.target.closest('.fb-seg');
  if (seg) {
    // Tocar la operación activa la quita: es la forma más corta de volver a "las dos".
    fbDraft.operacion = fbDraft.operacion === seg.dataset.op ? '' : seg.dataset.op;
    // `fbNum` y no `.value`: el campo se ve como "90,000" y `Number("90,000")` es NaN.
    // Cambiar de operación borraba los importes y escribía NaN en su lugar.
    fbDraft.min = fbNum(document.getElementById('fbMin').value);
    fbDraft.max = fbNum(document.getElementById('fbMax').value);
    fbPintarPop();
  }
});

document.getElementById('fbPop').addEventListener('input', e => {
  if (e.target.id === 'fbBuscaLugar') return fbBuscarLugares(e.target.value.trim());
  if (e.target.id === 'fbMin' || e.target.id === 'fbMax') {
    // Miles en vivo. El cursor va al final a propósito: reponerlo donde estaba
    // exige contar separadores y aquí se escribe de izquierda a derecha.
    const n = fbNum(e.target.value);
    e.target.value = n ? mx(n) : '';
    fbDraft[e.target.id === 'fbMin' ? 'min' : 'max'] = n;
  }
});

document.getElementById('fbPop').addEventListener('change', e => {
  if (e.target.matches('[data-pcliente]')) { fbDraft.pcliente = e.target.dataset.pcliente; return; }
  if (e.target.matches('[data-asesor]')) { fbDraft.asesor = e.target.dataset.asesor; return; }
  if (e.target.matches('[data-etapa]')) {
    const v = e.target.dataset.etapa;
    fbDraft.etapas = e.target.checked ? [...new Set([...fbDraft.etapas, v])] : fbDraft.etapas.filter(x => x !== v);
    return;
  }
  const c = e.target.closest('input[type=checkbox][data-tipo]');
  if (!c) return;
  const v = c.dataset.tipo;
  fbDraft.tipos = c.checked ? [...new Set([...fbDraft.tipos, v])] : fbDraft.tipos.filter(x => x !== v);
});

// Enter aplica, Esc descarta: el popover se maneja sin ratón.
document.getElementById('fbPop').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id !== 'fbBuscaLugar') { e.preventDefault(); fbAplicar(); }
});
document.getElementById('fbScrim').addEventListener('click', fbCerrar);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && fbAbierto) fbCerrar(); });
// `pointerdown` y no `click`, y no es un detalle: elegir una sugerencia repinta la
// lista, así que para cuando el `click` llega a `document` el elemento clicado ya no
// está en el árbol y `closest('#fbPop')` devuelve null. El popover se cerraba solo al
// elegir un municipio. Al bajar el dedo el elemento todavía está donde debe.
document.addEventListener('pointerdown', e => {
  if (fbAbierto && !e.target.closest('#fbPop') && !e.target.closest('#fb')) fbCerrar();
});

// ── Eventos ──────────────────────────────────────────────────────────────────

document.getElementById('qbar').addEventListener('click', e => {
  const del = e.target.closest('.tok-del');
  if (del) { CAMPOS[del.dataset.campo].clear(); page = 1; cerrarEditor(); return render(); }
  const edit = e.target.closest('.tok-edit');
  if (edit?.dataset.campo === 'cliente') { location.href = `clientes.html#${encodeURIComponent(F.cliente.id)}`; return; }
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
    const destino = { fuente: 'fuente', orden: 'orden' }[campo];
    F[destino] = (F[destino] === v && campo !== 'orden') ? '' : v;
    if (campo === 'orden' && F.orden === v) F.orden = 'recientes';
    page = 1; render();
  }
});

document.getElementById('qbar').addEventListener('input', e => {
  if (e.target.id === 'palInput') return renderPalette(e.target.value.trim());
  if (e.target.id === 'edMin' || e.target.id === 'edMax') { F[e.target.dataset.k] = e.target.value; page = 1; return render(); }
  if (e.target.id === 'edM2De') { F.m2_de = e.target.value; page = 1; return render(); }
  if (e.target.id === 'edNear') { F.near = e.target.value.trim(); F.nearTxt = ''; page = 1; return render(); }
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
  if (!card) return;
  const id = card.dataset.id;
  if (e.target.closest('.btn-star')) {
    setState(id, { starred: !listingsMap[id].starred });
    return render();
  }
  if (e.target.closest('.card-chk')) return toggleSeleccion(id);
  if (e.target.closest('select, a, button')) return;
  // Cmd/Ctrl+clic abre la ficha en otra pestaña, como un enlace normal.
  const url = `listing.html?id=${encodeURIComponent(id)}`;
  if (e.metaKey || e.ctrlKey) window.open(url, '_blank'); else location.href = url;
});

// Hover tarjeta → pin. mouseover burbujea; se ignoran los movimientos internos.
let hoverId = null;
document.getElementById('grid').addEventListener('mouseover', e => {
  const id = e.target.closest('.card')?.dataset.id ?? null;
  if (id !== hoverId) { hoverId = id; Mapa.resaltar(id); }
});
document.getElementById('grid').addEventListener('mouseleave', () => { hoverId = null; Mapa.resaltar(null); });

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
  if (e.key === '/' && !e.target.closest('input, textarea, select')) { e.preventDefault(); searchInput.focus(); }
  if (e.key === 'Escape') {
    const abierto = !document.getElementById('palette').hidden || !document.getElementById('editor').hidden;
    abrirPaleta(false); cerrarEditor();
    if (!abierto && seleccion.size && !e.target.closest('input, textarea')) { seleccion.clear(); render(); }
  }
});

// ── Vista: rejilla sola o rejilla + mapa ─────────────────────────────────────

const inm = document.getElementById('inm');
function ponerVista(v) {
  inm.classList.toggle('split', v === 'split');
  inm.classList.toggle('grid-only', v !== 'split');
  document.querySelectorAll('.seg [data-vista]').forEach(b => b.classList.toggle('on', b.dataset.vista === v));
  try { localStorage.setItem('ol-vista', v); } catch { /* sin persistencia */ }
  requestAnimationFrame(() => Mapa.resize());
}
document.querySelector('.seg').addEventListener('click', e => {
  const b = e.target.closest('[data-vista]');
  if (b) ponerVista(b.dataset.vista);
});
// El mapa ya no depende de una llave (mapa.js): la vista por defecto es rejilla + mapa.
ponerVista((() => { try { return localStorage.getItem('ol-vista'); } catch { return null; } })() ?? 'split');

Mapa.init(document.getElementById('map'), {
  onPin: id => {
    const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    const list = document.getElementById('inmList');
    list.scrollTo({ top: card.offsetTop - 12, behavior: 'smooth' });
    card.classList.add('on');
    setTimeout(() => card.classList.remove('on'), 1600);
  },
  onPinHover: id => document.querySelectorAll('.card').forEach(c => c.classList.toggle('on', c.dataset.id === id)),
  onMove: a => { buscarEnElMapa(a); page = 1; render(); },
});
// Lo que el mapa enseña se vuelve el filtro de cercanía. `de` es cómo se le dice a ese
// punto: al abrir es la vista de fábrica y tiene nombre; después de moverlo, ya no.
function buscarEnElMapa({ lat, lng, radio }, de = 'el centro del mapa') {
  F.near = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  F.nearTxt = de;
  F.radio = radio;
}
// "Buscar al mover el mapa" viene marcado, y el mapa abre en Monterrey
// (OL_CONFIG.centro): la Bolsa arranca con lo que hay ahí y no con el inventario
// nacional. Quien lo apague lo encuentra apagado la próxima vez. Sólo en la Bolsa: las
// propiedades del Catálogo casi nunca traen coordenada y buscar por cercanía las
// escondería.
const mapFollow = document.getElementById('mapFollow');
function seguirMapa(v) { mapFollow.checked = v; Mapa.seguir(v); }
seguirMapa(!INMO && (() => { try { return localStorage.getItem('ol-mapa-seguir'); } catch { return null; } })() !== 'no');
mapFollow.addEventListener('change', e => {
  Mapa.seguir(e.target.checked);
  if (!INMO) try { localStorage.setItem('ol-mapa-seguir', e.target.checked ? 'si' : 'no'); } catch { /* sin persistencia */ }
});

// ── Selección, bandeja y acciones en lote ────────────────────────────────────

function toggleSeleccion(id) {
  if (seleccion.has(id)) seleccion.delete(id);
  else if (listingsMap[id]) seleccion.set(id, listingsMap[id]);
  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (card) {
    const on = seleccion.has(id);
    card.classList.toggle('sel', on);
    const chk = card.querySelector('.card-chk');
    chk.innerHTML = on ? '&#10003;' : '';
    chk.setAttribute('aria-pressed', on);
  }
  renderTray();
}

function renderTray() {
  const tray = document.getElementById('tray');
  const n = seleccion.size;
  tray.hidden = !n;
  document.body.classList.toggle('has-tray', n > 0);
  inm.classList.toggle('selecting', n > 0);
  if (!n) return;
  document.getElementById('trayCount').textContent = n === 1 ? '1 seleccionada' : `${n} seleccionadas`;
  const items = [...seleccion.values()];
  document.getElementById('trayItems').innerHTML = items.slice(0, MAX_COMPARAR).map(l => {
    const p = fmtPrice(l);
    return `<span class="tray-item" data-id="${esc(l.id)}">
      ${l.fotos?.[0] ? `<img src="${esc(l.fotos[0])}" alt="">` : '<span class="tray-thumb"></span>'}
      <span class="tray-txt"><b>${p ? '$' + p.n : 'Sin precio'}</b><small>${l.size ? mx(Math.round(l.size)) + ' m² · ' : ''}${esc(Anuncio.ubicacion(l) ?? '')}</small></span>
      <button class="tray-x" title="Quitar">&times;</button>
    </span>`;
  }).join('') + (n > MAX_COMPARAR ? `<span class="tray-more">+${n - MAX_COMPARAR}</span>` : '');
  const fus = document.getElementById('trayFusionar');
  fus.disabled = n < 2 || n > MAX_FUSION;
  fus.title = n < 2 ? 'Selecciona al menos 2 tarjetas del mismo inmueble' : n > MAX_FUSION ? `Máximo ${MAX_FUSION}` : 'Son el mismo inmueble: dejar una sola tarjeta';
  const cmp = document.getElementById('trayComparar');
  cmp.disabled = n < 2 || n > MAX_COMPARAR;
  cmp.title = n < 2 ? 'Selecciona al menos 2' : n > MAX_COMPARAR ? `Máximo ${MAX_COMPARAR}` : '';
}

let toastTimer = null;
function toast(msg, deshacer) {
  const t = document.getElementById('toast');
  t.innerHTML = `<span>${esc(msg)}</span>` + (deshacer ? '<button id="toastUndo">Deshacer</button>' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 10000);
  if (deshacer) document.getElementById('toastUndo').onclick = () => { t.hidden = true; deshacer(); };
}

document.getElementById('trayItems').addEventListener('click', e => {
  const it = e.target.closest('.tray-item');
  if (it && e.target.closest('.tray-x')) toggleSeleccion(it.dataset.id);
});
document.getElementById('trayClear').addEventListener('click', () => { seleccion.clear(); render(); });
document.getElementById('trayComparar').addEventListener('click', () => {
  location.href = `comparar.html?ids=${[...seleccion.keys()].map(encodeURIComponent).join(',')}`;
});

document.getElementById('trayEstado').addEventListener('change', e => {
  const nuevo = e.target.value;
  e.target.value = '';
  if (!nuevo) return;
  const previos = [...seleccion.values()].map(l => [l.id, l.status]);
  const aplicar = pares => pares.forEach(([id, st]) => {
    const l = seleccion.get(id) ?? listingsMap[id];
    Object.assign(l, { status: st });
    if (listingsMap[id]) listingsMap[id].status = st;
    API.put(`/listings/${encodeURIComponent(id)}/estado`, {
      status: Anuncio.estadoApi(st), starred: l.starred, notes: l.notes,
    }).catch(err => console.warn('No se pudo guardar el estado:', err.message));
  });
  aplicar(previos.map(([id]) => [id, nuevo]));
  render();
  toast(`${previos.length} ${previos.length === 1 ? 'inmueble' : 'inmuebles'} → ${nuevo}`, () => { aplicar(previos); render(); });
});

// «Son el mismo inmueble»: las tarjetas elegidas quedan en una, con todo lo que cada una
// traía detrás. Lo decide un asesor y vale para el equipo; se deshace desde la ficha,
// separando el anuncio que no era.
document.getElementById('trayFusionar').hidden = INMO;
document.getElementById('trayFusionar').addEventListener('click', async () => {
  const lista = [...seleccion.values()];
  const anuncios = lista.reduce((t, l) => t + l.anuncios, 0);
  if (!confirm(`¿Estas ${lista.length} tarjetas son el mismo inmueble?\n\n`
    + `Quedarán en una sola tarjeta con sus ${anuncios} anuncios, para todo el equipo. `
    + 'Si alguno no era, se separa desde la ficha.')) return;
  try {
    await API.post('/duplicados/fusionar', { ids: lista.map(l => l.id) });
    toast(`${lista.length} tarjetas fusionadas en una`);
    seleccion.clear();
    render();
  } catch (err) { toast(`No se pudo fusionar: ${err.message}`); }
});

// Los clientes se piden una sola vez, la primera vez que hace falta.
let clientesCache = null;
async function cargarClientes() {
  if (clientesCache) return clientesCache;
  clientesCache = (await API.get('/clientes').catch(() => [])).sort((a, b) => a.nombre.localeCompare(b.nombre));
  document.getElementById('trayCliente').innerHTML = '<option value="">Asignar a cliente…</option>' +
    clientesCache.map(c => `<option value="${esc(c.id)}">${esc(c.nombre)}</option>`).join('');
  return clientesCache;
}
document.getElementById('trayCliente').addEventListener('focus', cargarClientes);
document.getElementById('trayCliente').addEventListener('mousedown', cargarClientes);

// Un proceso cuelga de una ficha, no del anuncio. Si el inmueble aún no tiene
// ficha, se crea con los datos del anuncio (igual que el botón de la ficha). El precio
// es el total: en un anuncio publicado por m², el publicado sería $700 por un terreno.
async function fichaDe(l) {
  const fs = await API.get(`/fichas?listing=${encodeURIComponent(l.id)}`).catch(() => []);
  if (fs[0]) return fs[0];
  return API.post('/fichas', {
    source_listing_id: l.id, titulo: l.titulo, precio: Anuncio.total(l),
    moneda: l.moneda, tamano_m2: l.size, fotos: l.fotos,
    construccion_m2: l.construccion && l.construccion !== l.size ? l.construccion : null,
  });
}
document.getElementById('trayCliente').addEventListener('change', async e => {
  const clienteId = e.target.value;
  e.target.value = '';
  if (!clienteId) return;
  const cliente = clientesCache?.find(c => String(c.id) === clienteId);
  const lista = [...seleccion.values()];
  toast(`Proponiendo ${lista.length} a ${cliente?.nombre ?? 'cliente'}…`);
  const res = await Promise.allSettled(lista.map(async l => {
    const f = await fichaDe(l);
    return API.post('/procesos', { cliente_id: clienteId, ficha_id: f.id });
  }));
  const ok = res.filter(r => r.status === 'fulfilled').length;
  toast(ok === lista.length
    ? `${ok} ${ok === 1 ? 'inmueble propuesto' : 'inmuebles propuestos'} a ${cliente?.nombre ?? 'cliente'}`
    : `${ok} de ${lista.length} propuestos. Los demás fallaron o ya estaban.`);
});
// ── Bolsa propia: guardar sin asignar ────────────────────────────────────────
// Inmobiliaria es "lo que tiene ficha". Una propiedad entra ahí de dos formas sin
// pasar por un cliente: guardando un anuncio de la Bolsa (se le crea su ficha) o
// dándola de alta a mano, que es una ficha sin anuncio detrás; el resto de sus datos
// se captura en su página.
document.getElementById('trayInmo').hidden = INMO;
document.getElementById('trayInmo').addEventListener('click', async () => {
  const lista = [...seleccion.values()];
  const res = await Promise.allSettled(lista.map(fichaDe));
  const ok = res.filter(r => r.status === 'fulfilled').length;
  toast(ok === lista.length
    ? `${ok} ${ok === 1 ? 'inmueble guardado' : 'inmuebles guardados'} en el Catálogo`
    : `${ok} de ${lista.length} guardados en el Catálogo. Los demás fallaron.`);
  seleccion.clear();
  render();
});
// Y lo contrario: sacar de Inmobiliaria. No hay deshacer —con la ficha se va lo que
// cuelga de ella—, así que la confirmación dice qué se pierde.
document.getElementById('trayQuitar').hidden = !INMO;
document.getElementById('trayQuitar').addEventListener('click', async () => {
  const lista = [...seleccion.values()];
  const propias = lista.filter(l => l.id.startsWith('pipeline:')).length;
  const cuantas = lista.length === 1 ? 'esta propiedad' : `estas ${lista.length} propiedades`;
  if (!confirm(`¿Eliminar ${cuantas} del Catálogo?\n\n`
    + 'Se borra su ficha con sus documentos, fotos subidas, fichas PDF y lo presentado a clientes. No se puede deshacer.\n\n'
    + (propias < lista.length ? 'Los anuncios de portal vuelven a la Bolsa. ' : '')
    + (propias ? `${propias === 1 ? 'La que se dio' : `Las ${propias} que se dieron`} de alta a mano se ${propias === 1 ? 'pierde' : 'pierden'} por completo.` : ''))) return;
  const res = await Promise.allSettled(lista.map(l => API.quitarDeInmobiliaria(l.id)));
  const ok = res.filter(r => r.status === 'fulfilled').length;
  toast(ok === lista.length
    ? `${ok} ${ok === 1 ? 'propiedad eliminada' : 'propiedades eliminadas'} del Catálogo`
    : `${ok} de ${lista.length} eliminadas del Catálogo. Las demás fallaron.`);
  seleccion.clear();
  render();
});
document.getElementById('nueva-prop').hidden = !INMO;
document.getElementById('nueva-prop').addEventListener('click', async () => {
  const titulo = prompt('Nombre de la propiedad:');
  if (!titulo?.trim()) return;
  try {
    const f = await API.post('/fichas', { titulo: titulo.trim() });
    location.href = `listing.html?id=${encodeURIComponent('pipeline:' + f.id)}`;
  } catch (err) { toast('No se pudo crear la propiedad: ' + err.message); }
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

// ── Buscar para un cliente ───────────────────────────────────────────────────
// `index.html?cliente=<id>` llega desde "Buscar inmuebles" en clientes.html: los
// criterios que se capturaron como píldoras en "Qué busca" se vuelven los filtros.
// Las llaves son las mismas que entiende /api/listings (ver cliente.criterios en
// schema.sql), así que aquí sólo se copian.
async function aplicarCliente(id) {
  const cs = await API.get('/clientes').catch(() => []);
  const c = cs.find(x => String(x.id) === String(id));
  if (!c) { toast('Ese cliente ya no existe'); return; }
  const cr = c.criterios ?? {};
  F.cliente = { id: c.id, nombre: c.nombre };
  F.tipos = (cr.tipos ?? []).filter(t => TIPOS_COM.includes(t));
  F.operacion = ['rent', 'sale'].includes(cr.operacion) ? cr.operacion : '';
  F.lugares = (cr.lugares ?? []).slice(0, MAX_LUGARES);
  for (const k of ['m2_min', 'm2_max', 'ppm_min', 'ppm_max', 'precio_min', 'precio_max'])
    F[k] = cr[k] ?? '';
  F.m2_de = '';
}
function quitarCriterios() {
  F.cliente = null; F.tipos = []; F.operacion = ''; F.lugares = [];
  for (const k of ['m2_min', 'm2_max', 'm2_de', 'ppm_min', 'ppm_max', 'precio_min', 'precio_max']) F[k] = '';
  history.replaceState(null, '', location.pathname);
}

// Aviso de inventario viejo. El cron carga una fuente por noche de lunes a viernes, así
// que cada una se refresca una vez por semana: pasados FRESCURA_DIAS sin carga, algo
// se rompió (del 2026-09-23 en adelante fue el proxy, y el tablero no lo decía).
const FRESCURA_DIAS = 9;
async function avisarFrescura() {
  const r = await API.get('/frescura').catch(() => null);
  if (!r) return;
  const dias = iso => iso ? Math.floor((Date.now() - new Date(iso)) / 86400000) : Infinity;
  const dia = iso => new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
  const viejas = r.fuentes.filter(f => dias(f.ultima_carga) > FRESCURA_DIAS);
  if (!viejas.length) return;
  const el = document.getElementById('frescura');
  if (viejas.length === r.fuentes.length) {
    const ult = r.fuentes.map(f => f.ultima_carga).filter(Boolean).sort().pop();
    el.innerHTML = ult
      ? `<b>El inventario no se actualiza desde el ${esc(dia(ult))}</b> (hace ${dias(ult)} días): ` +
        'algunos anuncios pueden ya no estar disponibles. Confirma con el portal antes de ofrecerlos.'
      : '<b>El inventario nunca se ha cargado.</b>';
  } else {
    el.innerHTML = '<b>Sin actualizar:</b> ' + viejas.map(f => f.ultima_carga
      ? `${esc(f.label)} (desde el ${esc(dia(f.ultima_carga))})` : `${esc(f.label)} (nunca)`).join(', ') +
      '. Sus anuncios pueden ya no estar disponibles.';
  }
  el.hidden = false;
}

API.me().then(async () => {
  document.getElementById('authBox').hidden = true;
  document.getElementById('userBox').hidden = false;
  zonas = await API.get('/zonas').catch(() => []);
  const url = new URLSearchParams(location.search);
  if (url.get('cliente')) await aplicarCliente(url.get('cliente'));
  // Inmobiliaria: los clientes hacen falta para el filtro y su resumen. Desde la ficha
  // de un cliente se llega con ?pcliente=<id> ("lo que ya le presentamos").
  if (INMO) {
    await Promise.all([cargarClientes(), cargarEquipo()]);
    if (url.get('pcliente')) F.pcliente = url.get('pcliente');
    if (url.get('asesor')) F.asesor = url.get('asesor');
  }
  // Se abre buscando en lo que el mapa enseña, si el mapa está a la vista. Con los
  // criterios de un cliente no: sus lugares mandan, y el mapa encuadra lo que salga.
  if (F.cliente) seguirMapa(false);
  else if (mapFollow.checked && inm.classList.contains('split') && Mapa.area()) buscarEnElMapa(Mapa.area(), CENTRO_NOMBRE);
  await render();
  if (!INMO) avisarFrescura();
}).catch(err => {
  // El 401 lo maneja api.js redirigiendo al login; aquí sólo quedan fallos reales.
  console.error(err);
  document.getElementById('grid').innerHTML =
    `<div class="empty"><h2>No se pudo cargar el inventario</h2><p>${esc(err.message)}</p></div>`;
});

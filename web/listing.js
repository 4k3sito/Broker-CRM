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

const ICON_EXTERNAL = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
const ICON_BUILDING = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 21V7l9-4 9 4v14"/><polyline points="9 22 9 12 15 12 15 22"/><path d="M3 7h18"/></svg>`;
const ICON_PIN = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;

let listing    = null;
let ficha      = null;
let clientes   = [];   // clientes del asesor (para el selector de "agregar al seguimiento")
let procesos   = [];   // procesos de ESTA ficha, con cliente embebido
let documentos = [];   // documentos de la propiedad (predial, planos…), colgados de la ficha
let currentUser = null;

const PROC_STATUS = ['presentado', 'aprobado', 'rechazado'];
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
const escAttr = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

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

// Ver app.js: "$700" en varios portales significa "$700 por m²". Se muestra el total
// y, en chico, el unitario del que salió.
function fmtPrice(monto, moneda, l) {
  if (monto == null) return null;
  const curr = moneda === 'MN' ? 'MXN' : (moneda ?? '');
  if (l?.porM2) {
    const unit = `$${monto.toLocaleString('es-MX')}/m²`;
    return l.precioTotal
      ? { n: Math.round(l.precioTotal).toLocaleString('es-MX'), curr, nota: unit }
      : { n: monto.toLocaleString('es-MX'), curr, nota: 'por m²', parcial: true };
  }
  return { n: monto.toLocaleString('es-MX'), curr };
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

function adaptListing(l) {
  return {
    id:        l.id,
    fuente:    l.source ?? 'desconocido',
    codigo:    l.external_id ?? null,
    titulo:    l.title ?? l.broker_name ?? null,
    direccion: parseLocation(l.location) ?? l.neighborhood ?? null,
    precio:    l.price_numeric ?? null,
    porM2:     l.price_is_per_m2 ?? false,
    alt:       l.operacion_alt
                 ? { monto: l.precio_alt, op: l.operacion_alt,
                     porM2: l.precio_alt_por_m2 ?? false, total: l.precio_alt_total }
                 : null,
    precioTotal: l.precio_total ?? null,
    moneda:    l.currency ?? 'MXN',
    fotos:     (l.images?.length ? l.images : (l.image ? [l.image] : [])),
    url:       l.url ?? null,
    whatsapp:  l.whatsapp ?? null,
    mapsUrl:   l.maps_url ?? null,
    status:    STATUS_FROM_API[l.status] ?? 'Nuevo',
    starred:   l.starred ?? false,
    notes:     l.notes ?? '',
    tipo:        l.property_type ?? null,
    size:        l.property_size_m2 ?? null,
    transaccion: TXN_FROM_API[l.transaction_type] ?? 'Renta',
    descripcion: l.description ?? null,
    features:    l.features ?? [],
    brokerName:  l.broker_name ?? null,
  };
}

function setState(patch) {
  Object.assign(listing, patch);
  API.put(`/listings/${encodeURIComponent(listing.id)}/estado`, {
    status:  STATUS_TO_API[listing.status] ?? listing.status,
    starred: listing.starred,
    notes:   listing.notes,
  }).catch(err => console.warn('No se pudo guardar el estado:', err.message));
}

// ── Ficha técnica (propiedad en seguimiento del asesor) ──────────────────────

async function loadFicha() {
  const fichas = await API.get(`/fichas?listing=${encodeURIComponent(listing.id)}`)
    .catch(err => { console.warn('Carga de ficha falló:', err.message); return []; });
  ficha = fichas[0] ?? null;
}

// Clientes del asesor + procesos de esta ficha (para la sección de seguimiento).
async function loadSeguimiento() {
  clientes = [];
  procesos = [];
  if (!ficha) return;
  const [cli, proc] = await Promise.all([
    API.get('/clientes').catch(() => []),
    API.get(`/procesos?ficha_id=${ficha.id}`).catch(() => []),
  ]);
  clientes = cli.sort((a, b) => a.nombre.localeCompare(b.nombre));
  // La API devuelve cliente_nombre plano; el render espera cliente.nombre.
  procesos = proc.map(p => ({ ...p, cliente: { nombre: p.cliente_nombre } }));
}

async function addProceso(clienteId) {
  if (!clienteId) return;
  try {
    await API.post('/procesos', { cliente_id: clienteId, ficha_id: ficha.id });
    await loadSeguimiento();
    render();
  } catch (err) {
    alert('No se pudo agregar al seguimiento: ' + err.message);
  }
}

function setProcesoStatus(procId, status) {
  const p = procesos.find(x => x.id === procId);
  if (p) p.status = status;
  API.patch(`/procesos/${procId}`, { status })
    .catch(err => console.warn('No se pudo guardar el proceso:', err.message));
}

async function removeProceso(procId) {
  try {
    await API.del(`/procesos/${procId}`);
    procesos = procesos.filter(p => p.id !== procId);
    render();
  } catch (err) {
    alert('No se pudo quitar del seguimiento: ' + err.message);
  }
}

function seguimientoHtml() {
  const enSeguimiento = new Set(procesos.map(p => p.cliente_id));
  const disponibles = clientes.filter(c => !enSeguimiento.has(c.id));
  const rows = procesos.map(p => {
    const opts = PROC_STATUS.map(s => `<option value="${s}"${s === p.status ? ' selected' : ''}>${cap(s)}</option>`).join('');
    return `<div class="proc-row" data-proc="${p.id}">
      <span class="proc-ficha">${escAttr(p.cliente?.nombre ?? '(cliente)')}</span>
      <select class="proc-status status-${p.status}" data-proc="${p.id}">${opts}</select>
      <button class="proc-del" data-proc="${p.id}" title="Quitar del seguimiento">&times;</button>
    </div>`;
  }).join('');

  let adder;
  if (!clientes.length) {
    adder = `<p class="ficha-hint">No tienes clientes. Créalos en <a href="clientes.html">Clientes</a> y regresa para agregarlos.</p>`;
  } else if (!disponibles.length) {
    adder = `<p class="ficha-hint">Todos tus clientes ya están en seguimiento de esta propiedad.</p>`;
  } else {
    adder = `<div class="proc-add">
      <select id="proc-add-select" class="ficha-in">
        <option value="">Agregar cliente al seguimiento&#8230;</option>
        ${disponibles.map(c => `<option value="${c.id}">${escAttr(c.nombre)}</option>`).join('')}
      </select>
      <button class="btn-csv" id="proc-add-btn">Agregar</button>
    </div>`;
  }

  return `<div class="detail-section">
    <h2>Clientes en seguimiento <span class="proc-count">${procesos.length}</span></h2>
    ${rows || '<p class="ficha-hint">Nadie en seguimiento de esta propiedad todavía.</p>'}
    ${adder}
  </div>`;
}

// ── Documentos de la propiedad (predial, planos… colgados de la ficha) ───────
async function loadDocumentos() {
  documentos = ficha
    ? await API.get(`/documentos?ficha_id=${ficha.id}`).catch(err => {
        console.warn('Carga de documentos falló:', err.message);
        return [];
      })
    : [];
}

async function addDocumento(label) {
  label = (label ?? '').trim();
  if (!label) return;
  try {
    documentos.push(await API.post('/documentos', { ficha_id: ficha.id, label }));
    render();
  } catch (err) {
    alert('No se pudo agregar el documento: ' + err.message);
  }
}

function toggleDocumento(id, done) {
  const d = documentos.find(x => x.id === id);
  if (d) d.done = done;
  API.patch(`/documentos/${id}`, { done })
    .catch(err => console.warn('No se pudo guardar el documento:', err.message));
  render();
}

async function removeDocumento(id) {
  try {
    await API.del(`/documentos/${id}`);
    documentos = documentos.filter(x => x.id !== id);
    render();
  } catch (err) {
    alert('No se pudo quitar el documento: ' + err.message);
  }
}

function documentosHtml() {
  const done = documentos.filter(d => d.done).length;
  const rows = documentos.map(d => `<div class="tarea ${d.done ? 'done' : ''}">
    <label><input type="checkbox" class="doc-chk" data-id="${d.id}"${d.done ? ' checked' : ''}>
      <span>${escAttr(d.label)}</span></label>
    <button class="tarea-del doc-del" data-id="${d.id}" title="Quitar documento">&times;</button>
  </div>`).join('');
  return `<div class="detail-section">
    <h2>Documentos de la propiedad <span class="proc-count">${done}/${documentos.length}</span></h2>
    <div class="proc-tasks">
      ${rows || '<p class="ficha-hint">Sin documentos. Agrega los que necesites (predial, planos, escrituras&#8230;).</p>'}
      <div class="tarea-add">
        <input class="ficha-in doc-input" placeholder="Documento (ej. Predial, Planos, Escrituras&#8230;)">
        <button class="btn-pdf doc-add">&#43;</button>
      </div>
    </div>
  </div>`;
}

async function createFicha() {
  try {
    ficha = await API.post('/fichas', {
      source_listing_id: listing.id,
      titulo:            listing.titulo,
      precio:            listing.precio,
      moneda:            listing.moneda,
      tamano_m2:         listing.size,
      fotos:             listing.fotos,
    });
    await Promise.all([loadSeguimiento(), loadDocumentos()]);
    render();
  } catch (err) {
    alert('No se pudo crear la ficha: ' + err.message);
  }
}

// Autosave por campo (mismo patrón que las notas). precio/tamaño → número o null.
function saveFicha(field, value) {
  if (!ficha) return;
  const val = (field === 'precio' || field === 'tamano_m2')
    ? (value === '' ? null : Number(value)) : value;
  ficha[field] = val;
  API.patch(`/fichas/${ficha.id}`, { [field]: val })
    .catch(err => console.warn('No se pudo guardar la ficha:', err.message));
}

// Hoja imprimible → "Guardar como PDF" desde el diálogo del navegador.
// ponytail: window.print() nativo en vez de jsPDF/html2canvas.
function printFicha() {
  const f = ficha;
  const p = fmtPrice(f.precio, f.moneda);
  const ppm = (f.precio && f.tamano_m2) ? `$${Math.round(f.precio / f.tamano_m2).toLocaleString('es-MX')}` : null;
  const fotos = (f.fotos ?? []).slice(0, 6);
  document.getElementById('ficha-print').innerHTML = `
    <div class="print-sheet">
      <div class="print-head">
        <div class="print-brand">Office<i>Lab</i></div>
        <div class="print-tag">Ficha t&#233;cnica</div>
      </div>
      <h1>${escAttr(f.titulo || 'Propiedad')}</h1>
      ${listing.direccion ? `<div class="print-loc">${escAttr(listing.direccion)}</div>` : ''}
      <div class="print-facts">
        <div><span>Precio</span><strong>${p ? '$' + p.n + ' ' + p.curr : 'Sin precio'}</strong></div>
        ${f.tamano_m2 ? `<div><span>Tama&#241;o</span><strong>${f.tamano_m2} m&#178;</strong></div>` : ''}
        ${ppm ? `<div><span>Precio / m&#178;</span><strong>${ppm}</strong></div>` : ''}
      </div>
      ${fotos.length ? `<div class="print-fotos">${fotos.map(u => `<img src="${escAttr(u)}" alt="">`).join('')}</div>` : ''}
      ${f.notas ? `<div class="print-notes"><h2>Notas</h2><p>${escAttr(f.notas)}</p></div>` : ''}
    </div>`;
  window.print();
}

function fichaSectionHtml() {
  if (!currentUser) {
    return `<div class="detail-section"><h2>Ficha t&#233;cnica</h2>
      <p class="ficha-hint">Inicia sesi&#243;n para crear tu ficha t&#233;cnica de esta propiedad.</p></div>`;
  }
  if (!ficha) {
    return `<div class="detail-section"><h2>Ficha t&#233;cnica</h2>
      <button class="btn-csv" id="ficha-create">&#43; Crear ficha t&#233;cnica</button></div>`;
  }
  const fotos = ficha.fotos ?? [];
  return `<div class="detail-section">
    <div class="ficha-head">
      <h2>Ficha t&#233;cnica <span class="ficha-badge">en seguimiento</span></h2>
      <button class="btn-pdf" id="ficha-pdf" title="Descargar como PDF">&#8595; PDF</button>
    </div>
    <div class="ficha-form">
      <label class="ficha-field">T&#237;tulo<input class="ficha-in" data-f="titulo" value="${escAttr(ficha.titulo)}"></label>
      <div class="ficha-row">
        <label class="ficha-field">Precio<input type="number" class="ficha-in" data-f="precio" value="${ficha.precio ?? ''}"></label>
        <label class="ficha-field">Tama&#241;o (m&#178;)<input type="number" class="ficha-in" data-f="tamano_m2" value="${ficha.tamano_m2 ?? ''}"></label>
      </div>
      <label class="ficha-field">Notas<textarea class="ficha-in notes-area" data-f="notas" placeholder="Notas de la ficha&#8230;">${escAttr(ficha.notas)}</textarea></label>
      ${fotos.length ? `<div class="ficha-fotos">${fotos.map(f => `<img src="${escAttr(f)}" alt="foto">`).join('')}</div>` : ''}
    </div>
  </div>`;
}

function selectPhoto(idx) {
  const main = document.getElementById('mainPhoto');
  if (main) main.src = listing.fotos[idx];
  document.querySelectorAll('.thumb').forEach((t, i) => t.classList.toggle('active', i === idx));
}

function render() {
  const l      = listing;
  const cfg    = FUENTE_CONFIG[l.fuente];
  const badge  = cfg?.badge  ?? 'other';
  const blabel = (cfg?.label ?? l.fuente).toUpperCase();
  const p      = fmtPrice(l.precio, l.moneda, l);

  // Galería del canvas: foto de 380px sobre tinta, con los badges encima y una
  // fila de miniaturas debajo. Sin foto queda la trama de plano, nunca un gris.
  const galleryHtml = `
    <div class="detail-photo${l.fotos.length ? '' : ' detail-photo-empty'}">
      ${l.fotos.length ? `<img id="mainPhoto" src="${l.fotos[0]}" alt="">` : ICON_BUILDING}
      <span class="badge-src ${badge}">${blabel}</span>
      ${l.size ? `<span class="badge-size">${Math.round(l.size).toLocaleString('es-MX')} M²</span>` : ''}
    </div>
    ${l.fotos.length > 1 ? `<div class="detail-thumbs">${l.fotos.slice(0, 4).map((f, i) =>
      `<button class="thumb ${i === 0 ? 'active' : ''}" data-i="${i}"><img src="${f}" alt=""></button>`).join('')}</div>` : ''}`;

  const sufijo = l.transaccion === 'Renta' ? 'MXN / mes' : 'MXN';
  const priceHtml = p
    ? `<div class="detail-price">$${p.n}<span class="currency">${sufijo}</span></div>` +
      (p.nota ? `<div class="card-ppm">${p.nota}${p.parcial ? '' : ' × ' + l.size + ' m²'}</div>` : '') +
      altPriceHtml(l.alt)
    : `<div class="detail-price"><span class="no-price">Sin precio</span></div>`;

  // Si el precio ya viene por m², repetir el unitario aquí sería decirlo dos veces.
  const ppmHtml = (!l.porM2 && l.precio && l.size)
    ? `<div class="card-ppm">$${Math.round(l.precio / l.size).toLocaleString('es-MX')} / M²</div>` : '';

  const statusOptions = STATUSES.map(st =>
    `<option value="${st}"${st === l.status ? ' selected' : ''}>${st}</option>`).join('');

  // Ficha técnica: el canvas la quiere como cifras en Bodoni, no como lista de pares.
  const facts = [
    l.size ? ['Superficie', `${l.size} m²`] : null,
    l.tipo ? ['Tipo', l.tipo] : null,
    l.transaccion ? ['Operación', l.transaccion] : null,
    l.codigo ? ['Código', l.codigo] : null,
  ].filter(Boolean);
  const factsHtml = facts.length
    ? `<div class="detail-panel">
         <div class="detail-panel-label">Ficha técnica</div>
         <dl class="detail-facts">${facts.map(([label, value]) =>
           `<div><dt>${label}</dt><dd>${escAttr(String(value))}</dd></div>`).join('')}</dl>
       </div>`
    : '';

  document.title = (l.titulo ?? 'Propiedad') + ' · OfficeLab';

  document.getElementById('detail').innerHTML = `
    <article class="detail-content">
      <nav class="detail-crumb" aria-label="Ruta">
        <a href="index.html">Propiedades</a><span>/</span><strong>${escAttr(l.codigo ?? l.id)}</strong>
      </nav>
      <div class="detail-gallery">${galleryHtml}</div>
      <div class="detail-heading">
        <div class="card-tags">
          ${l.tipo ? `<span class="tag-tipo">${l.tipo}</span>` : ''}
          <span class="tag-txn">${l.transaccion}</span>
          ${l.codigo ? `<span class="tag-code">${l.codigo}</span>` : ''}
        </div>
        ${l.titulo ? `<h1 class="detail-title">${l.titulo}</h1>` : ''}
        ${l.direccion ? `<div class="detail-location">${ICON_PIN}${l.direccion}</div>` : ''}
      </div>
      ${factsHtml}
      ${l.descripcion ? `<div class="detail-panel"><div class="detail-panel-label">Descripción</div><p>${l.descripcion}</p></div>` : ''}
      ${l.features.length ? `<div class="detail-panel"><div class="detail-panel-label">Características</div><ul class="detail-features">${l.features.map(f => `<li>${f}</li>`).join('')}</ul></div>` : ''}
      ${fichaSectionHtml()}
      ${ficha ? documentosHtml() : ''}
      ${ficha ? seguimientoHtml() : ''}
    </article>
    <aside class="detail-sidebar">
      <div class="detail-sidebar-card">
        ${priceHtml}
        ${ppmHtml}
        <div class="detail-sidebar-divider"></div>
        <div class="card-status-row">
          <span class="status-dot" style="background:var(--s-${l.status.toLowerCase()})"></span>
          <select class="status-select s-${l.status}" id="detailStatus">${statusOptions}</select>
        </div>
        <button class="btn-star-wide ${l.starred ? 'on' : ''}" id="detailStar">
          ${l.starred ? '&#9733; Destacado' : '&#9734; Marcar destacado'}
        </button>
        <div class="detail-links">
          ${l.url      ? `<a href="${l.url}" class="btn-solid" target="_blank" rel="noopener">Anuncio original ${ICON_EXTERNAL}</a>` : ''}
          ${l.whatsapp ? `<a href="https://wa.me/${l.whatsapp.replace(/\D/g,'')}" class="btn-outline" target="_blank" rel="noopener">WhatsApp ${ICON_EXTERNAL}</a>` : ''}
        </div>
      </div>
      <div class="detail-sidebar-card">
        <div class="detail-panel-label">Notas internas</div>
        <textarea class="notes-area" id="detailNotes" placeholder="AGREGAR NOTAS DE SEGUIMIENTO…">${l.notes}</textarea>
      </div>
    </aside>
  `;

  document.querySelectorAll('.thumb').forEach(t => t.addEventListener('click', () => selectPhoto(+t.dataset.i)));

  document.getElementById('detailStar').addEventListener('click', () => {
    setState({ starred: !listing.starred });
    render();
  });
  document.getElementById('detailStatus').addEventListener('change', e => setState({ status: e.target.value }));
  document.getElementById('detailNotes').addEventListener('blur', e => setState({ notes: e.target.value }));

  document.getElementById('ficha-create')?.addEventListener('click', createFicha);
  document.getElementById('ficha-pdf')?.addEventListener('click', printFicha);
  document.querySelectorAll('.ficha-in').forEach(el =>
    el.addEventListener('blur', e => saveFicha(e.target.dataset.f, e.target.value)));

  document.querySelector('.doc-add')?.addEventListener('click', () =>
    addDocumento(document.querySelector('.doc-input').value));
  document.querySelector('.doc-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') addDocumento(e.target.value);
  });
  document.querySelectorAll('.doc-chk').forEach(chk =>
    chk.addEventListener('change', e => toggleDocumento(e.target.dataset.id, e.target.checked)));
  document.querySelectorAll('.doc-del').forEach(b =>
    b.addEventListener('click', e => removeDocumento(e.currentTarget.dataset.id)));

  document.getElementById('proc-add-btn')?.addEventListener('click', () =>
    addProceso(document.getElementById('proc-add-select').value));
  document.querySelectorAll('.proc-status').forEach(sel =>
    sel.addEventListener('change', e => {
      setProcesoStatus(e.target.dataset.proc, e.target.value);
      e.target.className = 'proc-status status-' + e.target.value;
    }));
  document.querySelectorAll('.proc-del').forEach(btn =>
    btn.addEventListener('click', e => removeProceso(e.currentTarget.dataset.proc)));
}

// ── Auth ─────────────────────────────────────────────────────────────────────

document.getElementById('logout-btn').addEventListener('click', async () => {
  await API.logout().catch(() => {});
  location.replace('login.html');
});

// ── Init ─────────────────────────────────────────────────────────────────────

const id = new URLSearchParams(location.search).get('id');

API.me()
  .then(async user => {
    currentUser = user;
    document.getElementById('authBox').hidden = true;
    document.getElementById('userBox').hidden = false;
    document.getElementById('userEmail').textContent = user.email;

    if (!id) {
      document.getElementById('detail').innerHTML =
        `<p class="empty">Falta el identificador de la propiedad.</p>`;
      return;
    }

    // El detalle ya trae el estado del usuario (status/starred/notes) resuelto.
    listing = adaptListing(await API.get(`/listings/${encodeURIComponent(id)}`));
    await loadFicha();
    await Promise.all([loadSeguimiento(), loadDocumentos()]);
    render();
  })
  .catch(err => {
    console.error(err);
    document.getElementById('detail').innerHTML =
      `<p class="empty">No se pudo cargar esta propiedad.<br>${err.message}</p>`;
  });

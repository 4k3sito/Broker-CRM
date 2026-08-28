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

const ICON_EXTERNAL = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
const ICON_BUILDING = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 21V7l9-4 9 4v14"/><polyline points="9 22 9 12 15 12 15 22"/><path d="M3 7h18"/></svg>`;
const ICON_PIN = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;

let listing    = null;
let ficha      = null;
let clientes   = [];   // clientes del asesor (para el selector de "agregar al seguimiento")
let procesos   = [];   // procesos de ESTA ficha, con cliente embebido
let documentos = [];   // documentos de la propiedad (predial, planos…), colgados de la ficha
let currentUser = null;
let authResolved = false;

const PROC_STATUS = ['presentado', 'aprobado', 'rechazado'];
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
const escAttr = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function redirectToLogin() {
  window.location.replace('login.html');
}

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

function fmtPrice(monto, moneda) {
  if (monto == null) return null;
  const n = monto.toLocaleString('es-MX');
  const curr = moneda === 'MN' ? 'MXN' : (moneda ?? '');
  return { n, curr };
}

function adaptListing(l) {
  return {
    id:        l.id,
    fuente:    l.source ?? 'desconocido',
    codigo:    l.external_id ?? null,
    titulo:    l.title ?? l.broker_name ?? null,
    direccion: parseLocation(l.location) ?? l.neighborhood ?? null,
    precio:    l.price_numeric ?? null,
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
  if (!currentUser) { alert('Inicia sesión para guardar notas y favoritos.'); return; }
  Object.assign(listing, patch);
  db.from('user_listing').upsert({
    user_id:    currentUser.id,
    listing_id: listing.id,
    status:     STATUS_TO_API[listing.status] ?? listing.status,
    starred:    listing.starred,
    notes:      listing.notes,
    updated_at: new Date().toISOString(),
  }).then(({ error }) => { if (error) console.warn('Update failed:', error.message); });
}

// ── Ficha técnica (propiedad en seguimiento del asesor) ──────────────────────

async function loadFicha() {
  ficha = null;
  if (!currentUser) return;
  const { data, error } = await db.from('ficha').select('*')
    .eq('source_listing_id', listing.id).maybeSingle();
  if (error) { console.warn('Carga de ficha falló:', error.message); return; }
  ficha = data;
}

// Clientes del asesor + procesos de esta ficha (para la sección de seguimiento).
async function loadSeguimiento() {
  clientes = [];
  procesos = [];
  if (!currentUser || !ficha) return;
  const [cli, proc] = await Promise.all([
    db.from('cliente').select('id, nombre').order('nombre'),
    db.from('proceso').select('id, status, cliente_id, cliente(nombre)').eq('ficha_id', ficha.id),
  ]);
  if (cli.error)  console.warn('Carga de clientes falló:', cli.error.message);   else clientes = cli.data ?? [];
  if (proc.error) console.warn('Carga de procesos falló:', proc.error.message);  else procesos = proc.data ?? [];
}

async function addProceso(clienteId) {
  if (!clienteId) return;
  const { error } = await db.from('proceso')
    .insert({ user_id: currentUser.id, cliente_id: clienteId, ficha_id: ficha.id });
  if (error) { alert('No se pudo agregar al seguimiento: ' + error.message); return; }
  await loadSeguimiento();
  render();
}

function setProcesoStatus(procId, status) {
  const p = procesos.find(x => x.id === procId);
  if (p) p.status = status;
  db.from('proceso').update({ status, updated_at: new Date().toISOString() })
    .eq('id', procId).then(({ error }) => { if (error) console.warn('Proceso update failed:', error.message); });
}

async function removeProceso(procId) {
  const { error } = await db.from('proceso').delete().eq('id', procId);
  if (error) { alert('No se pudo quitar del seguimiento: ' + error.message); return; }
  procesos = procesos.filter(p => p.id !== procId);
  render();
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
  documentos = [];
  if (!currentUser || !ficha) return;
  const { data, error } = await db.from('ficha_documento').select('*')
    .eq('ficha_id', ficha.id).order('created_at');
  if (error) { console.warn('Carga de documentos falló:', error.message); return; }
  documentos = data ?? [];
}

async function addDocumento(label) {
  label = (label ?? '').trim();
  if (!label) return;
  const { data, error } = await db.from('ficha_documento')
    .insert({ user_id: currentUser.id, ficha_id: ficha.id, label }).select().single();
  if (error) { alert('No se pudo agregar el documento: ' + error.message); return; }
  documentos.push(data);
  render();
}

function toggleDocumento(id, done) {
  const d = documentos.find(x => x.id === id);
  if (d) d.done = done;
  db.from('ficha_documento').update({ done }).eq('id', id)
    .then(({ error }) => { if (error) console.warn('Documento update failed:', error.message); });
  render();
}

async function removeDocumento(id) {
  const { error } = await db.from('ficha_documento').delete().eq('id', id);
  if (error) { alert('No se pudo quitar el documento: ' + error.message); return; }
  documentos = documentos.filter(x => x.id !== id);
  render();
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
  const { data, error } = await db.from('ficha').insert({
    user_id:           currentUser.id,
    source_listing_id: listing.id,
    titulo:            listing.titulo,
    precio:            listing.precio,
    moneda:            listing.moneda,
    tamano_m2:         listing.size,
    fotos:             listing.fotos,
  }).select().single();
  if (error) { alert('No se pudo crear la ficha: ' + error.message); return; }
  ficha = data;
  await Promise.all([loadSeguimiento(), loadDocumentos()]);
  render();
}

// Autosave por campo (mismo patrón que las notas). precio/tamaño → número o null.
function saveFicha(field, value) {
  if (!ficha) return;
  const val = (field === 'precio' || field === 'tamano_m2')
    ? (value === '' ? null : Number(value)) : value;
  ficha[field] = val;
  db.from('ficha').update({ [field]: val, updated_at: new Date().toISOString() })
    .eq('id', ficha.id)
    .then(({ error }) => { if (error) console.warn('Ficha update failed:', error.message); });
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
        <div class="print-brand">Office<span>Scrapper</span></div>
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
  const p      = fmtPrice(l.precio, l.moneda);
  const ppm    = (l.precio && l.size) ? `$${Math.round(l.precio / l.size).toLocaleString('es-MX')} / m²` : '';

  const galleryHtml = l.fotos.length
    ? `<div class="detail-photo"><img id="mainPhoto" src="${l.fotos[0]}" alt="foto"></div>
       ${l.fotos.length > 1 ? `<div class="detail-thumbs">${l.fotos.map((f, i) =>
          `<img class="thumb ${i === 0 ? 'active' : ''}" src="${f}" data-i="${i}">`).join('')}</div>` : ''}`
    : `<div class="detail-photo detail-photo-empty">${ICON_BUILDING}</div>`;

  const priceHtml = p
    ? `<div class="detail-price">$${p.n}<span class="currency">${p.curr}/mes</span></div>`
    : `<div class="detail-price"><span class="no-price">Sin precio</span></div>`;

  const statusOptions = STATUSES.map(st =>
    `<option value="${st}"${st === l.status ? ' selected' : ''}>${st}</option>`).join('');
  const facts = [
    l.size ? ['Superficie', `${l.size} m²`] : null,
    l.tipo ? ['Tipo', l.tipo] : null,
    l.transaccion ? ['Operación', l.transaccion] : null,
    l.codigo ? ['Código', l.codigo] : null,
  ].filter(Boolean);
  const factsHtml = facts.length ? `<dl class="detail-facts">${facts.map(([label, value]) =>
    `<div><dt>${label}</dt><dd>${escAttr(String(value))}</dd></div>`).join('')}</dl>` : '';

  document.title = (l.titulo ?? 'Propiedad') + ' · OfficeScrapper';

  document.getElementById('detail').innerHTML = `
    <article class="detail-content">
      <div class="detail-gallery">${galleryHtml}</div>
      <div class="detail-heading">
        <span class="badge-src ${badge} detail-source">${blabel}</span>
        <p class="detail-kicker">Ficha de propiedad</p>
        ${l.titulo ? `<h1 class="detail-title">${l.titulo}</h1>` : ''}
        ${l.direccion ? `<div class="card-location detail-location">${ICON_PIN}${l.direccion}</div>` : ''}
        <div class="card-tags">
          ${l.tipo ? `<span class="tag-tipo">${l.tipo}</span>` : ''}
          <span class="tag-txn">${l.transaccion}</span>
          ${l.codigo ? `<span class="tag-code">${l.codigo}</span>` : ''}
        </div>
      </div>
      ${factsHtml}
      ${l.descripcion ? `<div class="detail-section"><h2>Descripción</h2><p>${l.descripcion}</p></div>` : ''}
      ${l.features.length ? `<div class="detail-section"><h2>Características</h2><ul class="detail-features">${l.features.map(f => `<li>${f}</li>`).join('')}</ul></div>` : ''}
      ${fichaSectionHtml()}
      ${ficha ? documentosHtml() : ''}
      ${ficha ? seguimientoHtml() : ''}
    </article>
    <aside class="detail-sidebar">
      <div class="detail-sidebar-card">
        <div class="detail-sidebar-head">
          <span class="detail-sidebar-label">Renta mensual</span>
          <button class="btn-star ${l.starred ? 'on' : 'off'}" id="detailStar" title="${l.starred ? 'Quitar destacado' : 'Destacar'}">
            ${l.starred ? '&#9733;' : '&#9734;'}
          </button>
        </div>
        ${priceHtml}
        ${ppm ? `<div class="card-ppm">${ppm}</div>` : ''}
        <div class="detail-links">
          ${l.url      ? `<a href="${l.url}" class="btn-outline" target="_blank" rel="noopener">Ver en ${blabel} ${ICON_EXTERNAL}</a>` : ''}
          ${l.whatsapp ? `<a href="https://wa.me/${l.whatsapp.replace(/\D/g,'')}" class="btn-csv" target="_blank" rel="noopener">WhatsApp ${ICON_EXTERNAL}</a>` : ''}
          ${l.mapsUrl  ? `<a href="${l.mapsUrl}" class="btn-outline" target="_blank" rel="noopener">Ver mapa ${ICON_EXTERNAL}</a>` : ''}
        </div>
        <div class="detail-sidebar-divider"></div>
        <section class="detail-tracking" aria-labelledby="tracking-title">
          <h2 id="tracking-title">Seguimiento</h2>
          <div class="card-status-row">
            <span class="status-dot" style="background:var(--s-${l.status.toLowerCase()})"></span>
            <select class="status-select s-${l.status}" id="detailStatus">${statusOptions}</select>
          </div>
          <textarea class="notes-area" id="detailNotes" placeholder="Agregar notas de seguimiento…">${l.notes}</textarea>
        </section>
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

document.getElementById('logout-btn').addEventListener('click', () => db.auth.signOut());

db.auth.onAuthStateChange((_event, session) => {
  currentUser = session?.user ?? null;
  document.getElementById('authBox').hidden = !!currentUser;
  document.getElementById('userBox').hidden = !currentUser;
  if (currentUser) document.getElementById('userEmail').textContent = currentUser.email;
  if (!currentUser && authResolved) {
    redirectToLogin();
    return;
  }
  // ponytail: setTimeout libera el lock de auth (mismo gotcha que app.js).
  if (listing) setTimeout(async () => {
    await Promise.all([loadUserState(), loadFicha()]);
    await Promise.all([loadSeguimiento(), loadDocumentos()]);
    render();
  }, 0);
});

async function loadUserState() {
  if (!listing) return;
  listing.status = 'Nuevo'; listing.starred = false; listing.notes = '';
  if (!currentUser) return;
  const { data, error } = await db.from('user_listing')
    .select('status,starred,notes').eq('user_id', currentUser.id).eq('listing_id', listing.id).maybeSingle();
  if (error) { console.warn('Carga de estado falló:', error.message); return; }
  if (data) {
    listing.status  = STATUS_FROM_API[data.status] ?? 'Nuevo';
    listing.starred = data.starred ?? false;
    listing.notes   = data.notes ?? '';
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

const id = new URLSearchParams(location.search).get('id');

db.auth.getSession()
  .then(async ({ data: sessionData, error: sessionError }) => {
    if (sessionError) throw new Error(sessionError.message);
    authResolved = true;
    currentUser = sessionData.session?.user ?? null;
    if (!currentUser) {
      redirectToLogin();
      return;
    }

    if (!id) {
      document.getElementById('detail').innerHTML = `<p class="empty">Falta el identificador de la propiedad.</p>`;
      return;
    }

    const { data, error } = await db.from('listings').select('*').eq('id', id).single();
    if (error) throw new Error(error.message);
    listing = adaptListing(data);
    await Promise.all([loadUserState(), loadFicha()]);
    await Promise.all([loadSeguimiento(), loadDocumentos()]);
    render();
  })
  .catch(err => {
    console.error(err);
    document.getElementById('detail').innerHTML = `<p class="empty">No se pudo cargar esta propiedad.<br>Revisa la consola para m&#225;s detalles.</p>`;
  });

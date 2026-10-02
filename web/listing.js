// Ficha de propiedad (diseño 1b): mosaico de fotos a lo ancho, banda de decisión
// (precio, estado, destacado, contacto) y tres columnas sin scroll largo:
// Ficha · Documentos · Clientes + notas. Anterior/siguiente recorre la página del
// tablero de la que se vino (el tablero guarda los ids en sessionStorage).

const STATUSES = ['Nuevo', 'Revisado', 'Contactado', 'Rentado', 'Descartado'];
const STATUS_FROM_API = { new: 'Nuevo', reviewed: 'Revisado', contacted: 'Contactado', rented: 'Rentado', discarded: 'Descartado' };
const STATUS_TO_API   = { Nuevo: 'new', Revisado: 'reviewed', Contactado: 'contacted', Rentado: 'rented', Descartado: 'discarded' };
const FUENTE_CONFIG = {
  easybroker: 'EasyBroker', inmuebles24: 'Inmuebles24', lamudi: 'Lamudi', vivanuncios: 'Vivanuncios',
  metroscubicos: 'Metros²', mercadolibre: 'MercadoLibre', propiedadesmexico: 'PropiedadesMX',
  propiedadesmx: 'PropiedadesMX', pincali: 'Pincali', pipeline: 'Pipeline',
};
// "Volver" regresa a la pestaña de la que se vino (Bolsa o Inmobiliaria).
const TABLERO = (() => { try { return sessionStorage.getItem('ol-tab') === 'inmobiliaria' ? 'index.html?tab=inmobiliaria' : 'index.html'; } catch { return 'index.html'; } })();
const TXN_FROM_API = { rent: 'Renta', rental: 'Renta', sale: 'Venta' };
// Las etapas de un proceso vienen de etapas.js (compartido con tareas y clientes);
// `esc` y `hrefSeguro`, de texto.js.

const ICON_EXTERNAL = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;

let listing = null, ficha = null, clientes = [], procesos = [], documentos = [], currentUser = null;
// Las fichas PDF guardadas de esta propiedad (ficha_version). `versionSel` es la que
// está cargada en el formulario y la que imprime "Ficha PDF"; null es la General.
let versiones = [], versionSel = null, pdfAbierto = false;

const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
const mx = n => Number(n).toLocaleString('es-MX');
const num = v => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n; };

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
    id: l.id, fuente: l.source ?? 'desconocido', codigo: l.source === 'pipeline' ? null : (l.external_id ?? null),
    titulo: l.title ?? l.broker_name ?? null,
    direccion: parseLocation(l.location) ?? l.neighborhood ?? null,
    precio: l.price_numeric ?? null, porM2: l.price_is_per_m2 ?? false, precioTotal: l.precio_total ?? null,
    alt: l.operacion_alt ? { monto: l.precio_alt, op: l.operacion_alt, porM2: l.precio_alt_por_m2 ?? false, total: l.precio_alt_total } : null,
    moneda: l.currency ?? 'MXN',
    fotos: (l.images?.length ? l.images : (l.image ? [l.image] : [])),
    url: l.url ?? null, whatsapp: l.whatsapp ?? null, mapsUrl: l.maps_url ?? null,
    status: STATUS_FROM_API[l.status] ?? 'Nuevo', starred: l.starred ?? false, notes: l.notes ?? '',
    tipo: l.property_type ?? null, size: l.property_size_m2 ?? null,
    // Las fichas del sheet no dicen si es renta o venta: sin operación, no "Renta".
    transaccion: TXN_FROM_API[l.transaction_type] ?? (l.source === 'pipeline' ? null : 'Renta'),
    descripcion: l.description ?? null, features: l.features ?? [], zona: l.zona ?? null,
    lat: num(l.lat ?? l.latitude ?? l.geo?.lat), lng: num(l.lng ?? l.lon ?? l.longitude ?? l.geo?.lng),
    geoOrigen: l.geo_origen ?? null,
  };
}

// Precio total real: si el portal publicó $/m², se usa el total calculado.
const precioTotal = l => l.porM2 ? l.precioTotal : l.precio;
const ppm = l => { const t = precioTotal(l); return t && l.size ? t / l.size : (l.porM2 ? l.precio : null); };
// Un inmueble puede ofrecerse en renta Y venta: el segundo precio va en línea aparte.
function altPriceHtml(alt) {
  if (!alt?.op) return '';
  const etiqueta = alt.op === 'rent' ? 'También en renta' : 'También en venta';
  // Se sabe que se ofrece en las dos, pero el precio aún no se ha rescatado.
  if (alt.monto == null) return `<span class="price-alt">${etiqueta}</span>`;
  const monto = alt.porM2 && alt.total ? alt.total : alt.monto;
  const unidad = alt.porM2 && alt.total ? '' : (alt.porM2 ? '/m²' : '');
  const sufijo = alt.op === 'rent' ? '/mes' : '';
  return `<span class="price-alt">${etiqueta}: <strong>$${mx(Math.round(monto))}${unidad}${sufijo}</strong></span>`;
}
const mapsLink = l => l.mapsUrl ?? (l.lat != null ? `https://maps.google.com/?q=${l.lat},${l.lng}` : null);
// Una propiedad dada de alta a mano (o venida del sheet): no hay anuncio detrás, la
// ficha ES la propiedad y sus datos se editan aquí.
const esPropia = l => l.fuente === 'pipeline';
// Avatar de quien lleva la cuenta: mismas fórmulas que tareas.js y clientes.js, para
// que cada persona tenga el mismo color en las tres páginas.
const iniciales = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const tono = id => `var(--tono-${[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % 7})`;
const fechaCorta = iso => iso ? new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }) : '';

// ── Estado del usuario ───────────────────────────────────────────────────────
function setState(patch) {
  Object.assign(listing, patch);
  API.put(`/listings/${encodeURIComponent(listing.id)}/estado`, {
    status: STATUS_TO_API[listing.status] ?? listing.status, starred: listing.starred, notes: listing.notes,
  }).catch(err => console.warn('No se pudo guardar el estado:', err.message));
}

// ── Ficha, seguimiento y documentos ──────────────────────────────────────────
async function loadFicha() {
  const fs = await API.get(`/fichas?listing=${encodeURIComponent(listing.id)}`).catch(() => []);
  ficha = fs[0] ?? null;
  versiones = ficha ? await API.get(`/fichas/${ficha.id}/versiones`).catch(() => []) : [];
}
async function loadSeguimiento() {
  clientes = (await API.get('/clientes').catch(() => [])).sort((a, b) => a.nombre.localeCompare(b.nombre));
  procesos = ficha ? (await API.get(`/procesos?ficha_id=${ficha.id}`).catch(() => []))
    .map(p => ({ ...p, cliente: { nombre: p.cliente_nombre } })) : [];
}
async function loadDocumentos() {
  documentos = ficha ? await API.get(`/documentos?ficha_id=${ficha.id}`).catch(() => []) : [];
}
// Documentos y clientes cuelgan de la ficha: se crea sola la primera vez que hace falta.
async function asegurarFicha() {
  if (ficha) return ficha;
  ficha = await API.post('/fichas', {
    source_listing_id: listing.id, titulo: listing.titulo, precio: precioTotal(listing),
    moneda: listing.moneda, tamano_m2: listing.size, fotos: listing.fotos,
  });
  return ficha;
}
async function addProceso(clienteId) {
  if (!clienteId) return;
  try {
    await asegurarFicha();
    await API.post('/procesos', { cliente_id: clienteId, ficha_id: ficha.id });
    await loadSeguimiento(); render();
  } catch (err) { alert('No se pudo asignar: ' + err.message); }
}
function setProcesoStatus(id, status) {
  const p = procesos.find(x => String(x.id) === String(id));
  if (p) p.status = status;
  API.patch(`/procesos/${id}`, { status }).catch(err => console.warn(err.message));
}
async function removeProceso(id) {
  try { await API.del(`/procesos/${id}`); procesos = procesos.filter(p => String(p.id) !== String(id)); render(); }
  catch (err) { alert('No se pudo quitar: ' + err.message); }
}
async function addDocumento(label) {
  label = (label ?? '').trim();
  if (!label) return;
  try { await asegurarFicha(); documentos.push(await API.post('/documentos', { ficha_id: ficha.id, label })); render(); }
  catch (err) { alert('No se pudo agregar el documento: ' + err.message); }
}
function toggleDocumento(id, done) {
  const d = documentos.find(x => String(x.id) === String(id));
  if (d) d.done = done;
  API.patch(`/documentos/${id}`, { done }).catch(err => console.warn(err.message));
  render();
}
async function removeDocumento(id) {
  try { await API.del(`/documentos/${id}`); documentos = documentos.filter(x => String(x.id) !== String(id)); render(); }
  catch (err) { alert('No se pudo quitar el documento: ' + err.message); }
}
// El formulario "Datos de la ficha" escribe en la versión que esté cargada; sin
// versión, en la ficha misma (la General).
async function saveFicha(field, value) {
  const val = (field === 'precio' || field === 'tamano_m2') ? (value === '' ? null : Number(value)) : value;
  const v = versiones.find(x => String(x.id) === versionSel);
  if (v) {
    if ((v.datos[field] ?? null) === val) return;
    v.datos = { ...v.datos, [field]: val };
    API.patch(`/versiones/${v.id}`, { datos: v.datos }).catch(err => alert('No se pudo guardar la ficha: ' + err.message));
    return;
  }
  await asegurarFicha().catch(() => null);
  if (!ficha) return;
  ficha[field] = val;
  API.patch(`/fichas/${ficha.id}`, { [field]: val }).catch(err => console.warn(err.message));
}

// ── Fichas guardadas ─────────────────────────────────────────────────────────
// Una versión nace como copia de la General y se edita aparte: Ficha-Alsea.pdf puede
// llevar otro título, otro precio u otra descripción sin tocar la de los demás.
const nombrePdf = v => `Ficha-${v ? v.nombre : 'General'}`;
function datosGenerales() {
  const l = listing, f = ficha ?? {};
  return {
    titulo: f.titulo ?? tituloPdf(l), precio: f.precio ?? precioTotal(l) ?? null,
    tamano_m2: f.tamano_m2 ?? l.size ?? null, folio: f.folio ?? null, notas: f.notas ?? null,
  };
}
async function crearVersion(nombre, clienteId) {
  nombre = (nombre ?? '').trim();
  if (!nombre) return;
  try {
    await asegurarFicha();
    const v = await API.post(`/fichas/${ficha.id}/versiones`, { nombre, cliente_id: clienteId ?? null, datos: datosGenerales() });
    versiones.push(v);
    versionSel = String(v.id);
    pdfAbierto = true;
    render();
  } catch (err) { alert('No se pudo guardar la ficha: ' + err.message); }
}
async function borrarVersion(id) {
  const v = versiones.find(x => String(x.id) === id);
  if (!v || !confirm(`¿Borrar ${nombrePdf(v)}.pdf?`)) return;
  try {
    await API.del(`/versiones/${id}`);
    versiones = versiones.filter(x => String(x.id) !== id);
    if (versionSel === id) versionSel = null;
    render();
  } catch (err) { alert('No se pudo borrar: ' + err.message); }
}

// Los datos de una propiedad propia (tipo, municipio, fotos, liga del mapa) viven en
// la ficha y la página los lee de vuelta como si fueran un anuncio: tras guardar se
// vuelve a pedir, para que el mosaico y la banda digan lo que se acaba de escribir.
// Al guardar la liga del mapa la API le saca la coordenada (resolver_mapa en main.py):
// la respuesta ya trae lat/lng y el pin aparece solo.
async function saveBase(field, crudo) {
  if (!ficha) return;
  let patch;
  if (field === 'fotos') patch = { fotos: crudo.split(/\s+/).filter(u => /^https?:/i.test(u)) };
  else if (field === 'precio_m2') patch = { precio_m2: crudo === '' ? null : Number(crudo) };
  else patch = { [field]: crudo.trim() === '' ? null : crudo.trim() };
  if (JSON.stringify(patch[field]) === JSON.stringify(ficha[field] ?? null)) return;
  try {
    Object.assign(ficha, await API.patch(`/fichas/${ficha.id}`, patch));
    listing = adaptListing(await API.get(`/listings/${encodeURIComponent(listing.id)}`));
    render();
    pintarUbicacion();
  } catch (err) { alert('No se pudo guardar: ' + err.message); }
}
async function guardarEnInmobiliaria() {
  try { await asegurarFicha(); render(); }
  catch (err) { alert('No se pudo guardar en Inmobiliaria: ' + err.message); }
}

// ── Anterior / siguiente dentro de la página del tablero ─────────────────────
function vecinos() {
  let ids = [];
  try { ids = JSON.parse(sessionStorage.getItem('ol-nav') ?? '[]'); } catch { /* sin contexto */ }
  const i = ids.indexOf(String(listing.id));
  return i < 0 ? null : { i, n: ids.length, prev: ids[i - 1] ?? null, next: ids[i + 1] ?? null };
}
const irA = id => { if (id) location.href = `listing.html?id=${encodeURIComponent(id)}`; };

// ── Render ───────────────────────────────────────────────────────────────────
function mosaicoHtml(l, nav) {
  const f = l.fotos;
  const celda = (i, cls) => f[i]
    ? `<button class="fx-ph ${cls}" data-i="${i}"><img src="${esc(f[i])}" alt="" loading="${i ? 'lazy' : 'eager'}"></button>`
    : `<span class="fx-ph ${cls} vacio"></span>`;
  return `<div class="fx-mosaic${f.length <= 1 ? ' uno' : ''}">
    ${celda(0, 'grande')}
    ${f.length > 1 ? [1, 2, 3].map(i => celda(i, '')).join('') +
      (f[4] ? `<button class="fx-ph" data-i="4"><img src="${esc(f[4])}" alt="" loading="lazy">${f.length > 5 ? `<span class="fx-mas">Ver las ${f.length} fotos</span>` : ''}</button>` : '<span class="fx-ph vacio"></span>') : ''}
    <a class="fx-over fx-back" href="${TABLERO}">&#8592; Volver al tablero</a>
    ${nav ? `<span class="fx-over fx-nav">
      <button id="navPrev" ${nav.prev ? '' : 'disabled'} title="Anterior (K)">&#8592;</button>
      <span>${nav.i + 1} / ${nav.n}</span>
      <button id="navNext" ${nav.next ? '' : 'disabled'} title="Siguiente (J)">&#8594;</button></span>` : ''}
  </div>`;
}

function render() {
  const l = listing;
  const total = precioTotal(l), pm = ppm(l);
  const fuente = FUENTE_CONFIG[l.fuente] ?? l.fuente;
  const sufijo = l.transaccion === 'Renta' ? 'MXN/mes' : 'MXN';
  document.title = (l.titulo ?? 'Propiedad') + ' · OfficeLab';

  const facts = [
    l.size ? ['Superficie', `${mx(Math.round(l.size))} m²`] : null,
    pm ? ['Precio / m²', `$${mx(Math.round(pm))}`] : null,
    l.tipo ? ['Tipo', cap(l.tipo)] : null,
    l.transaccion ? ['Operación', l.transaccion] : null,
    l.zona ? ['Municipio', l.zona] : null,
    l.codigo ? ['Código', l.codigo] : null,
  ].filter(Boolean);

  const hechos = documentos.filter(d => d.done).length;
  const enSeg = new Set(procesos.map(p => String(p.cliente_id)));
  const disponibles = clientes.filter(c => !enSeg.has(String(c.id)));
  const nav = vecinos();
  // La versión cargada en el formulario, y de dónde salen sus valores.
  const vSel = versiones.find(v => String(v.id) === versionSel) ?? null;
  const d = vSel ? vSel.datos : (ficha ?? {});
  const respDe = cid => { const c = clientes.find(x => String(x.id) === String(cid)); return c ? (c.responsable_nombre || c.responsable || null) : null; };

  document.getElementById('detail').innerHTML = `
    ${mosaicoHtml(l, nav)}
    <section class="fx-band">
      <div class="fx-band-t">
        <h1>${esc(l.titulo ?? 'Sin título')}</h1>
        <p>${[l.direccion, l.tipo && cap(l.tipo), l.transaccion, l.codigo, fuente].filter(Boolean).map(esc).join(' · ')}
          ${mapsLink(l) ? ` · <a href="${hrefSeguro(mapsLink(l))}" target="_blank" rel="noopener">ver en mapa</a>` : ''}</p>
      </div>
      <div class="fx-band-p">
        <b>${total != null ? '$' + mx(Math.round(total)) : (l.porM2 && l.precio != null ? '$' + mx(l.precio) : 'Sin precio')}</b>
        <span>${total != null ? sufijo : (l.porM2 && l.precio != null ? 'por m²' : '')}${pm && total != null ? ` · $${mx(Math.round(pm))}/m²` : ''}</span>
        ${altPriceHtml(l.alt)}
      </div>
      <select class="fx-status s-${l.status}" id="detailStatus" aria-label="Estado">
        ${STATUSES.map(s => `<option${s === l.status ? ' selected' : ''}>${s}</option>`).join('')}
      </select>
      <button class="fx-star${l.starred ? ' on' : ''}" id="detailStar" aria-pressed="${l.starred}" title="Destacar">${l.starred ? '&#9733;' : '&#9734;'}</button>
      ${l.whatsapp ? `<a class="fx-btn solid" href="https://wa.me/${l.whatsapp.replace(/\D/g, '')}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
      ${l.url ? `<a class="fx-btn" href="${hrefSeguro(l.url)}" target="_blank" rel="noopener">Anuncio ${ICON_EXTERNAL}</a>` : ''}
      ${esPropia(l) ? '' : (ficha
        ? '<span class="fx-tag" title="Tiene ficha: aparece en la pestaña Inmobiliaria">En Inmobiliaria</span>'
        : '<button class="fx-btn" id="btnInmo" title="Guardarla en la bolsa propia, sin asignarla a nadie">+ Inmobiliaria</button>')}
      <button class="fx-btn" id="btnPdf" title="Imprime ${esc(nombrePdf(vSel))}.pdf">Ficha PDF</button>
      <button class="fx-btn" id="mkt-pdf" title="Análisis de mercado de esta propiedad, para adjuntar a la propuesta">Análisis de mercado</button>
    </section>

    <div class="fx-cols">
      <section class="fx-card">
        <h2>Ficha</h2>
        <dl class="fx-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
        ${l.descripcion ? `<p class="fx-desc">${esc(l.descripcion)}</p>` : ''}
        ${l.features.length ? `<ul class="fx-feat">${l.features.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
        ${esPropia(l) && ficha ? `<details class="fx-pdfdata" id="baseData"${l.tipo && l.zona ? '' : ' open'}>
          <summary>Datos de la propiedad</summary>
          <div class="fx-row">
            <label>Tipo<input class="base-in" data-f="tipo" value="${esc(ficha.tipo ?? '')}" placeholder="Local, terreno…"></label>
            <label>Municipio<input class="base-in" data-f="municipio" value="${esc(ficha.municipio ?? '')}"></label>
            <label>Precio por m²<input type="number" class="base-in" data-f="precio_m2" value="${ficha.precio_m2 ?? ''}"></label>
          </div>
          <label>Liga del mapa<input class="base-in" data-f="mapa_url" value="${esc(ficha.mapa_url ?? '')}" placeholder="https://maps.app.goo.gl/…"></label>
          <label>Fotos (una liga por renglón)<textarea class="base-in" data-f="fotos" rows="3" placeholder="https://…">${esc((ficha.fotos ?? []).join('\n'))}</textarea></label>
        </details>` : ''}
        <div class="fx-vers">
          <h2>Fichas PDF <span class="fx-n">${versiones.length + 1}</span></h2>
          <div class="fx-ver${vSel ? '' : ' on'}">
            <button class="fx-ver-n" data-v="">Ficha-General.pdf</button>
            <small>${esPropia(l) ? 'Datos de la propiedad' : 'Datos del anuncio'}</small>
            <button class="fx-ver-pdf" data-v="" title="Imprimir o guardar como PDF">PDF</button>
          </div>
          ${versiones.map(v => `<div class="fx-ver${String(v.id) === versionSel ? ' on' : ''}">
            <button class="fx-ver-n" data-v="${esc(v.id)}">${esc(nombrePdf(v))}.pdf</button>
            <small>${esc([v.autor, fechaCorta(v.updated_at)].filter(Boolean).join(' · '))}</small>
            <button class="fx-ver-pdf" data-v="${esc(v.id)}" title="Imprimir o guardar como PDF">PDF</button>
            <button class="fx-ver-del" data-v="${esc(v.id)}" title="Borrar esta ficha">&times;</button>
          </div>`).join('')}
          <select class="fx-asignar" id="verAdd" aria-label="Nueva ficha">
            <option value="">+ Nueva ficha para…</option>
            ${clientes.map(c => `<option value="${esc(c.id)}">${esc(c.nombre)}</option>`).join('')}
            <option value="__otro">Otro nombre…</option>
          </select>
        </div>
        <details class="fx-pdfdata" id="pdfData"${pdfAbierto ? ' open' : ''}>
          <summary>Datos de ${esc(nombrePdf(vSel))}.pdf</summary>
          <label>Título<input class="ficha-in" data-f="titulo" value="${esc(d.titulo ?? tituloPdf(l))}"></label>
          <div class="fx-row">
            <label>Precio<input type="number" class="ficha-in" data-f="precio" value="${d.precio ?? (vSel ? '' : (total != null ? Math.round(total) : ''))}"></label>
            <label>m²<input type="number" class="ficha-in" data-f="tamano_m2" value="${d.tamano_m2 ?? (vSel ? '' : (l.size ?? ''))}"></label>
            <label>ID<input class="ficha-in" data-f="folio" value="${esc(d.folio ?? '')}" placeholder="${folioSugerido()}"></label>
          </div>
          <label>Descripción para el cliente<textarea class="ficha-in" data-f="notas" rows="4" placeholder="Si se deja vacía se usa la descripción ${esPropia(l) ? 'de la propiedad' : 'del anuncio'}.">${esc(d.notas ?? '')}</textarea></label>
        </details>
      </section>

      <section class="fx-card">
        <h2>Documentos <span class="fx-n">${hechos} / ${documentos.length}</span></h2>
        ${documentos.length ? `<div class="fx-prog"><span style="width:${Math.round(hechos / documentos.length * 100)}%"></span></div>` : ''}
        <div class="fx-docs">
          ${documentos.map(d => `<div class="fx-doc${d.done ? ' done' : ''}">
            <label><input type="checkbox" class="doc-chk" data-id="${d.id}"${d.done ? ' checked' : ''}><span>${esc(d.label)}</span></label>
            <button class="doc-del" data-id="${d.id}" title="Quitar">&times;</button></div>`).join('')
            || '<p class="fx-hint">Sin documentos todavía.</p>'}
        </div>
        <div class="fx-add"><input class="doc-input" placeholder="+ Agregar documento (predial, planos…)"><button class="doc-add">Agregar</button></div>
      </section>

      <div class="fx-stack">
        <section class="fx-card">
          <h2>Clientes <span class="fx-n">${procesos.length}</span></h2>
          ${procesos.map(p => `<div class="fx-proc">
            ${p.responsable_nombre
              ? `<b class="tk-ava fx-resp" style="background:${tono(p.responsable_id ?? p.responsable_nombre)}" title="Cuenta: ${esc(p.responsable_nombre)}">${esc(iniciales(p.responsable_nombre.replace('/', ' ')))}</b>`
              : '<b class="tk-ava fx-resp sin" title="Cliente sin asignar">&#8212;</b>'}
            <span>${esc(p.cliente?.nombre ?? '(cliente)')}<small>${esc(p.responsable_nombre ?? 'Sin asignar')}</small></span>
            <select class="proc-status e-${esc(p.status)}" data-proc="${esc(p.id)}">${etapaOpciones(p.status)}</select>
            <button class="proc-del" data-proc="${p.id}" title="Quitar">&times;</button></div>`).join('')
            || '<p class="fx-hint">Aún no se propone a ningún cliente.</p>'}
          ${clientes.length
            ? (disponibles.length ? `<select class="fx-asignar" id="procAdd"><option value="">+ Asignar a cliente…</option>
                ${disponibles.map(c => `<option value="${c.id}">${esc(c.nombre)}${respDe(c.id) ? ` · ${esc(respDe(c.id))}` : ''}</option>`).join('')}</select>` : '')
            : '<p class="fx-hint">Crea clientes en <a href="clientes.html">Clientes</a>.</p>'}
        </section>
        <section class="fx-card fx-notas">
          <h2>Notas internas</h2>
          <textarea id="detailNotes" placeholder="Llamadas, condiciones, pendientes…">${esc(l.notes)}</textarea>
        </section>
      </div>
    </div>`;
  enlazar();
}

function enlazar() {
  const $ = id => document.getElementById(id);
  $('detailStar').onclick = () => { setState({ starred: !listing.starred }); render(); };
  $('detailStatus').onchange = e => { setState({ status: e.target.value }); e.target.className = `fx-status s-${e.target.value}`; };
  $('detailNotes').onblur = e => setState({ notes: e.target.value });
  $('btnPdf').onclick = () => imprimirFicha(versionSel);
  $('btnInmo') && ($('btnInmo').onclick = guardarEnInmobiliaria);
  $('pdfData').ontoggle = e => { pdfAbierto = e.target.open; };
  // Una ficha guardada: su nombre la carga en el formulario; "PDF" la imprime.
  document.querySelectorAll('.fx-ver-n').forEach(b => b.onclick = () => { versionSel = b.dataset.v || null; pdfAbierto = true; render(); });
  document.querySelectorAll('.fx-ver-pdf').forEach(b => b.onclick = () => imprimirFicha(b.dataset.v || null));
  document.querySelectorAll('.fx-ver-del').forEach(b => b.onclick = () => borrarVersion(b.dataset.v));
  $('verAdd').onchange = e => {
    const v = e.target.value;
    e.target.value = '';
    if (v === '__otro') return crearVersion(prompt('Nombre de la ficha (sale como Ficha-<nombre>.pdf):'));
    const c = clientes.find(x => String(x.id) === v);
    if (c) crearVersion(c.nombre, c.id);
  };
  document.querySelectorAll('.base-in').forEach(el => el.onchange = e => saveBase(e.target.dataset.f, e.target.value));
  $('mkt-pdf').onclick = e => descargarAnalisis(e.currentTarget);
  $('navPrev') && ($('navPrev').onclick = () => irA(vecinos()?.prev));
  $('navNext') && ($('navNext').onclick = () => irA(vecinos()?.next));
  $('procAdd') && ($('procAdd').onchange = e => addProceso(e.target.value));
  document.querySelectorAll('.fx-ph[data-i]').forEach(b => b.onclick = () => abrirVisor(+b.dataset.i));
  document.querySelectorAll('.ficha-in').forEach(el => el.onblur = e => saveFicha(e.target.dataset.f, e.target.value));
  document.querySelector('.doc-add').onclick = () => addDocumento(document.querySelector('.doc-input').value);
  document.querySelector('.doc-input').onkeydown = e => { if (e.key === 'Enter') addDocumento(e.target.value); };
  document.querySelectorAll('.doc-chk').forEach(c => c.onchange = e => toggleDocumento(e.target.dataset.id, e.target.checked));
  document.querySelectorAll('.doc-del').forEach(b => b.onclick = e => removeDocumento(e.currentTarget.dataset.id));
  document.querySelectorAll('.proc-status').forEach(s => s.onchange = e => {
    setProcesoStatus(e.target.dataset.proc, e.target.value);
    e.target.className = 'proc-status e-' + e.target.value;
  });
  document.querySelectorAll('.proc-del').forEach(b => b.onclick = e => removeProceso(e.currentTarget.dataset.proc));
}

// El análisis de mercado se genera en el servidor, al revés que la ficha PDF, que
// imprime en el navegador: este documento sale hacia un cliente, así que tiene que
// paginar igual siempre y poder archivarse tal como se entregó (api/documento.py).
async function descargarAnalisis(btn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Generando\u2026';
  document.getElementById('mkt-aviso')?.remove();
  try {
    const blob = await API.pdfAnalisis(listing.id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `analisis-${listing.id.replace(/[^A-Za-z0-9._-]+/g, '-')}.pdf`;
    a.click();
    // Sin revoke, cada descarga deja el PDF entero retenido en memoria.
    URL.revokeObjectURL(url);
  } catch (e) {
    const p = document.createElement('p');
    p.className = 'fx-hint';
    p.id = 'mkt-aviso';
    p.textContent = e.message;
    btn.closest('.fx-band').insertAdjacentElement('afterend', p);
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// ── Mercado comparable ───────────────────────────────────────────────────────
// Lo mismo que imprime el PDF, en la ficha y sin descargar nada. El entorno sólo
// llega si ya se consultó antes (la API no gasta en Google por abrir una ficha:
// ver api/entorno.py). El mapa de comparables es el de ubicacion.js (MapLibre +
// OpenFreeMap), sin llave.
const pesosMx = n => n == null ? '—' : `$${mx(Math.round(n))}`;
const pct = x => x == null ? '—' : `${(x * 100).toFixed(1)}%`;
const diasTxt = n => n == null ? '—' : `${mx(Math.round(n))} días`;

async function cargarMercado() {
  const caja = document.getElementById('mercado');
  let d;
  try { d = await API.get(`/analisis/${encodeURIComponent(listing.id)}`); }
  catch (e) {
    // 422: la propiedad no se puede comparar (sin coordenada, superficie o
    // precio). Se dice en su sitio en vez de dejar la tarjeta vacía.
    caja.innerHTML = `<div class="fx-card"><h2>Mercado comparable</h2><p class="fx-hint">${esc(e.message)}</p></div>`;
    caja.hidden = false;
    return;
  }
  const s = d.sujeto, r = d.resumen, y = d.rendimiento, e = d.entorno;
  let cuerpo;
  if (!r.suficiente) {
    cuerpo = `<p class="fx-hint">Inventario insuficiente: ${r.n} comparables a 5 km, y el análisis
      pide ${r.minimo} para publicar una cifra.</p>`;
  } else {
    const u = r.unitario, p = r.percentil_sujeto;
    const hechos = [
      ['Mediana del mercado', `${pesosMx(u.mediana)} / m²`],
      ['Mitad central', `${pesosMx(u.p25)} – ${pesosMx(u.p75)}`],
      ['Esta propiedad', p == null ? '—' : `${pesosMx(s.unitario)} · más alto que ${p}%`],
      ['Comparables', `${r.n} en ${r.radio_m / 1000} km`],
      y ? ['Rendimiento bruto zona', `${pct(y.mercado)} anual`] : null,
      r.dias_mediana != null ? ['Antigüedad', `${diasTxt(s.dias)} · mercado ${diasTxt(r.dias_mediana)}`] : null,
    ].filter(Boolean);
    cuerpo = `<dl class="fx-facts">${hechos.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
  }
  const entorno = e ? `<ul class="fx-feat">${e.grupos.map(g =>
      `<li>${esc(g.nombre)} · ${g.tope ? `${g.n}+` : g.n}</li>`).join('')}</ul>` : '';
  caja.innerHTML = `<div class="fx-card mk-grid">
      <div class="mk-datos">
        <h2>Mercado comparable <span class="fx-n">precios de lista</span></h2>
        ${cuerpo}
        ${entorno ? `<h2>Entorno a ${e.radio_m} m</h2>${entorno}` : ''}
      </div>
      <div class="mk-mapa">
        <div id="mkMap"></div>
        <div class="ub-zoom"><button id="mkMas" aria-label="Acercar">+</button><button id="mkMenos" aria-label="Alejar">&#8722;</button></div>
        <div class="map-note" id="mkAviso" hidden></div>
        <div class="ub-attr">&#169; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &#183; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> &#183; <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a></div>
      </div>
    </div>`;
  caja.hidden = false;

  // Los comparables con su precio por m², y la propiedad resaltada entre ellos.
  const pins = d.comparables.map(c => ({ id: c.id, lat: c.lat, lng: c.lng, titulo: c.title, precio: c.unitario }));
  if (s.geo_origen !== 'relleno') pins.push({ id: listing.id, lat: s.lat, lng: s.lng, titulo: 'Esta propiedad', precio: s.unitario });
  Ubicacion.comparables(document.getElementById('mkMap'), pins, { sujetoId: listing.id, onPin: irA });
  document.getElementById('mkMas').onclick = () => Ubicacion.zoomCmp(1);
  document.getElementById('mkMenos').onclick = () => Ubicacion.zoomCmp(-1);
}

// ── Ubicación ────────────────────────────────────────────────────────────────
// El mapa vive fuera de #detail (render() lo reescribe entero). En un anuncio el pin
// es la coordenada del portal; en una propiedad propia lo fija el asesor con un clic
// y se guarda en la ficha (ficha.lat / ficha.lng).
const NOTA_GEO = { portal_aprox: 'aproximada: centro de la colonia', colonia: 'aproximada: centro de la colonia' };
function pintarUbicacion() {
  const l = listing, caja = document.getElementById('ubicacion');
  const propia = esPropia(l) && !!ficha;
  const hay = l.lat != null && l.lng != null;
  if (!hay && !propia) { caja.hidden = true; return; }
  caja.hidden = false;
  document.getElementById('ubNota').textContent = hay ? (NOTA_GEO[l.geoOrigen] ?? '') : 'sin fijar';
  const fijar = document.getElementById('ubFijar');
  fijar.hidden = !propia;
  fijar.textContent = hay ? 'Mover ubicación' : 'Fijar ubicación';
  const g = document.getElementById('ubGmaps');
  g.hidden = !mapsLink(l);
  g.href = hrefSeguro(mapsLink(l));
  Ubicacion.pintar(document.getElementById('ubMap'), {
    lat: l.lat, lng: l.lng,
    onFijar: async ({ lat, lng }) => {
      try {
        Object.assign(ficha, await API.patch(`/fichas/${ficha.id}`, { lat, lng }));
        Object.assign(listing, { lat, lng });
        pintarUbicacion();
      } catch (err) { alert('No se pudo guardar la ubicación: ' + err.message); }
    },
  });
  // Sin ubicación todavía, el mapa arranca esperando el clic.
  if (propia && !hay) Ubicacion.esperarClic(true);
}
document.getElementById('ubFijar').onclick = e => {
  const on = !e.currentTarget.classList.contains('on');
  e.currentTarget.classList.toggle('on', on);
  Ubicacion.esperarClic(on);
};
document.getElementById('ubMas').onclick = () => Ubicacion.zoom(1);
document.getElementById('ubMenos').onclick = () => Ubicacion.zoom(-1);

// ── Visor de fotos ───────────────────────────────────────────────────────────
let visor = -1;
function abrirVisor(i) {
  if (!listing.fotos.length) return;
  visor = (i + listing.fotos.length) % listing.fotos.length;
  document.getElementById('lbImg').src = listing.fotos[visor];
  document.getElementById('lbN').textContent = `${visor + 1} / ${listing.fotos.length}`;
  document.getElementById('lightbox').hidden = false;
}
const cerrarVisor = () => { visor = -1; document.getElementById('lightbox').hidden = true; };
document.getElementById('lbClose').onclick = cerrarVisor;
document.getElementById('lbPrev').onclick = () => abrirVisor(visor - 1);
document.getElementById('lbNext').onclick = () => abrirVisor(visor + 1);
document.getElementById('lightbox').onclick = e => { if (e.target.id === 'lightbox') cerrarVisor(); };
document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select')) return;
  if (visor >= 0) {
    if (e.key === 'Escape') cerrarVisor();
    if (e.key === 'ArrowLeft') abrirVisor(visor - 1);
    if (e.key === 'ArrowRight') abrirVisor(visor + 1);
    return;
  }
  const v = listing && vecinos();
  if (e.key === 'j' || e.key === 'J') irA(v?.next);
  if (e.key === 'k' || e.key === 'K') irA(v?.prev);
});

// ── Ficha técnica PDF · formato Pro Realtors ─────────────────────────────────
// Reproduce PR-140926-1: asesor + logo, línea, precio con operación, colonia,
// título en mayúsculas, foto, franja $/m² · m² + tipo · ID, descripción y liga a
// Maps. Si hay más fotos van en una segunda hoja, dos por fila.
function tituloPdf(l) {
  const tipo = (l.tipo ?? 'Inmueble').toUpperCase();
  const op = { Venta: 'EN VENTA', Renta: 'EN RENTA' }[l.transaccion] ?? '';
  const calle = (l.direccion ?? '').split(',')[0].trim();
  return [tipo, op].filter(Boolean).join(' ') + (calle ? ' EN ' + calle.toUpperCase() : '');
}
function folioSugerido() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `PR-${p(d.getDate())}${p(d.getMonth() + 1)}${String(d.getFullYear()).slice(2)}-1`;
}

function imprimirFicha(versionId) {
  const v = versiones.find(x => String(x.id) === versionId) ?? null;
  // Lo que la versión trae pisa a la ficha; las fotos siempre son las de la ficha.
  const l = listing, f = { ...(ficha ?? {}), ...(v?.datos ?? {}) }, cfg = window.OL_CONFIG ?? {}, u = currentUser ?? {};
  const precio = f.precio ?? precioTotal(l);
  const m2 = f.tamano_m2 ?? l.size;
  const pm = precio && m2 ? precio / m2 : ppm(l);
  const fotos = (f.fotos?.length ? f.fotos : l.fotos);
  const desc = (f.notas?.trim() || l.descripcion || '').split(/\n{2,}/).filter(Boolean);
  const maps = mapsLink(l);
  const tel = u.whatsapp ?? u.telefono ?? u.celular ?? '';
  const extra = fotos.slice(1, 7);

  document.getElementById('ficha-print').innerHTML = `
    <section class="pr-sheet">
      <header class="pr-head">
        <div class="pr-asesor">
          <b>${esc(u.nombre ?? '')}</b>
          ${tel ? `<span>WhatsApp: ${esc(tel)}</span>` : ''}
          ${cfg.oficinaTel ? `<span>Oficina: ${esc(cfg.oficinaTel)}</span>` : ''}
          ${u.email ? `<span>Email: ${esc(u.email)}</span>` : ''}
        </div>
        <img class="pr-logo" src="img/prorealtors-logo.png" alt="Pro Realtors">
      </header>
      <div class="pr-rule"></div>
      <div class="pr-precio"><b>${precio != null ? '$' + mx(Math.round(precio)) : 'Precio a consultar'}</b><span>${{ Venta: 'EN VENTA', Renta: 'EN RENTA' }[l.transaccion] ?? ''}</span></div>
      ${l.direccion ? `<div class="pr-colonia">${esc(l.direccion)}.</div>` : ''}
      <h1 class="pr-titulo">${esc((f.titulo ?? tituloPdf(l)).toUpperCase())}</h1>
      ${fotos[0] ? `<img class="pr-foto" src="${esc(fotos[0])}" alt="">` : ''}
      <div class="pr-datos">
        <div><span>Precio x m²</span><b>${pm ? '$' + mx(Math.round(pm)) : '—'}</b></div>
        <div><span>${esc(cap(l.tipo ?? 'Superficie'))}</span><b>${m2 ? mx(Math.round(m2)) + ' m²' : '—'}</b></div>
        <div><span>ID</span><b>${esc(f.folio || folioSugerido())}</b></div>
      </div>
      <h2 class="pr-h2">Descripción</h2>
      <div class="pr-desc">${desc.map(p => `<p>${esc(p)}</p>`).join('')}
        ${maps ? `<p class="pr-maps">${esc(maps)}</p>` : ''}</div>
    </section>
    ${extra.length ? `<section class="pr-sheet pr-fotos">
      <header class="pr-head"><b class="pr-mini">${esc((f.titulo ?? tituloPdf(l)).toUpperCase())}</b><img class="pr-logo" src="img/prorealtors-logo.png" alt=""></header>
      <div class="pr-rule"></div>
      <div class="pr-grid">${extra.map(s => `<img src="${esc(s)}" alt="">`).join('')}</div>
    </section>` : ''}`;
  // Espera a que carguen las fotos: si no, el PDF sale con huecos.
  const imgs = [...document.querySelectorAll('#ficha-print img')];
  // El navegador propone el título de la página como nombre del archivo: así el PDF
  // se guarda como Ficha-General.pdf o Ficha-Alsea.pdf sin que nadie lo teclee.
  const titulo = document.title;
  window.addEventListener('afterprint', () => { document.title = titulo; }, { once: true });
  Promise.all(imgs.map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; })))
    .then(() => { document.title = nombrePdf(v); window.print(); });
}

// ── Init ─────────────────────────────────────────────────────────────────────
document.getElementById('logout-btn').addEventListener('click', async () => {
  await API.logout().catch(() => {});
  location.replace('login.html');
});

const id = new URLSearchParams(location.search).get('id');
API.me().then(async user => {
  currentUser = user;
  document.getElementById('authBox').hidden = true;
  document.getElementById('userBox').hidden = false;
  if (!id) { document.getElementById('detail').innerHTML = '<p class="pg-empty">Falta el identificador de la propiedad.</p>'; return; }
  listing = adaptListing(await API.get(`/listings/${encodeURIComponent(id)}`));
  await loadFicha();
  await Promise.all([loadSeguimiento(), loadDocumentos()]);
  render();
  pintarUbicacion();
  // Aparte y sin await: el análisis tarda ~400 ms y la ficha no tiene por qué
  // esperarlo, ni caerse si falla.
  cargarMercado().catch(err => console.error(err));
}).catch(err => {
  console.error(err);
  document.getElementById('detail').innerHTML = `<p class="pg-empty">No se pudo cargar esta propiedad.<br>${esc(err.message)}</p>`;
});

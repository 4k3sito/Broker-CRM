// Ficha de propiedad (diseño 1b): mosaico de fotos a lo ancho, banda de decisión
// (precio, estado, destacado, contacto) y tres columnas sin scroll largo:
// Ficha · Documentos · Clientes + notas. Anterior/siguiente recorre la página del
// tablero de la que se vino (el tablero guarda los ids en sessionStorage).

// "Volver" regresa a la búsqueda de la que se vino, con sus filtros (app.js la guarda
// en cada render); sin ella, a la pestaña de la que se vino (Bolsa o Inmobiliaria).
const TABLERO = (() => {
  try {
    const t = sessionStorage.getItem('ol-tablero');
    if (t?.startsWith('index.html')) return t;
    return sessionStorage.getItem('ol-tab') === 'inmobiliaria' ? 'index.html?tab=inmobiliaria' : 'index.html';
  } catch { return 'index.html'; }
})();
// La operación que filtraba el tablero de donde se vino: con ella, un inmueble en renta
// y venta enseña primero el precio que se estaba buscando.
const opDelTablero = () => new URLSearchParams(TABLERO.split('?')[1] ?? '').get('operacion');
// Si se llegó desde la tabla de un cliente ("Abrir ficha completa"), se vuelve ahí, a
// la misma fila, y no al tablero.
const VOLVER = (() => {
  const u = new URLSearchParams(location.search), c = u.get('cliente');
  return c ? { href: `clientes.html${API.qs({ proc: u.get('proc') })}#${encodeURIComponent(c)}`, texto: 'Volver al cliente' }
           : { href: TABLERO, texto: 'Volver al tablero' };
})();
// Modo presentación (clientes.js): si la ficha se abrió desde un cliente que se está
// presentando, aquí tampoco se ve nada de otros clientes ni lo interno. Es el id del
// cliente, o null. Vive en la pestaña, igual que allá.
const PRESENTA_A = (() => {
  try { return sessionStorage.getItem('ol-cl-presenta') === '1' ? new URLSearchParams(location.search).get('cliente') : null; }
  catch { return null; }
})();
// Las fichas PDF que se enseñan: en presentación, sólo las hechas para ese cliente; si
// no tiene ninguna, la General. Las de otros clientes y las de nombre libre no salen.
const versionesVisibles = () => PRESENTA_A ? versiones.filter(v => String(v.cliente_id) === PRESENTA_A) : versiones;
const conGeneral = () => !PRESENTA_A || !versionesVisibles().length;
// El anuncio —su forma, sus precios y sus etiquetas— viene de anuncio.js; las etapas
// de un proceso, de etapas.js (compartido con tareas y clientes); `esc`, `mx` y
// `hrefSeguro`, de texto.js.

const ICON_EXTERNAL = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;

let listing = null, ficha = null, clientes = [], procesos = [], documentos = [], currentUser = null;
// Las fichas PDF guardadas de esta propiedad (ficha_version). `versionSel` es la que
// está cargada en el formulario y la que imprime "Ficha PDF"; null es la General.
let versiones = [], versionSel = null, pdfAbierto = false;
// Lo que se está subiendo ahora mismo, para decirlo en su tarjeta: { docs, fotos }.
const subiendo = { docs: 0, fotos: 0 };
const MAX_ARCHIVO = Fotos.MAX_ARCHIVO;      // el mismo tope que pone la API

const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

const precioTotal = Anuncio.total, ppm = Anuncio.porMetro;
// Un inmueble en renta Y en venta: los dos precios con el mismo peso, cada uno con su
// operación. Llegando del tablero con un filtro de operación, ésa va primero.
function preciosDualHtml(l, ofs) {
  const mon = Anuncio.moneda(l);
  return ofs.map(o => {
    const op = (o.op ?? '').toUpperCase();
    if (o.monto == null) return `<div class="fx-oferta"><b class="no-price">Por confirmar</b><span>EN ${op}</span></div>`;
    const pm = o.unitario ?? (l.size && !o.parcial ? o.monto / l.size : null);
    const unidad = `${mon}${o.parcial ? '/m²' : ''}${o.op === 'Renta' ? '/mes' : ''}`;
    return `<div class="fx-oferta"><b>$${mx(Math.round(o.monto))}</b><span>${unidad}${pm && !o.parcial ? ` · $${mx(Math.round(pm))}/m²` : ''} · EN ${op}</span></div>`;
  }).join('');
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
    status: Anuncio.estadoApi(listing.status), starred: listing.starred, notes: listing.notes,
  }).catch(err => console.warn('No se pudo guardar el estado:', err.message));
}

// ── Ficha, seguimiento y documentos ──────────────────────────────────────────
async function loadFicha() {
  const fs = await API.get(`/fichas?listing=${encodeURIComponent(listing.id)}`).catch(() => []);
  ficha = fs[0] ?? null;
  versiones = ficha ? await API.get(`/fichas/${ficha.id}/versiones`).catch(() => []) : [];
  if (!conGeneral()) versionSel = String(versionesVisibles()[0].id);
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
  } catch (err) { UI.aviso('No se pudo asignar: ' + err.message); }
}
function setProcesoStatus(id, status) {
  const p = procesos.find(x => String(x.id) === String(id));
  if (p) p.status = status;
  API.patch(`/procesos/${id}`, { status }).catch(err => console.warn(err.message));
}
async function removeProceso(id) {
  try { await API.del(`/procesos/${id}`); procesos = procesos.filter(p => String(p.id) !== String(id)); render(); }
  catch (err) { UI.aviso('No se pudo quitar: ' + err.message); }
}
async function addDocumento(label) {
  label = (label ?? '').trim();
  if (!label) return;
  try { await crearDocumento(label); render(); }
  catch (err) { UI.aviso('No se pudo agregar el documento: ' + err.message); }
}
async function crearDocumento(label) {
  await asegurarFicha();
  const d = { archivos: [], ...await API.post('/documentos', { ficha_id: ficha.id, label }) };
  documentos.push(d);
  return d;
}

// ── Archivos de un documento ─────────────────────────────────────────────────
// Un documento era sólo un nombre con casilla; ahora puede llevar el archivo (o
// varios: las hojas de una escritura). Se suben de tres formas: con "Adjuntar" en un
// documento que ya existe, con "Archivos…" junto al campo de alta, o soltándolos sobre
// la tarjeta. Al dar de alta con archivos: si se escribió un nombre, van todos a ese
// documento; si no, cada archivo es un documento con su propio nombre.
function cabenTodos(files) {
  const grande = files.find(f => f.size > MAX_ARCHIVO);
  if (grande) UI.aviso(`"${grande.name}" pesa ${pesoTxt(grande.size)} y el máximo por archivo es ${pesoTxt(MAX_ARCHIVO)}.`);
  return !grande;
}
// Sube `files` al documento `d`. Con el archivo ya adjunto el documento se da por
// conseguido (la casilla se puede quitar después).
async function adjuntar(d, files) {
  for (const f of files) {
    d.archivos = [...(d.archivos ?? []), await API.subir(`/documentos/${d.id}/archivos`, f)];
  }
  if (files.length && !d.done) {
    d.done = true;
    API.patch(`/documentos/${d.id}`, { done: true }).catch(err => console.warn(err.message));
  }
}
async function subirDocumentos(files, { docId = null, label = '' } = {}) {
  files = [...files];
  if (!files.length || !cabenTodos(files)) return;
  subiendo.docs = files.length; render();
  try {
    label = label.trim();
    if (docId) await adjuntar(documentos.find(x => String(x.id) === String(docId)), files);
    else if (label) await adjuntar(await crearDocumento(label), files);
    else for (const f of files) await adjuntar(await crearDocumento(sinExtension(f.name)), [f]);
  } catch (err) { UI.aviso('No se pudo subir el archivo: ' + err.message); }
  subiendo.docs = 0; render();
}
async function removeArchivo(id) {
  const d = documentos.find(x => (x.archivos ?? []).some(a => String(a.id) === String(id)));
  const a = d?.archivos.find(x => String(x.id) === String(id));
  if (!a || !(await UI.confirmar({ titulo: `¿Borrar el archivo «${a.nombre}»?`, texto: 'No se puede deshacer.',
    verbo: 'Borrar', peligro: true }))) return;
  try { await API.del(`/archivos/${id}`); d.archivos = d.archivos.filter(x => x !== a); render(); }
  catch (err) { UI.aviso('No se pudo borrar el archivo: ' + err.message); }
}
function toggleDocumento(id, done) {
  const d = documentos.find(x => String(x.id) === String(id));
  if (d) d.done = done;
  API.patch(`/documentos/${id}`, { done }).catch(err => console.warn(err.message));
  render();
}
async function removeDocumento(id) {
  const n = documentos.find(x => String(x.id) === String(id))?.archivos?.length ?? 0;
  if (n && !(await UI.confirmar({ titulo: `¿Borrar el documento con ${n === 1 ? 'su archivo' : `sus ${n} archivos`}?`,
    texto: `Tiene ${n} ${n === 1 ? 'archivo adjunto' : 'archivos adjuntos'}. No se puede deshacer.`,
    verbo: 'Borrar', peligro: true }))) return;
  try { await API.del(`/documentos/${id}`); documentos = documentos.filter(x => String(x.id) !== String(id)); render(); }
  catch (err) { UI.aviso('No se pudo quitar el documento: ' + err.message); }
}
// El formulario "Datos de la ficha" escribe en la versión que esté cargada; sin
// versión, en la ficha misma (la General).
async function saveFicha(field, value) {
  const val = ['precio', 'tamano_m2', 'construccion_m2', 'precio_m2'].includes(field) ? (value === '' ? null : Number(value)) : value;
  const v = versiones.find(x => String(x.id) === versionSel);
  if (v) {
    if ((v.datos[field] ?? null) === val) return;
    v.datos = { ...v.datos, [field]: val };
    API.patch(`/versiones/${v.id}`, { datos: v.datos }).catch(err => UI.aviso('No se pudo guardar la ficha: ' + err.message));
    // El $/m² que se propone cuando se deja vacío sale de precio y m²: que se actualice.
    if (field === 'precio' || field === 'tamano_m2') repintar();
    return;
  }
  await asegurarFicha().catch(() => null);
  if (!ficha || (ficha[field] ?? null) === val) return;
  ficha[field] = val;
  if (!esPropia(listing)) {
    API.patch(`/fichas/${ficha.id}`, { [field]: val }).catch(err => console.warn(err.message));
    return;
  }
  // En una propiedad propia la ficha ES la propiedad: el encabezado, el precio y los
  // datos de arriba salen de aquí, así que se vuelven a pedir y a pintar.
  try {
    // La respuesta trae también lo que la API calculó: con dos de precio / m² / $/m²
    // sale el tercero (derivar_precio en main.py).
    Object.assign(ficha, numeros(await API.patch(`/fichas/${ficha.id}`, { [field]: val })));
    listing = Anuncio.de(await API.get(`/listings/${encodeURIComponent(listing.id)}`));
    repintar();
  } catch (err) { UI.aviso('No se pudo guardar: ' + err.message); }
}
// Postgres manda los `numeric` como texto ("45800.00"): se vuelven número para que el
// formulario no enseñe decimales que nadie escribió.
function numeros(f) {
  for (const k of ['precio', 'tamano_m2', 'construccion_m2', 'precio_m2']) if (f[k] != null) f[k] = Number(f[k]);
  return f;
}
// render() reescribe el formulario entero: sin esto, al pasar con Tab de un campo al
// siguiente el guardado del primero le quitaría el foco al segundo.
function repintar() {
  const f = document.activeElement?.dataset?.f;
  pdfAbierto = true;
  render();
  if (f) document.querySelector(`#pdfData [data-f="${f}"]`)?.focus();
}

// ── Fichas guardadas ─────────────────────────────────────────────────────────
// Una versión nace como copia de la General y se edita aparte: Ficha-Alsea.pdf puede
// llevar otro título, otro precio, otro precio por m², otra descripción y otras fotos
// sin tocar la de los demás. Tipo, municipio y liga del mapa sí son de la propiedad.
const nombrePdf = v => `Ficha-${v ? v.nombre : 'General'}`;
function datosGenerales() {
  const l = listing, f = ficha ?? {};
  return {
    titulo: f.titulo ?? tituloPdf(l), precio: f.precio ?? precioTotal(l) ?? null,
    tamano_m2: f.tamano_m2 ?? l.size ?? null, folio: f.folio ?? null, notas: f.notas ?? null,
    construccion_m2: f.construccion_m2 ?? (l.construccion && l.construccion !== l.size ? l.construccion : null),
    precio_m2: f.precio_m2 ?? null, fotos: fotosBase().slice(0, 40),
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
  } catch (err) { UI.aviso('No se pudo guardar la ficha: ' + err.message); }
}
async function borrarVersion(id) {
  const v = versiones.find(x => String(x.id) === id);
  if (!v || !(await UI.confirmar({ titulo: `¿Borrar ${nombrePdf(v)}.pdf?`,
    texto: 'Se pierden sus datos propios: precio, fotos y textos de esta ficha. La General no cambia.',
    verbo: 'Borrar', peligro: true }))) return;
  try {
    await API.del(`/versiones/${id}`);
    versiones = versiones.filter(x => String(x.id) !== id);
    if (versionSel === id) versionSel = null;
    render();
  } catch (err) { UI.aviso('No se pudo borrar: ' + err.message); }
}

// Los datos de una propiedad propia (tipo, municipio, fotos, liga del mapa) viven en
// la ficha y la página los lee de vuelta como si fueran un anuncio: tras guardar se
// vuelve a pedir, para que el mosaico y la banda digan lo que se acaba de escribir.
// Al guardar la liga del mapa la API le saca la coordenada (resolver_mapa en main.py):
// la respuesta ya trae lat/lng y el pin aparece solo.
async function saveBase(field, crudo) {
  if (!ficha) return;
  let patch;
  if (field === 'fotos') patch = { fotos: crudo };
  else if (field === 'precio_m2') patch = { precio_m2: crudo === '' ? null : Number(crudo) };
  else patch = { [field]: crudo.trim() === '' ? null : crudo.trim() };
  if (JSON.stringify(patch[field]) === JSON.stringify(ficha[field] ?? null)) return;
  try {
    Object.assign(ficha, numeros(await API.patch(`/fichas/${ficha.id}`, patch)));
    listing = Anuncio.de(await API.get(`/listings/${encodeURIComponent(listing.id)}`));
    repintar();
    pintarUbicacion();
  } catch (err) { UI.aviso('No se pudo guardar: ' + err.message); }
}

// ── Contacto del inmueble ────────────────────────────────────────────────────
// De quién tenemos el terreno o el local: el dueño o su asesor (`ficha.contactos`). Es
// del equipo y no sale en el PDF ni en el modo presentación. Como los documentos, cuelga
// de la ficha: agregar el primero a un anuncio lo guarda en el Catálogo.
const ROLES_CTO = [['dueno', 'Dueño'], ['asesor', 'Asesor']];
function waHtml(telefono) {
  const d = String(telefono ?? '').replace(/\D/g, '');
  return d.length >= 10
    ? `<a class="fx-btn" href="https://wa.me/${d.length === 10 ? '52' + d : d}" target="_blank" rel="noopener">WhatsApp</a>` : '';
}
const contactosDelDom = () => [...document.querySelectorAll('#ctoCard .fx-cto')].map(f =>
  Object.fromEntries([...f.querySelectorAll('.cto-in')].map(el => [el.dataset.k, el.value.trim()])));
async function guardarContactos(lista, repinta) {
  try {
    await asegurarFicha();
    Object.assign(ficha, numeros(await API.patch(`/fichas/${ficha.id}`, { contactos: lista })));
    if (repinta) render();
  } catch (err) { UI.aviso('No se pudo guardar el contacto: ' + err.message); }
}

// ── Fotos de una propiedad propia ────────────────────────────────────────────
// `ficha.fotos` es una lista de ligas. Una foto puede ser la liga de una imagen que ya
// está en internet o un archivo que se sube aquí (queda como `/api/archivos/<id>`): se
// elige del equipo, se arrastra sobre las miniaturas o se pega con Ctrl+V —la captura
// de pantalla que se acaba de tomar—. La primera es la portada. Lo que comparte con
// clientes.html —la caja, sus eventos y el flujo de subida— está en fotos.js.
// Las fotos que se están editando: las de la versión cargada o las de la ficha. Una
// versión de antes del 2026-10-08 no trae lista propia: enseña las de la propiedad
// hasta que se le cambia algo, y en ese momento se queda con su copia.
const versionActual = () => versiones.find(x => String(x.id) === versionSel) ?? null;
const fotosBase = () => (ficha?.fotos?.length ? ficha.fotos : listing?.fotos) ?? [];
const fotosEnEdicion = () => { const v = versionActual(); return (v ? (v.datos.fotos ?? fotosBase()) : (ficha?.fotos ?? [])).slice(); };
async function refrescarFotos() {
  listing = Anuncio.de(await API.get(`/listings/${encodeURIComponent(listing.id)}`));
  repintar();
}
// Quitar, poner de portada o agregar una liga: todo es guardar la lista nueva. La API
// borra el archivo de una foto subida que ya no esté en ella.
async function guardarFotos(lista) {
  const v = versionActual();
  if (!v) return saveBase('fotos', lista);
  try { Object.assign(v, await API.patch(`/versiones/${v.id}`, { datos: { ...v.datos, fotos: lista } })); }
  catch (err) { UI.aviso('No se pudo guardar la ficha: ' + err.message); }
  repintar();
}
// De quién son las fotos de la caja (ver fotos.js): de la versión cargada o de la ficha.
function destinoFotos() {
  if (!ficha) return null;
  const v = versionActual();
  return {
    fotos: fotosEnEdicion,
    guardar: guardarFotos,
    // La API agrega al final de la lista de la versión: si todavía no tiene la suya,
    // primero se queda con la copia de las de la propiedad.
    preparar: async () => {
      if (v && !v.datos.fotos) Object.assign(v, await API.patch(`/versiones/${v.id}`, { datos: { ...v.datos, fotos: fotosBase().slice(0, 40) } }));
    },
    subir: async archivo => v ? Object.assign(v, await API.subir(`/versiones/${v.id}/fotos`, archivo))
                              : Object.assign(ficha, numeros(await API.subir(`/fichas/${ficha.id}/fotos`, archivo))),
    alEmpezar: n => { subiendo.fotos = n; repintar(); },
    alTerminar: () => { subiendo.fotos = 0; return v ? repintar() : refrescarFotos().catch(err => console.warn(err.message)); },
  };
}
Fotos.escuchar(document.getElementById('detail'), destinoFotos);

async function guardarEnInmobiliaria() {
  try { await asegurarFicha(); render(); }
  catch (err) { UI.aviso('No se pudo guardar en el Catálogo: ' + err.message); }
}
// Lo contrario. Un anuncio de portal vuelve a la Bolsa y la página sigue sirviendo; una
// propiedad propia ES su ficha, así que al borrarla ya no hay nada que mostrar.
async function quitarDeInmobiliaria() {
  const propia = esPropia(listing), n = procesos.length;
  if (!(await UI.confirmar({
    titulo: propia ? '¿Eliminar esta propiedad?' : '¿Quitar esta propiedad del Catálogo?',
    texto: 'Se borra su ficha con sus documentos, fotos subidas y fichas PDF'
      + (n ? `, y lo presentado a ${n} ${n === 1 ? 'cliente' : 'clientes'}` : '') + '. No se puede deshacer.'
      + (propia ? '' : '\n\nEl anuncio vuelve a la Bolsa.'),
    verbo: propia ? 'Eliminar' : 'Quitar', peligro: true }))) return;
  try {
    await API.quitarDeInmobiliaria(listing.id);
    if (propia) { location.replace('index.html?tab=inmobiliaria'); return; }
    ficha = null; versiones = []; versionSel = null; procesos = []; documentos = [];
    render();
  } catch (err) { UI.aviso('No se pudo eliminar: ' + err.message); }
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
function mosaicoHtml(l) {
  const f = l.fotos;
  // Sin nombre accesible un lector anunciaba «botón» a secas: la foto es la imagen
  // decorativa (alt="") y el botón dice qué abre.
  const nombre = i => `aria-label="Ver foto ${i + 1} de ${f.length}: ${esc(l.titulo ?? 'la propiedad')}"`;
  const celda = (i, cls) => f[i]
    ? `<button class="fx-ph ${cls}" data-i="${i}" ${nombre(i)}><img src="${esc(f[i])}" alt="" loading="${i ? 'lazy' : 'eager'}"></button>`
    : `<span class="fx-ph ${cls} vacio"></span>`;
  return `<div class="fx-mosaic${f.length <= 1 ? ' uno' : ''}">
    ${celda(0, 'grande')}
    ${f.length > 1 ? [1, 2, 3].map(i => celda(i, '')).join('') +
      (f[4] ? `<button class="fx-ph" data-i="4" ${nombre(4)}><img src="${esc(f[4])}" alt="" loading="lazy">${f.length > 5 ? `<span class="fx-mas">Ver las ${f.length} fotos</span>` : ''}</button>` : '<span class="fx-ph vacio"></span>') : ''}
    <a class="fx-over fx-back" href="${esc(VOLVER.href)}">&#8592; ${VOLVER.texto}</a>
  </div>`;
}

// Anterior / siguiente en la página del tablero. Iba encima de la foto con forma de
// carrusel («1 / 70») y se leía como el contador de fotos: ahora va fuera, dice de qué
// cuenta y anuncia sus atajos.
function pasosHtml(nav) {
  if (!nav) return '';
  return `<nav class="fx-pasos" aria-label="Propiedades de la búsqueda">
    <button class="fx-paso" id="navPrev" ${nav.prev ? '' : 'disabled'}>&#8592; Anterior <kbd>K</kbd></button>
    <span class="fx-pasos-n">Propiedad ${nav.i + 1} de ${nav.n}<span class="fx-pasos-de"> en la página del tablero</span></span>
    <button class="fx-paso" id="navNext" ${nav.next ? '' : 'disabled'}>Siguiente <kbd>J</kbd> &#8594;</button>
  </nav>`;
}

function render() {
  const l = listing;
  const total = precioTotal(l), pm = ppm(l);
  const fuente = Anuncio.fuente(l.fuente);
  const sufijo = l.transaccion === 'Renta' ? `${Anuncio.moneda(l)}/mes` : Anuncio.moneda(l);
  const ofs = Anuncio.ofertas(l, opDelTablero());
  document.title = (l.titulo ?? 'Propiedad') + ' · OfficeLab';

  const ins = Anuncio.insignia(l), mercado = Anuncio.tiempoEnMercado(l);
  const facts = [
    ...superficies(l.terreno, l.construccion, l.size).map(([k, v]) => [k, m2Txt(v), k]),
    ...Anuncio.datos(l).map(d => [d.etiqueta, d.texto, d.clave]),
    pm ? ['Precio / m²', `$${mx(Math.round(pm))}`] : null,
    ins ? [ins.texto, ins.detalle] : null,
    mercado ? ['En el mercado', mercado] : null,
    l.tipo ? ['Tipo', cap(l.tipo)] : null,
    Anuncio.operacion(l) ? ['Operación', Anuncio.operacion(l)] : null,
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
  // Propiedad propia: sus datos y los de la ficha técnica van en un solo desplegable.
  const propia = esPropia(l) && !!ficha;
  const respDe = cid => { const c = clientes.find(x => String(x.id) === String(cid)); return c ? (c.responsable_nombre || c.responsable || null) : null; };

  document.getElementById('detail').innerHTML = `
    ${mosaicoHtml(l)}
    ${pasosHtml(nav)}
    <section class="fx-band">
      <div class="fx-band-t">
        <h1>${esc(l.titulo ?? 'Sin título')}</h1>
        <p>${[l.direccion, l.tipo && cap(l.tipo), Anuncio.operacion(l), l.codigo, fuente].filter(Boolean).map(esc).join(' · ')}
          ${mapsLink(l) ? ` · <a href="${hrefSeguro(mapsLink(l))}" target="_blank" rel="noopener">ver en mapa</a>` : ''}</p>
      </div>
      <div class="fx-band-p">
        ${ofs.length > 1 ? preciosDualHtml(l, ofs) : `
        <b>${total != null ? '$' + mx(Math.round(total)) : (l.porM2 && l.precio != null ? '$' + mx(l.precio) : 'Sin precio')}</b>
        <span>${total != null ? sufijo : (l.porM2 && l.precio != null ? 'por m²' : '')}${pm && total != null ? ` · $${mx(Math.round(pm))}/m²` : ''}</span>`}
      </div>
      ${!esPropia(l) && ficha ? '<span class="fx-tag" title="Tiene ficha: aparece en la pestaña Catálogo">En Catálogo</span>' : ''}
      <!-- Ocho acciones con el mismo peso competían entre sí: quedan a la vista el
           estado, destacar y WhatsApp; lo demás va en «Más». En el teléfono esta fila
           es una barra fija abajo (hermes.css). -->
      <div class="fx-acciones">
        <select class="fx-status s-${l.status}" id="detailStatus" aria-label="Estado">
          ${Anuncio.ESTADOS.map(s => `<option${s === l.status ? ' selected' : ''}>${s}</option>`).join('')}
        </select>
        <button class="fx-star${l.starred ? ' on' : ''}" id="detailStar" aria-pressed="${l.starred}" title="Destacar" aria-label="Destacar">${l.starred ? '&#9733;' : '&#9734;'}</button>
        ${l.whatsapp ? `<a class="fx-btn solid" href="https://wa.me/${l.whatsapp.replace(/\D/g, '')}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
        <details class="fx-mas-menu" id="fxMas">
          <summary class="fx-btn">&#8943; Más</summary>
          <div class="fx-mas-lista">
            ${l.url ? `<a class="fx-mas-item" href="${hrefSeguro(l.url)}" target="_blank" rel="noopener">Ver el anuncio ${ICON_EXTERNAL}</a>` : ''}
            <button class="fx-mas-item" id="btnPdf" title="Imprime ${esc(nombrePdf(vSel))}.pdf">Ficha PDF</button>
            <button class="fx-mas-item" id="mkt-pdf" title="Análisis de mercado de esta propiedad, para adjuntar a la propuesta">Análisis de mercado</button>
            ${esPropia(l) ? (ficha ? '<button class="fx-mas-item peligro" id="btnQuitar" title="Borra la propiedad con todo lo que cuelga de ella">Eliminar propiedad</button>' : '') : (ficha
              ? '<button class="fx-mas-item peligro" id="btnQuitar" title="Borra su ficha; el anuncio vuelve a la Bolsa">Quitar del Catálogo</button>'
              : '<button class="fx-mas-item" id="btnInmo" title="Guardarla en la bolsa propia, sin asignarla a nadie">+ Guardar en Catálogo</button>')}
          </div>
        </details>
      </div>
    </section>

    <div class="fx-cols${PRESENTA_A ? ' pres' : ''}">
      <section class="fx-card">
        <h2>Ficha</h2>
        <dl class="fx-facts">${facts.map(([k, v, ic]) => `<div><dt>${ic ? Iconos.de(ic, 12) : ''}${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
        ${l.descripcion ? `<p class="fx-desc">${esc(l.descripcion)}</p>` : ''}
        ${l.features.length ? `<ul class="fx-feat">${l.features.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
        <div class="fx-vers">
          <h2>Fichas PDF <span class="fx-n">${versionesVisibles().length + conGeneral()}</span></h2>
          ${conGeneral() ? `<div class="fx-ver${vSel ? '' : ' on'}">
            <button class="fx-ver-n" data-v="">Ficha-General.pdf</button>
            <small>${esPropia(l) ? 'Datos de la propiedad' : 'Datos del anuncio'}</small>
            <button class="fx-ver-pdf" data-v="" title="Imprimir o guardar como PDF">PDF</button>
          </div>` : ''}
          ${versionesVisibles().map(v => `<div class="fx-ver${String(v.id) === versionSel ? ' on' : ''}">
            <button class="fx-ver-n" data-v="${esc(v.id)}">${esc(nombrePdf(v))}.pdf</button>
            <small>${esc([v.autor, fechaCorta(v.updated_at)].filter(Boolean).join(' · '))}</small>
            <button class="fx-ver-pdf" data-v="${esc(v.id)}" title="Imprimir o guardar como PDF">PDF</button>
            ${PRESENTA_A ? '' : `<button class="fx-ver-del" data-v="${esc(v.id)}" title="Borrar esta ficha">&times;</button>`}
          </div>`).join('')}
          ${PRESENTA_A ? '' : `<select class="fx-asignar" id="verAdd" aria-label="Nueva ficha">
            <option value="">+ Nueva ficha para…</option>
            ${clientes.map(c => `<option value="${esc(c.id)}">${esc(c.nombre)}</option>`).join('')}
            <option value="__otro">Otro nombre…</option>
          </select>`}
        </div>
        <details class="fx-pdfdata" id="pdfData"${pdfAbierto || (propia && !(l.tipo && l.zona)) ? ' open' : ''}>
          <summary>${propia && !vSel ? 'Datos de la propiedad' : `Datos de ${esc(nombrePdf(vSel))}.pdf`}</summary>
          <label>Título<input class="ficha-in" data-f="titulo" value="${esc(d.titulo ?? tituloPdf(l))}"></label>
          <div class="fx-row">
            <label>Precio<input type="number" class="ficha-in" data-f="precio" value="${d.precio ?? (vSel ? '' : (total != null ? Math.round(total) : ''))}"></label>
            <label>Terreno m²<input type="number" class="ficha-in" data-f="tamano_m2" value="${d.tamano_m2 ?? (vSel ? '' : (l.size ?? ''))}" title="La superficie con la que se calcula el precio por m²"></label>
            <label>Construcción m²<input type="number" class="ficha-in" data-f="construccion_m2" value="${d.construccion_m2 ?? (vSel ? '' : (l.construccion && l.construccion !== l.size ? l.construccion : ''))}" placeholder="Si aplica"></label>
          </div>
          <label>ID<input class="ficha-in" data-f="folio" value="${esc(d.folio ?? '')}" placeholder="${esc(ficha?.folio || folioSugerido())}" title="Se asigna solo al crear la ficha: PR-fecha-número del día. Se puede cambiar."></label>
          <label>Descripción para el cliente<textarea class="ficha-in" data-f="notas" rows="4" placeholder="Si se deja vacía se usa la descripción ${propia ? 'de la propiedad' : 'del anuncio'}.">${esc(d.notas ?? '')}</textarea></label>
          ${vSel ? `<div class="fx-row">
            <label>Precio por m²<input type="number" class="ficha-in" data-f="precio_m2" value="${d.precio_m2 ?? ''}" placeholder="${d.precio && d.tamano_m2 ? Math.round(d.precio / d.tamano_m2) : 'Precio ÷ m²'}"></label>
          </div>
          ${fotosEdHtml(fotosEnEdicion())}
          <p class="fx-hint">El precio por m² y las fotos son sólo de esta ficha: no cambian las demás.</p>` : ''}
          ${propia ? `${vSel ? '<p class="fx-hint">Lo de abajo es de la propiedad: es igual en todas sus fichas.</p>' : ''}
          <div class="fx-row">
            <label>Tipo<input class="base-in" data-f="tipo" value="${esc(ficha.tipo ?? '')}" placeholder="Local, terreno…"></label>
            <label>Municipio<input class="base-in" data-f="municipio" value="${esc(ficha.municipio ?? '')}"></label>
            ${vSel ? '' : `<label>Precio por m²<input type="number" class="base-in" data-f="precio_m2" value="${ficha.precio_m2 ?? ''}"></label>`}
          </div>
          <div class="fx-row">
            <label>Operación<select class="base-in" data-f="operacion">
              ${[['', 'Sin definir'], ['sale', 'Venta'], ['rent', 'Renta']].map(([v, t]) => `<option value="${v}"${(ficha.operacion ?? '') === v ? ' selected' : ''}>${t}</option>`).join('')}
            </select></label>
            <label>Moneda del precio<select class="base-in" data-f="moneda">
              ${[['MXN', 'Pesos (MXN)'], ['USD', 'Dólares (USD)']].map(([v, t]) => `<option value="${v}"${(ficha.moneda ?? 'MXN') === v ? ' selected' : ''}>${t}</option>`).join('')}
            </select></label>
          </div>
          <label>Liga del mapa<input class="base-in" data-f="mapa_url" value="${esc(ficha.mapa_url ?? '')}" placeholder="https://maps.app.goo.gl/…"></label>
          ${vSel ? '' : fotosEdHtml(fotosEnEdicion())}` : ''}
        </details>
      </section>

      ${/* Columna de enmedio: documentos y, debajo, el contacto del inmueble. Van en una
           pila para que la tercera columna siga siendo la de clientes. */''}
      <div class="fx-stack">
      <section class="fx-card" id="docsCard">
        <h2>Documentos <span class="fx-n">${hechos} / ${documentos.length}</span></h2>
        ${documentos.length ? `<div class="fx-prog"><span style="width:${Math.round(hechos / documentos.length * 100)}%"></span></div>` : ''}
        <div class="fx-docs">
          ${documentos.map(d => `<div class="fx-doc${d.done ? ' done' : ''}" data-id="${esc(d.id)}">
            <label><input type="checkbox" class="doc-chk" data-id="${d.id}"${d.done ? ' checked' : ''}><span>${esc(d.label)}</span></label>
            <button class="doc-clip" data-id="${d.id}" title="Adjuntar uno o varios archivos a este documento">Adjuntar</button>
            <button class="doc-del" data-id="${d.id}" title="Quitar">&times;</button></div>
            ${(d.archivos ?? []).map(a => `<div class="fx-file">
              <a href="/api/archivos/${encodeURIComponent(a.id)}" target="_blank" rel="noopener" title="Abrir o descargar">${esc(a.nombre)}</a>
              <small>${pesoTxt(a.tamano)}</small>
              <button class="file-del" data-id="${esc(a.id)}" title="Borrar archivo">&times;</button></div>`).join('')}`).join('')
            || '<p class="fx-hint">Sin documentos todavía.</p>'}
        </div>
        <div class="fx-add">
          <input class="doc-input" placeholder="+ Agregar documento (predial, planos…)">
          <button class="doc-file" title="Elegir uno o varios archivos. Con nombre escrito van a ese documento; sin nombre, cada archivo es un documento.">Archivos&#8230;</button>
          <button class="doc-add">Agregar</button>
        </div>
        <p class="fx-hint">${subiendo.docs ? `Subiendo ${subiendo.docs} ${subiendo.docs === 1 ? 'archivo' : 'archivos'}&#8230;`
          : 'Puedes arrastrar archivos aquí: PDF, imágenes, Word, Excel… hasta 20 MB cada uno.'}</p>
        <input type="file" id="docFile" multiple hidden>
      </section>

      ${PRESENTA_A ? '' : `<section class="fx-card" id="ctoCard">
        <h2>Contacto <span class="fx-n">de quién tenemos el inmueble</span></h2>
        ${(ficha?.contactos ?? []).map((c, i) => `<div class="fx-cto" data-i="${i}">
            <select class="cto-in" data-k="rol" aria-label="Dueño o asesor">
              ${ROLES_CTO.map(([v, t]) => `<option value="${v}"${(c.rol ?? 'dueno') === v ? ' selected' : ''}>${t}</option>`).join('')}
            </select>
            <input class="cto-in" data-k="nombre" value="${esc(c.nombre ?? '')}" placeholder="Nombre" aria-label="Nombre">
            <button class="cto-del" title="Quitar contacto">&times;</button>
            <input class="cto-in" data-k="telefono" value="${esc(c.telefono ?? '')}" placeholder="Teléfono" inputmode="tel" aria-label="Teléfono">
            <input class="cto-in" data-k="correo" value="${esc(c.correo ?? '')}" placeholder="Correo" type="email" aria-label="Correo">
            <span class="cto-wa">${waHtml(c.telefono)}</span>
          </div>`).join('') || `<p class="fx-hint">Sin contacto todavía.${ficha ? '' : ' Al agregar uno, la propiedad se guarda en el Catálogo.'}</p>`}
        <div class="fx-add">
          <button class="cto-add" data-rol="dueno">+ Dueño</button>
          <button class="cto-add" data-rol="asesor">+ Asesor</button>
        </div>
      </section>`}
      </div>

      ${PRESENTA_A ? '' : `<div class="fx-stack">
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
      </div>`}
    </div>`;
  enlazar();
}

// La caja de fotos del formulario (fotos.js).
const fotosEdHtml = fotos => Fotos.caja(fotos, { subiendo: subiendo.fotos });

function enlazar() {
  const $ = id => document.getElementById(id);
  $('detailStar').onclick = () => { setState({ starred: !listing.starred }); render(); };
  $('detailStatus').onchange = e => { setState({ status: e.target.value }); e.target.className = `fx-status s-${e.target.value}`; };
  $('detailNotes') && ($('detailNotes').onblur = e => setState({ notes: e.target.value }));
  $('btnPdf').onclick = () => imprimirFicha(versionSel);
  $('btnInmo') && ($('btnInmo').onclick = guardarEnInmobiliaria);
  $('btnQuitar') && ($('btnQuitar').onclick = quitarDeInmobiliaria);
  $('pdfData').ontoggle = e => { pdfAbierto = e.target.open; };
  // Una ficha guardada: su nombre la carga en el formulario; "PDF" la imprime.
  document.querySelectorAll('.fx-ver-n').forEach(b => b.onclick = () => { versionSel = b.dataset.v || null; pdfAbierto = true; render(); });
  document.querySelectorAll('.fx-ver-pdf').forEach(b => b.onclick = () => imprimirFicha(b.dataset.v || null));
  document.querySelectorAll('.fx-ver-del').forEach(b => b.onclick = () => borrarVersion(b.dataset.v));
  $('verAdd') && ($('verAdd').onchange = e => {
    const v = e.target.value;
    e.target.value = '';
    if (v === '__otro') return crearVersion(prompt('Nombre de la ficha (sale como Ficha-<nombre>.pdf):'));
    const c = clientes.find(x => String(x.id) === v);
    if (c) crearVersion(c.nombre, c.id);
  });
  document.querySelectorAll('.base-in').forEach(el => el.onchange = e => saveBase(e.target.dataset.f, e.target.value));
  $('mkt-pdf').onclick = e => descargarAnalisis(e.currentTarget);
  // «Más» se cierra al elegir algo, salvo el análisis, que dice «Generando…» en su botón.
  $('fxMas').onclick = e => {
    if (e.target.closest('.fx-mas-item') && !e.target.closest('#mkt-pdf')) $('fxMas').open = false;
  };
  $('navPrev') && ($('navPrev').onclick = () => irA(vecinos()?.prev));
  $('navNext') && ($('navNext').onclick = () => irA(vecinos()?.next));
  $('procAdd') && ($('procAdd').onchange = e => addProceso(e.target.value));
  document.querySelectorAll('.fx-ph[data-i]').forEach(b => b.onclick = () => abrirVisor(+b.dataset.i));
  document.querySelectorAll('.ficha-in').forEach(el => el.onblur = e => saveFicha(e.target.dataset.f, e.target.value));
  // Contacto del inmueble. Editar un campo guarda sin repintar (repintar le quitaría
  // el foco al campo siguiente); agregar y quitar sí repintan.
  document.querySelectorAll('.cto-add').forEach(b => b.onclick = () =>
    guardarContactos([...contactosDelDom(), { rol: b.dataset.rol }], true));
  document.querySelectorAll('.cto-del').forEach(b => b.onclick = async () => {
    const i = +b.closest('.fx-cto').dataset.i, c = contactosDelDom()[i];
    if ((c.nombre || c.telefono || c.correo)
        && !(await UI.confirmar({ titulo: `¿Quitar a ${c.nombre || 'este contacto'}?`, verbo: 'Quitar', peligro: true }))) return;
    guardarContactos(contactosDelDom().filter((_, k) => k !== i), true);
  });
  document.querySelectorAll('.cto-in').forEach(el => el.onchange = () => {
    const fila = el.closest('.fx-cto');
    fila.querySelector('.cto-wa').innerHTML = waHtml(fila.querySelector('[data-k="telefono"]').value);
    guardarContactos(contactosDelDom(), false);
  });
  document.querySelector('.doc-add').onclick = () => addDocumento(document.querySelector('.doc-input').value);
  document.querySelector('.doc-input').onkeydown = e => { if (e.key === 'Enter') addDocumento(e.target.value); };
  document.querySelectorAll('.doc-chk').forEach(c => c.onchange = e => toggleDocumento(e.target.dataset.id, e.target.checked));
  document.querySelectorAll('.doc-del').forEach(b => b.onclick = e => removeDocumento(e.currentTarget.dataset.id));
  // Archivos de los documentos. Un solo <input type=file> para todos: `docDestino`
  // dice a qué documento van (null: son documentos nuevos).
  const docFile = $('docFile');
  let docDestino = null;
  docFile.onchange = () => subirDocumentos(docFile.files,
    docDestino ? { docId: docDestino } : { label: document.querySelector('.doc-input').value });
  document.querySelectorAll('.doc-clip').forEach(b => b.onclick = () => { docDestino = b.dataset.id; docFile.click(); });
  document.querySelector('.doc-file').onclick = () => { docDestino = null; docFile.click(); };
  document.querySelectorAll('.file-del').forEach(b => b.onclick = () => removeArchivo(b.dataset.id));
  soltarArchivos($('docsCard'), (files, e) =>
    subirDocumentos(files, { docId: e.target.closest('.fx-doc')?.dataset.id ?? null }));
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
      } catch (err) { UI.aviso('No se pudo guardar la ubicación: ' + err.message); }
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

// ── La propiedad: sus anuncios y los que se le parecen ───────────────────────
// Un inmueble se anuncia varias veces y el tablero lo enseña como una sola tarjeta.
// Aquí se ve qué hay detrás y se corrige: «Separar» saca un anuncio que no era, «Es el
// mismo» junta uno que el agrupador sólo se atrevió a sugerir. Las propias (pipeline)
// no son anuncios de portal y no tienen esta sección.
async function cargarPropiedad() {
  const caja = document.getElementById('propiedad');
  if (listing.id.startsWith('pipeline:')) return;
  pintarPropiedad(caja, await Propiedad.de(listing.id));
}

function pintarPropiedad(caja, p) {
  const varios = p.anuncios.length > 1;
  if (!varios && !p.sugerencias.length && !p.separado) { caja.hidden = true; return; }
  const anunciantes = new Set(p.anuncios.map(a => (a.broker_name ?? '').toLowerCase())).size;
  const propios = !varios ? '' : `
    <h2>Anuncios de esta propiedad <span class="fx-n">${p.anuncios.length} anuncios${anunciantes > 1 ? ` · ${anunciantes} anunciantes` : ''}</span></h2>
    <p class="fx-hint">Están fusionados en una sola tarjeta del tablero${p.motivo ? `: ${esc(Propiedad.motivo(p.motivo))}` : ''}.
      Si alguno no es este inmueble, sepáralo.</p>
    ${p.anuncios.map(a => Propiedad.fila(a,
        `<button class="fx-btn" data-separa="${esc(a.id)}">Separar</button>`,
        a.id === listing.id ? 'este anuncio' : '')).join('')}`;
  const aviso = !varios && p.separado
    ? '<h2>Anuncios de esta propiedad</h2><p class="fx-hint">Este anuncio se separó a mano: no se fusiona solo con ningún otro. Para volver a juntarlo, selecciónalo en el tablero junto con el otro y usa «Fusionar».</p>' : '';
  const parecidos = !p.sugerencias.length ? '' : `
    <h2>Posibles duplicados <span class="fx-n">se parecen, pero no se fusionaron solos</span></h2>
    ${p.sugerencias.map(s => Propiedad.fila(s.anuncio,
        `<button class="fx-btn solid" data-igual="${esc(s.anuncio.id)}">Es el mismo</button>
         <button class="fx-btn" data-distinto="${esc(s.anuncio.id)}" data-de="${esc(s.de)}">No es el mismo</button>`,
        Propiedad.senal(s.senal))).join('')}`;
  caja.innerHTML = `<div class="fx-card">${propios}${aviso}${parecidos}</div>`;
  caja.hidden = false;
}

document.getElementById('propiedad').addEventListener('click', async e => {
  const b = e.target.closest('[data-separa], [data-igual], [data-distinto]');
  if (!b) return;
  const caja = document.getElementById('propiedad');
  b.disabled = true;
  try {
    if (b.dataset.separa) await Propiedad.separar(b.dataset.separa);
    else if (b.dataset.igual) await Propiedad.fusionar([listing.id, b.dataset.igual]);
    else await Propiedad.descartar(b.dataset.de, b.dataset.distinto);
    pintarPropiedad(caja, await Propiedad.de(listing.id));
  } catch (err) {
    b.disabled = false;
    UI.aviso(`No se pudo guardar: ${err.message}`);
  }
});

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
// «Más» se cierra al tocar fuera o con Escape, como cualquier menú.
document.addEventListener('click', e => {
  const m = document.getElementById('fxMas');
  if (m?.open && !m.contains(e.target)) m.open = false;
});
document.addEventListener('keydown', e => {
  const m = document.getElementById('fxMas');
  if (e.key === 'Escape' && m?.open) { m.open = false; m.querySelector('summary').focus(); return; }
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
// El ID lo asigna la API al crear la ficha (PR-<fecha de alta>-<n del día>). Esto sólo
// queda para el PDF de un anuncio que todavía no tiene ficha.
function folioSugerido() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `PR-${p(d.getDate())}${p(d.getMonth() + 1)}${String(d.getFullYear()).slice(2)}-1`;
}

// El segundo precio de un inmueble en renta Y venta, bajo el primero. Si la ficha o la
// versión fijó su propio precio, ése manda y el del portal no se agrega.
function segundaPdf(l, f) {
  const o = f.precio == null ? Anuncio.ofertas(l)[1] : null;
  if (!o?.op || o.monto == null || o.parcial) return '';
  const mon = Anuncio.moneda(l) === 'MXN' ? '' : ' ' + Anuncio.moneda(l);
  return `<div class="pr-precio"><b>$${mx(Math.round(o.monto))}${mon}</b><span>EN ${o.op.toUpperCase()}</span></div>`;
}

function imprimirFicha(versionId) {
  const v = versiones.find(x => String(x.id) === versionId) ?? null;
  // Lo que la versión trae pisa a la ficha, fotos y precio por m² incluidos.
  const l = listing, f = { ...(ficha ?? {}), ...(v?.datos ?? {}) }, cfg = window.OL_CONFIG ?? {}, u = currentUser ?? {};
  const precio = f.precio ?? precioTotal(l);
  const m2 = f.tamano_m2 ?? l.size;
  // Construcción: la de la ficha o versión; si no, la del anuncio cuando la distingue.
  const constr = f.construccion_m2 ?? (l.construccion && l.construccion !== m2 ? l.construccion : null);
  const pm = v?.datos.precio_m2 ?? (precio && m2 ? precio / m2 : ppm(l));
  const fotos = v?.datos.fotos ?? (f.fotos?.length ? f.fotos : l.fotos);
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
      <div class="pr-precio"><b>${precio != null ? '$' + mx(Math.round(precio)) + (Anuncio.moneda(l) === 'MXN' ? '' : ' ' + Anuncio.moneda(l)) : 'Precio a consultar'}</b><span>${{ Venta: 'EN VENTA', Renta: 'EN RENTA' }[l.transaccion] ?? ''}</span></div>
      ${segundaPdf(l, f)}
      ${l.direccion ? `<div class="pr-colonia">${esc(l.direccion)}.</div>` : ''}
      <h1 class="pr-titulo">${esc((f.titulo ?? tituloPdf(l)).toUpperCase())}</h1>
      ${fotos[0] ? `<img class="pr-foto" src="${esc(fotos[0])}" alt="">` : ''}
      <div class="pr-datos${constr ? ' cuatro' : ''}">
        <div><span>Precio x m²</span><b>${pm ? '$' + mx(Math.round(pm)) : '—'}</b></div>
        <div><span>${constr ? 'Terreno' : esc(cap(l.tipo ?? 'Superficie'))}</span><b>${m2 ? mx(Math.round(m2)) + ' m²' : '—'}</b></div>
        ${constr ? `<div><span>Construcción</span><b>${mx(Math.round(constr))} m²</b></div>` : ''}
        <div><span>ID</span><b>${esc(f.folio || ficha?.folio || folioSugerido())}</b></div>
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
  listing = Anuncio.de(await API.get(`/listings/${encodeURIComponent(id)}`));
  await loadFicha();
  await Promise.all([loadSeguimiento(), loadDocumentos()]);
  render();
  pintarUbicacion();
  // Aparte y sin await: el análisis tarda ~400 ms y la ficha no tiene por qué
  // esperarlo, ni caerse si falla.
  cargarMercado().catch(err => console.error(err));
  cargarPropiedad().catch(err => console.error(err));
}).catch(err => {
  console.error(err);
  document.getElementById('detail').innerHTML = `<p class="pg-empty">No se pudo cargar esta propiedad.<br>${esc(err.message)}</p>`;
});

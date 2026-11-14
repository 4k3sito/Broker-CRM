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
           : { href: TABLERO, texto: 'Volver al tablero', tablero: true };
})();
// La ficha se abre en otra pestaña desde el tablero. Volver es cerrarla y regresar a la
// pestaña del tablero, que sigue como se dejó. Si el navegador no deja cerrarla (se
// navegó dentro de ella) o el tablero ya no está, el enlace abre el tablero con la
// búsqueda en su URL (`ol-tablero`).
document.addEventListener('click', e => {
  if (!VOLVER.tablero || !e.target.closest('.fx-back') || e.metaKey || e.ctrlKey) return;
  let tablero = null;
  try { tablero = window.opener && !window.opener.closed && /\/(index\.html)?$/.test(window.opener.location.pathname) ? window.opener : null; } catch { /* otro origen */ }
  if (!tablero) return;
  e.preventDefault();
  tablero.focus();
  window.close();
  setTimeout(() => { location.href = VOLVER.href; }, 150);   // si no se cerró
});
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
// El CRM (ficha, documentos, clientes) se pide aparte de la propiedad para pintar ésta
// sin esperarlo: 'cargando' | 'ok' | 'error'. Sin saber si hay ficha no se ofrece «Guardar
// en Catálogo» ni nada que la cree: un fallo de red no es «esta propiedad no tiene ficha».
let crm = 'cargando', crmError = '';
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

// ── Estado del usuario ───────────────────────────────────────────────────────
const rutaEstado = id => `/listings/${encodeURIComponent(id)}/estado`;
// Manda SÓLO lo que cambió: la API deja intacto lo que no viene (COALESCE). Antes iban los
// tres campos desde la copia que esta pestaña tenía al abrirse, y destacar aquí pisaba la
// nota que se hubiera escrito después en otra pestaña. Optimista: la pantalla ya muestra
// el valor nuevo; si el servidor no lo acepta se deshace y se avisa.
// Destacar sólo repinta su botón: render() completo reescribe la página y se pierde el foco,
// el cursor de las notas y el scroll.
function pintarEstrella() {
  const b = document.getElementById('detailStar');
  if (!b) return;
  b.classList.toggle('on', !!listing.starred);
  b.setAttribute('aria-pressed', String(!!listing.starred));
  b.textContent = listing.starred ? '\u2605' : '\u2606';
}
const destacar = () => { guardarEstado({ starred: !listing.starred }, 'el destacado').catch(() => {}); pintarEstrella(); };
function guardarEstado(patch, que = 'el estado') {
  const antes = Object.fromEntries(Object.keys(patch).map(k => [k, listing[k]]));
  Object.assign(listing, patch);
  const cuerpo = {};
  if ('status' in patch) cuerpo.status = Anuncio.estadoApi(patch.status);
  if ('starred' in patch) cuerpo.starred = patch.starred;
  return UI.guardar(API.put(rutaEstado(listing.id), cuerpo), {
    que, revertir: () => { Object.assign(listing, antes); if (Object.keys(patch).every(k => k === 'starred')) pintarEstrella(); else render(); },
  });
}

// ── Notas internas ───────────────────────────────────────────────────────────
// Se guardan solas: ~800 ms después de la última tecla, al salir del campo y, con
// keepalive, si se cierra la pestaña con algo sin enviar. Antes sólo se guardaban al salir
// del campo, sin decirlo y sin reintento: lo escrito se perdía en silencio si fallaba.
// `pend` es el texto que el servidor aún no tiene (null si no hay nada pendiente); sobrevive
// a render(), que reescribe el textarea.
const notas = { pend: null, est: '', timer: 0, enVuelo: false, repetir: false };
function notasEstado(est) {
  notas.est = est;
  const el = document.getElementById('notasEst');
  if (!el) return;
  el.classList.toggle('error', est === 'error');
  el.innerHTML = { guardando: 'Guardando…', guardado: 'Guardado', pendiente: 'Sin guardar' }[est]
    ?? (est === 'error' ? 'No se guardó · <button type="button" class="fx-reintento" id="notasRe">Reintentar</button>' : '');
  el.querySelector('#notasRe')?.addEventListener('click', guardarNotas);
}
async function guardarNotas() {
  clearTimeout(notas.timer);
  if (notas.pend == null) return;
  // Un guardado a la vez: dos en vuelo podrían llegar al revés y dejar el texto viejo.
  if (notas.enVuelo) { notas.repetir = true; return; }
  const texto = notas.pend;
  notas.enVuelo = true;
  notasEstado('guardando');
  try {
    await UI.guardar(API.put(rutaEstado(listing.id), { notes: texto }), { que: 'las notas' });
    listing.notes = texto;
    // Si se siguió escribiendo mientras tanto, queda pendiente y el siguiente guardado lo cubre.
    if (notas.pend === texto) { notas.pend = null; notasEstado('guardado'); }
  } catch { notasEstado('error'); }
  notas.enVuelo = false;
  if (notas.repetir) { notas.repetir = false; guardarNotas(); }
}
// Al cerrar o ocultar la pestaña no hay tiempo de esperar respuesta: keepalive deja que el
// navegador termine el envío aunque la página ya no esté.
function enviarNotasPendientes() {
  if (notas.pend == null || !listing) return;
  API.put(rutaEstado(listing.id), { notes: notas.pend }, { keepalive: true }).catch(() => {});
}
addEventListener('pagehide', enviarNotasPendientes);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') enviarNotasPendientes(); });

// ── Ficha, seguimiento y documentos ──────────────────────────────────────────
// Nada de esto convierte un fallo en «no hay datos»: si una petición falla, el error sube a
// cargarCrm y la página dice que no pudo cargar, con «Reintentar».
const pedirClientes = async () => (await API.get('/clientes')).sort((a, b) => a.nombre.localeCompare(b.nombre));
const pedirProcesos = async f => (await API.get(`/procesos?ficha_id=${f.id}`))
  .map(p => ({ ...p, cliente: { nombre: p.cliente_nombre } }));
const pedirDocumentos = f => API.get(`/documentos?ficha_id=${f.id}`);
async function loadSeguimiento() {
  [clientes, procesos] = await Promise.all([pedirClientes(), ficha ? pedirProcesos(ficha) : []]);
}
// La ficha y los clientes en paralelo; con la ficha en mano, sus versiones, procesos y
// documentos también en paralelo. Antes eran tres rondas en serie tras la propiedad.
async function cargarCrm() {
  crm = 'cargando'; crmError = '';
  if (listing) render();
  try {
    const [fs, cs] = await Promise.all([API.get(`/fichas?listing=${encodeURIComponent(listing.id)}`), pedirClientes()]);
    const f = fs[0] ?? null;
    const [vs, ps, ds] = f ? await Promise.all([API.get(`/fichas/${f.id}/versiones`), pedirProcesos(f), pedirDocumentos(f)]) : [[], [], []];
    ficha = f; versiones = vs; clientes = cs; procesos = ps; documentos = ds;
    versionSel = null;
    if (!conGeneral()) versionSel = String(versionesVisibles()[0].id);
    crm = 'ok';
  } catch (err) { crm = 'error'; crmError = err.message; }
  render();
}
async function loadDocumentos() { documentos = ficha ? await pedirDocumentos(ficha) : []; }
// Documentos y clientes cuelgan de la ficha: se crea sola la primera vez que hace falta,
// y eso saca la propiedad de la Bolsa: se dice.
async function asegurarFicha() {
  if (ficha) return ficha;
  if (crm !== 'ok') throw new Error('todavía no se carga el seguimiento de la propiedad.');
  ficha = await API.post('/fichas', {
    source_listing_id: listing.id, titulo: listing.titulo, precio: precioTotal(listing),
    moneda: listing.moneda, tamano_m2: listing.size, fotos: listing.fotos,
  });
  if (!esPropia(listing)) UI.aviso('Guardada en el Catálogo.');
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
  const p = procesos.find(x => String(x.id) === String(id)), antes = p?.status;
  if (p) p.status = status;
  UI.guardar(API.patch(`/procesos/${id}`, { status }), {
    que: 'la etapa', revertir: () => { if (p) p.status = antes; render(); },
  }).catch(() => {});
}
// Igual que en Clientes: quitar la propuesta pierde su estado, junta y notas con ese cliente.
async function removeProceso(id) {
  const p = procesos.find(x => String(x.id) === String(id));
  if (!(await UI.confirmar({ titulo: `¿Quitar a ${p?.cliente?.nombre ?? 'este cliente'} de esta propiedad?`,
    texto: 'Se pierden su estado, junta y notas con este cliente. La propiedad sigue en el Catálogo.',
    verbo: 'Quitar', peligro: true }))) return;
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
    UI.guardar(API.patch(`/documentos/${d.id}`, { done: true }), {
      que: 'el documento como conseguido', revertir: () => { d.done = false; render(); },
    }).catch(() => {});
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
// Marcar un documento sólo toca su fila, el contador y la barra: render() completo
// reescribiría la tarjeta y quitaría el foco del casillero.
function pintarDocumentos() {
  const hechos = documentos.filter(d => d.done).length;
  for (const d of documentos) {
    const fila = document.querySelector(`.fx-doc[data-id="${CSS.escape(String(d.id))}"]`);
    if (!fila) continue;
    fila.classList.toggle('done', !!d.done);
    const chk = fila.querySelector('.doc-chk');
    if (chk) chk.checked = !!d.done;
  }
  const n = document.querySelector('#docsCard h2 .fx-n');
  if (n) n.textContent = `${hechos} / ${documentos.length}`;
  const barra = document.querySelector('#docsCard .fx-prog span');
  if (barra && documentos.length) barra.style.width = `${Math.round(hechos / documentos.length * 100)}%`;
}
function toggleDocumento(id, done) {
  const d = documentos.find(x => String(x.id) === String(id));
  if (d) d.done = done;
  UI.guardar(API.patch(`/documentos/${id}`, { done }), {
    que: 'el documento', revertir: () => { if (d) d.done = !done; pintarDocumentos(); },
  }).catch(() => {});
  pintarDocumentos();
}
async function removeDocumento(id) {
  const n = documentos.find(x => String(x.id) === String(id))?.archivos?.length ?? 0;
  if (n && !(await UI.confirmar({ titulo: `¿Borrar el documento con ${n === 1 ? 'su archivo' : `sus ${n} archivos`}?`,
    texto: `Tiene ${n} ${n === 1 ? 'archivo adjunto' : 'archivos adjuntos'}. No se puede deshacer.`,
    verbo: 'Borrar', peligro: true }))) return;
  try { await API.del(`/documentos/${id}`); documentos = documentos.filter(x => String(x.id) !== String(id)); render(); }
  catch (err) { UI.aviso('No se pudo quitar el documento: ' + err.message); }
}
// Indicador de «Datos de la ficha» (mismo texto que el de las notas). `campos` guarda lo
// que se escribió en los campos que no se pudieron guardar, para dejarlos marcados
// (aria-invalid) con su texto en vez de volver al valor viejo como si nada.
const fichaEst = { est: '', ver: null, campos: new Map() };
function fichaFallos() {
  if (fichaEst.ver !== versionSel) { fichaEst.ver = versionSel; fichaEst.campos.clear(); }
  return fichaEst.campos;
}
function pintarFichaEstado() {
  const el = document.getElementById('fichaEst');
  if (!el) return;
  el.classList.toggle('error', fichaEst.est === 'error');
  el.innerHTML = { guardando: 'Guardando…', guardado: 'Guardado' }[fichaEst.est]
    ?? (fichaEst.est === 'error' ? 'No se guardó · <button type="button" class="fx-reintento" id="fichaRe">Reintentar</button>' : '');
  el.querySelector('#fichaRe')?.addEventListener('click', () => {
    for (const [f, v] of [...fichaFallos()]) saveFicha(f, v);
  });
}
// `restaurar`: tras un render(), los campos fallidos vuelven a mostrar lo que se escribió.
function pintarFichaCampos(restaurar = false) {
  const mal = fichaFallos();
  document.querySelectorAll('#pdfData .ficha-in').forEach(el => {
    if (mal.has(el.dataset.f)) {
      if (restaurar) el.value = mal.get(el.dataset.f);
      el.setAttribute('aria-invalid', 'true');
    } else el.removeAttribute('aria-invalid');
  });
}
function fichaEstado(est) { fichaEst.est = est; pintarFichaEstado(); }
function fichaFalla(field, value) {
  fichaFallos().set(field, value);
  pintarFichaCampos();
  fichaEstado('error');
}
function fichaOk(field) {
  fichaFallos().delete(field);
  pintarFichaCampos();
  fichaEstado(fichaEst.campos.size ? 'error' : 'guardado');
}
// El formulario "Datos de la ficha" escribe en la versión que esté cargada; sin
// versión, en la ficha misma (la General).
async function saveFicha(field, value) {
  const val = ['precio', 'tamano_m2', 'construccion_m2', 'precio_m2'].includes(field) ? (value === '' ? null : Number(value))
    : field === 'operacion' && value === '' ? null : value;
  const v = versiones.find(x => String(x.id) === versionSel);
  if (v) {
    if ((v.datos[field] ?? null) === val) return;
    const antes = v.datos;
    v.datos = { ...v.datos, [field]: val };
    fichaEstado('guardando');
    UI.guardar(API.patch(`/versiones/${v.id}`, { datos: v.datos }), {
      que: 'la ficha', revertir: () => { v.datos = antes; fichaFalla(field, value); repintar(); },
    }).then(() => fichaOk(field), () => {});
    // El $/m² que se propone cuando se deja vacío sale de precio y m²: que se actualice.
    if (field === 'precio' || field === 'tamano_m2') repintar();
    return;
  }
  fichaEstado('guardando');
  let sinFicha = false;
  await asegurarFicha().catch(err => { sinFicha = true; UI.aviso('No se pudo guardar la ficha: ' + err.message); });
  if (sinFicha || !ficha) { fichaFalla(field, value); return; }
  if ((ficha[field] ?? null) === val) { fichaOk(field); return; }
  const antes = ficha[field];
  ficha[field] = val;
  if (!esPropia(listing)) {
    UI.guardar(API.patch(`/fichas/${ficha.id}`, { [field]: val }), {
      que: 'la ficha', revertir: () => { ficha[field] = antes; fichaFalla(field, value); repintar(); },
    }).then(() => fichaOk(field), () => {});
    return;
  }
  // En una propiedad propia la ficha ES la propiedad: el encabezado, el precio y los
  // datos de arriba salen de aquí, así que se vuelven a pedir y a pintar.
  let enServidor = false;
  try {
    // La respuesta trae también lo que la API calculó: con dos de precio / m² / $/m²
    // sale el tercero (derivar_precio en main.py).
    Object.assign(ficha, numeros(await API.patch(`/fichas/${ficha.id}`, { [field]: val })));
    enServidor = true;
    listing = Anuncio.de(await API.get(`/listings/${encodeURIComponent(listing.id)}`));
    fichaOk(field);
    repintar();
  } catch (err) {
    if (!enServidor) ficha[field] = antes;
    UI.aviso('No se pudo guardar: ' + err.message);
    if (enServidor) fichaOk(field); else fichaFalla(field, value);
  }
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
  const href = waLink(telefono);
  return href ? `<a class="fx-btn" href="${href}" target="_blank" rel="noopener">WhatsApp</a>` : '';
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
    alTerminar: () => { subiendo.fotos = 0; return v ? repintar() : refrescarFotos().catch(err => UI.aviso('No se pudieron actualizar las fotos: ' + err.message)); },
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
    ${f.length > 1 ? `<button class="fx-over fx-vertodas" data-i="0" aria-label="Ver las ${f.length} fotos"><b>1 / ${f.length}</b> Ver fotos</button>` : ''}
  </div>`;
}

// Anterior / siguiente en la página del tablero. Iba encima de la foto con forma de
// carrusel («1 / 70») y se leía como el contador de fotos: ahora va fuera, dice de qué
// cuenta y anuncia sus atajos.
function pasosHtml(nav) {
  // La ayuda de atajos va siempre: 1-5, S y «?» funcionan aunque no se venga del tablero.
  const ayuda = '<button class="fx-paso fx-ayuda" id="btnAyuda" aria-label="Atajos de teclado" title="Atajos de teclado">Atajos <kbd>?</kbd></button>';
  if (!nav) return `<nav class="fx-pasos solo" aria-label="Ayuda">${ayuda}</nav>`;
  return `<nav class="fx-pasos" aria-label="Propiedades de la búsqueda">
    <button class="fx-paso" id="navPrev" ${nav.prev ? '' : 'disabled'}>&#8592; Anterior <kbd>K</kbd></button>
    <span class="fx-pasos-n">Propiedad ${nav.i + 1} de ${nav.n}<span class="fx-pasos-de"> en la página del tablero</span></span>
    <button class="fx-paso" id="navNext" ${nav.next ? '' : 'disabled'}>Siguiente <kbd>J</kbd> &#8594;</button>
    ${ayuda}
  </nav>`;
}

// render() reescribe la ficha entera: si se estaba escribiendo una nota, el cursor se queda.
function render() {
  const ta = document.activeElement?.id === 'detailNotes' ? document.activeElement : null;
  const sel = ta ? [ta.selectionStart, ta.selectionEnd] : null;
  pintar();
  if (sel) {
    const nuevo = document.getElementById('detailNotes');
    nuevo?.focus();
    nuevo?.setSelectionRange(...sel);
  }
}
function pintar() {
  const l = listing;
  const total = precioTotal(l), pm = ppm(l);
  const fuente = Anuncio.fuente(l.fuente);
  const sufijo = l.transaccion === 'Renta' ? `${Anuncio.moneda(l)}/mes` : Anuncio.moneda(l);
  const ofs = Anuncio.ofertas(l, opDelTablero());
  document.title = (l.titulo ?? 'Propiedad') + ' · OfficeLab';

  const ins = Anuncio.insignia(l), mercado = Anuncio.tiempoEnMercado(l);
  const facts = [
    ...Anuncio.superficiesDe(l).map(s => [s.clave, s.texto, s.clave]),
    ...Anuncio.datos(l).map(d => [d.etiqueta, d.texto, d.clave]),
    pm ? ['Precio / m²', `$${mx(Math.round(pm))}`] : null,
    ins ? [ins.texto, ins.detalle] : null,
    mercado ? ['En el mercado', mercado] : null,
    // Tipo, operación y código ya van en la línea bajo el título: aquí se repetían.
    l.zona ? ['Municipio', l.zona] : null,
  ].filter(Boolean);
  // Los chips de características repetían lo que ya dicen los datos de arriba.
  const yaDicho = new Set(Anuncio.datos(l).map(d => d.clave));
  const REPETIDOS = { cajones: 'cajones', banos: 'banos', elevador: 'elevador', andenes: 'andenes' };
  const features = l.features.filter(f => !Object.entries(REPETIDOS).some(([k, t]) => yaDicho.has(k) && norm(f).includes(t)));

  const hechos = documentos.filter(d => d.done).length;
  const crmOk = crm === 'ok';
  // Mientras el CRM carga o falla no se ofrece nada que dependa de saber si hay ficha.
  const crmCaja = (id, titulo) => `<section class="fx-card crm-estado" id="${id}"><h2>${titulo}</h2>
      ${crm === 'cargando' ? '<p class="fx-hint">Cargando…</p>' : '<div class="crm-err"></div>'}</section>`;
  const enSeg = new Set(procesos.map(p => String(p.cliente_id)));
  const disponibles = clientes.filter(c => !enSeg.has(String(c.id)));
  const nav = vecinos();
  // La versión cargada en el formulario, y de dónde salen sus valores.
  const vSel = versiones.find(v => String(v.id) === versionSel) ?? null;
  const d = vSel ? vSel.datos : (ficha ?? {});
  // Propiedad propia: sus datos y los de la ficha técnica van en un solo desplegable.
  const propia = esPropia(l) && !!ficha;
  const respDe = cid => { const c = clientes.find(x => String(x.id) === String(cid)); return c ? (c.responsable_nombre || c.responsable || null) : null; };

  // Fichas PDF y sus datos, en su propia tarjeta: ocupaban media columna dentro de «Ficha» y
  // dejaban esa columna el doble de larga que las otras.
  const pdfHtml = !crmOk ? '' : `<section class="fx-card" id="pdfCard">
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
          <p class="fx-guardado fx-ficha-est" id="fichaEst" role="status" aria-live="polite"></p>
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
          <div class="fx-row">
            <label>Operación de esta ficha<select class="ficha-in" data-f="operacion">
              ${[['', `La de la propiedad${l.transaccion ? ` (${l.transaccion})` : ''}`], ['sale', 'Venta'], ['rent', 'Renta']].map(([v, t]) =>
                `<option value="${v}"${(d.operacion ?? '') === v ? ' selected' : ''}>${t}</option>`).join('')}
            </select></label>
          </div>
          ${fotosEdHtml(fotosEnEdicion())}
          <p class="fx-hint">El precio por m², la operación y las fotos son sólo de esta ficha: no cambian las demás.</p>` : ''}
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
      </section>`;

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
      ${crmOk && !esPropia(l) && ficha ? '<span class="fx-tag" title="Tiene ficha: aparece en la pestaña Catálogo">En Catálogo</span>' : ''}
      <!-- Ocho acciones con el mismo peso competían entre sí: quedan a la vista el
           estado, destacar y WhatsApp; lo demás va en «Más». En el teléfono esta fila
           es una barra fija abajo (hermes.css). -->
      <div class="fx-acciones">
        <select class="fx-status s-${l.status}" id="detailStatus" aria-label="Estado" title="Estado: teclas 1 a 5">
          ${Anuncio.ESTADOS.map(s => `<option${s === l.status ? ' selected' : ''}>${s}</option>`).join('')}
        </select>
        <button class="fx-star${l.starred ? ' on' : ''}" id="detailStar" aria-pressed="${l.starred}" title="Destacar (S)" aria-label="Destacar">${l.starred ? '&#9733;' : '&#9734;'}</button>
        ${waLink(l.whatsapp) ? `<a class="fx-btn solid" href="${waLink(l.whatsapp)}" target="_blank" rel="noopener" aria-label="WhatsApp al anunciante"><span>WhatsApp<span class="fx-largo"> al anunciante</span></span></a>` : ''}
        ${l.url ? `<a class="fx-btn" href="${hrefSeguro(l.url)}" target="_blank" rel="noopener" title="Abre el anuncio en el portal" aria-label="Ver el anuncio en el portal"><span class="fx-ver-txt">Ver<span class="fx-largo"> el</span> anuncio</span>${ICON_EXTERNAL}</a>` : ''}
        <details class="fx-mas-menu" id="fxMas">
          <summary class="fx-btn">&#8943; Más</summary>
          <div class="fx-mas-lista">
            <button class="fx-mas-item" id="btnPdf"${crmOk ? '' : ' disabled'} title="Abre el cuadro de impresión de ${esc(nombrePdf(vSel))}.pdf: ahí se elige «Guardar como PDF»">Imprimir / guardar PDF</button>
            <button class="fx-mas-item" id="mkt-pdf" title="Análisis de mercado de esta propiedad, para adjuntar a la propuesta">Análisis de mercado</button>
            ${!crmOk ? '' : esPropia(l) ? (ficha ? '<button class="fx-mas-item peligro" id="btnQuitar" title="Borra la propiedad con todo lo que cuelga de ella">Eliminar propiedad</button>' : '') : (ficha
              ? '<button class="fx-mas-item peligro" id="btnQuitar" title="Borra su ficha; el anuncio vuelve a la Bolsa">Quitar del Catálogo</button>'
              : '<button class="fx-mas-item" id="btnInmo" title="Guardarla en la bolsa propia, sin asignarla a nadie">+ Guardar en Catálogo</button>')}
          </div>
        </details>
      </div>
    </section>
    ${crmOk && !ficha ? '<p class="fx-hint fx-catalogo fx-bolsa">Esta propiedad está en la Bolsa. Al agregar un documento o un contacto, o al asignarla a un cliente, pasa al Catálogo.</p>' : ''}

    <div class="fx-cols${PRESENTA_A ? ' pres' : ''}">
      <section class="fx-card">
        <h2>Ficha</h2>
        <dl class="fx-facts">${facts.map(([k, v, ic]) => `<div><dt>${ic ? Iconos.de(ic, 12) : ''}${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
        ${l.descripcion ? `<p class="fx-desc">${esc(l.descripcion)}</p>` : ''}
        ${features.length ? `<ul class="fx-feat">${features.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
      </section>

      ${/* Columna de enmedio: documentos y, debajo, el contacto del inmueble. Van en una
           pila para que la tercera columna siga siendo la de clientes. */''}
      <div class="fx-stack">
      ${!crmOk ? crmCaja('crmDocs', 'Documentos y contacto') : `<section class="fx-card" id="docsCard">
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
      </section>`}

      ${PRESENTA_A || !crmOk ? '' : `<section class="fx-card" id="ctoCard">
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
          </div>`).join('') || `<p class="fx-hint">Sin contacto todavía.</p>`}
        <div class="fx-add">
          <button class="cto-add" data-rol="dueno">+ Dueño</button>
          <button class="cto-add" data-rol="asesor">+ Asesor</button>
        </div>
      </section>`}
      ${pdfHtml}
      </div>

      ${PRESENTA_A ? '' : `<div class="fx-stack">
        ${!crmOk ? crmCaja('crmCli', 'Clientes') : `<section class="fx-card" id="cliCard">
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
        </section>`}
        <section class="fx-card fx-notas">
          <h2>Notas internas <span class="fx-n fx-guardado" id="notasEst" role="status" aria-live="polite"></span></h2>
          <textarea id="detailNotes" placeholder="Llamadas, condiciones, pendientes… Se guardan solas.">${esc(notas.pend ?? l.notes)}</textarea>
        </section>
      </div>`}
    </div>`;
  enlazar();
}

// La caja de fotos del formulario (fotos.js).
const fotosEdHtml = fotos => Fotos.caja(fotos, { subiendo: subiendo.fotos });

// Lo que depende de la propiedad y no del CRM: estado, destacar, notas, menú y navegación.
function enlazar() {
  const $ = id => document.getElementById(id);
  $('detailStar').onclick = destacar;
  $('detailStatus').onchange = e => {
    guardarEstado({ status: e.target.value }).catch(() => {});
    e.target.className = `fx-status s-${e.target.value}`;
  };
  const ta = $('detailNotes');
  if (ta) {
    ta.oninput = () => {
      notas.pend = ta.value;
      notasEstado('pendiente');
      clearTimeout(notas.timer);
      notas.timer = setTimeout(guardarNotas, 800);
    };
    ta.onblur = guardarNotas;
  }
  notasEstado(notas.est);     // render() reescribe el indicador: se vuelve a pintar
  pintarFichaEstado();
  pintarFichaCampos(true);
  $('btnPdf').onclick = () => imprimirFicha(versionSel);
  $('mkt-pdf').onclick = e => descargarAnalisis(e.currentTarget);
  $('btnAyuda') && ($('btnAyuda').onclick = ayudaAtajos);
  // «Más» se cierra al elegir algo, salvo el análisis, que dice «Generando…» en su botón.
  $('fxMas').onclick = e => {
    if (e.target.closest('.fx-mas-item') && !e.target.closest('#mkt-pdf')) $('fxMas').open = false;
  };
  $('navPrev') && ($('navPrev').onclick = () => irA(vecinos()?.prev));
  $('navNext') && ($('navNext').onclick = () => irA(vecinos()?.next));
  document.querySelectorAll('.fx-ph[data-i], .fx-vertodas').forEach(b => b.onclick = () => abrirVisor(+b.dataset.i));
  if (crm === 'ok') enlazarCrm();
  else if (crm === 'error') document.querySelectorAll('.crm-err').forEach(el =>
    UI.errorCarga(el, `No se pudo cargar el seguimiento de la propiedad: ${crmError}`, cargarCrm));
}

// Lo que cuelga de la ficha: sólo existe cuando el CRM cargó (ver `crm`).
function enlazarCrm() {
  const $ = id => document.getElementById(id);
  $('btnInmo') && ($('btnInmo').onclick = guardarEnInmobiliaria);
  $('btnQuitar') && ($('btnQuitar').onclick = quitarDeInmobiliaria);
  $('pdfData').ontoggle = e => { pdfAbierto = e.target.open; };
  // Una ficha guardada: su nombre la carga en el formulario; "PDF" la imprime.
  document.querySelectorAll('.fx-ver-n').forEach(b => b.onclick = () => { versionSel = b.dataset.v || null; pdfAbierto = true; render(); });
  document.querySelectorAll('.fx-ver-pdf').forEach(b => b.onclick = () => imprimirFicha(b.dataset.v || null));
  document.querySelectorAll('.fx-ver-del').forEach(b => b.onclick = () => borrarVersion(b.dataset.v));
  $('verAdd') && ($('verAdd').onchange = async e => {
    const v = e.target.value;
    e.target.value = '';
    if (v === '__otro') {
      const nombre = await UI.pedir({ titulo: 'Nueva ficha PDF', etiqueta: 'Nombre (el archivo sale como Ficha-<nombre>.pdf)', verbo: 'Crear ficha' });
      return nombre && crearVersion(nombre);
    }
    const c = clientes.find(x => String(x.id) === v);
    if (c) crearVersion(c.nombre, c.id);
  });
  document.querySelectorAll('.base-in').forEach(el => el.onchange = e => saveBase(e.target.dataset.f, e.target.value));
  $('procAdd') && ($('procAdd').onchange = e => addProceso(e.target.value));
  document.querySelectorAll('.ficha-in').forEach(el => el.onblur = e => saveFicha(e.target.dataset.f, e.target.value));
  document.querySelectorAll('select.ficha-in').forEach(el => el.onchange = e => saveFicha(e.target.dataset.f, e.target.value));
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
    caja.hidden = false;
    // 422: la propiedad no se puede comparar (sin coordenada, superficie o
    // precio). Se dice en su sitio en vez de dejar la tarjeta vacía.
    if (e.status === 422) {
      caja.innerHTML = `<div class="fx-card"><h2>Mercado comparable</h2><p class="fx-hint">${esc(e.message)}</p></div>`;
      return;
    }
    // Cualquier otro fallo (red, servidor) no es «sin comparables»: se reintenta.
    caja.innerHTML = '<div class="fx-card"><h2>Mercado comparable</h2><div id="mkErr"></div></div>';
    UI.errorCarga(document.getElementById('mkErr'), `No se pudo cargar el mercado comparable: ${e.message}`, cargarMercado);
    return;
  }
  const s = d.sujeto, r = d.resumen, y = d.rendimiento, e = d.entorno;
  // Sin otros comparables con ubicación el mapa sólo repetía el de «Ubicación» (el mismo
  // pin, solo): se omite y el mercado se queda en texto.
  const conMapa = d.comparables.some(c => Number.isFinite(c.lat) && Number.isFinite(c.lng));
  let cuerpo;
  if (!r.suficiente) {
    cuerpo = `<p class="fx-hint">${r.n ? `Inventario insuficiente: ${r.n} ${r.n === 1 ? 'comparable' : 'comparables'} a 5 km, y el análisis
      pide ${r.minimo} para publicar una cifra.` : `Sin comparables a 5 km: el análisis pide ${r.minimo} para publicar una cifra.`}</p>`;
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
  caja.innerHTML = `<div class="fx-card${conMapa ? ' mk-grid' : ''}">
      <div class="mk-datos">
        <h2>Mercado comparable <span class="fx-n">precios de lista</span></h2>
        ${cuerpo}
        ${entorno ? `<h2>Entorno a ${e.radio_m} m</h2>${entorno}` : ''}
      </div>
      ${!conMapa ? '' : `<div class="mk-mapa">
        <div id="mkMap"></div>
        <div class="ub-zoom"><button id="mkMas" aria-label="Acercar">+</button><button id="mkMenos" aria-label="Alejar">&#8722;</button></div>
        <div class="map-note" id="mkAviso" hidden></div>
        <div class="ub-attr">&#169; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &#183; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> &#183; <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a></div>
      </div>`}
    </div>`;
  caja.hidden = false;
  if (!conMapa) return;

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
// ── Atajos de teclado ────────────────────────────────────────────────────────
// Triage con el teclado: 1-5 marcan el estado y pasan a la siguiente propiedad, S destaca,
// Z deshace, J/K recorren y «?» lista todo. Nada de esto actúa con Ctrl, Cmd o Alt (son de
// los atajos del navegador: Alt+← es «atrás»), dentro de un campo ni con un diálogo abierto.
let barra = null, barraFn = null, barraReloj = 0;
// Un aviso con «Deshacer». `UI.aviso` no trae acción, y el cambio de estado por teclado
// pasa de propiedad: el aviso con el deshacer tiene que poder cruzar la página (ver abajo).
function barraDeshacer(texto, fn) {
  if (!barra) {
    barra = document.createElement('div');
    barra.className = 'fx-deshacer';
    barra.setAttribute('role', 'status');
    barra.innerHTML = '<span></span><button type="button">Deshacer <kbd>Z</kbd></button>';
    barra.querySelector('button').addEventListener('click', () => deshacerUltimo());
    document.body.appendChild(barra);
  }
  barra.querySelector('span').textContent = texto;
  barraFn = fn;
  barra.hidden = false;
  clearTimeout(barraReloj);
  barraReloj = setTimeout(() => { barra.hidden = true; barraFn = null; }, 8000);
}
function deshacerUltimo() {
  const fn = barraFn;
  if (!fn || !barra) return;
  barra.hidden = true; barraFn = null;
  clearTimeout(barraReloj);
  fn();
}
// El deshacer viaja en sessionStorage a la propiedad siguiente, que lo ofrece al abrirse.
function deshacerPendiente() {
  let d = null;
  try { d = JSON.parse(sessionStorage.getItem('ol-deshacer')); sessionStorage.removeItem('ol-deshacer'); } catch { return; }
  if (!d?.id || !Anuncio.ESTADOS.includes(d.antes) || !Anuncio.ESTADOS.includes(d.nuevo)) return;
  barraDeshacer(`La propiedad anterior quedó como ${d.nuevo}.`, async () => {
    try { await API.put(rutaEstado(d.id), { status: Anuncio.estadoApi(d.antes) }); irA(d.id); }
    catch (err) { UI.aviso(`No se pudo deshacer: ${err.message}`); }
  });
}

let atajoOcupado = false;
async function atajoEstado(estado) {
  if (atajoOcupado || estado === listing.status) return;
  const antes = listing.status, id = listing.id, sig = vecinos()?.next ?? null;
  atajoOcupado = true;
  try {
    const guardado = guardarEstado({ status: estado });
    render();
    try { await guardado; } catch { return; }          // UI.guardar ya revirtió y avisó
    if (!sig) return barraDeshacer(`Marcada como ${estado}.`, () => { guardarEstado({ status: antes }).catch(() => {}); render(); });
    try { sessionStorage.setItem('ol-deshacer', JSON.stringify({ id, antes, nuevo: estado })); } catch { /* sin deshacer */ }
    irA(sig);
  } finally { atajoOcupado = false; }
}

const ATAJOS = [
  ['<kbd>J</kbd> <kbd>K</kbd>', 'Propiedad siguiente o anterior de la búsqueda'],
  [`<kbd>1</kbd> a <kbd>${Anuncio.ESTADOS.length}</kbd>`, 'Marcar el estado y pasar a la siguiente: ' + Anuncio.ESTADOS.map((x, i) => `${i + 1} ${x}`).join(' · ')],
  ['<kbd>S</kbd>', 'Destacar o quitar el destacado'],
  ['<kbd>Z</kbd>', 'Deshacer el último cambio de estado'],
  ['<kbd>&#8592;</kbd> <kbd>&#8594;</kbd>', 'Fotos, con el visor abierto'],
  ['<kbd>?</kbd>', 'Esta ayuda'],
];
function ayudaAtajos() {
  let d = document.getElementById('fxAyuda');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'fxAyuda';
    d.className = 'ui-dlg';
    d.innerHTML = `<form method="dialog"><h2 class="ui-dlg-t">Atajos de teclado</h2>
      <dl class="fx-atajos">${ATAJOS.map(([t, x]) => `<div><dt>${t}</dt><dd>${x}</dd></div>`).join('')}</dl>
      <div class="ui-dlg-acc"><button value="no" class="ui-dlg-si">Cerrar</button></div></form>`;
    d.addEventListener('click', e => { if (e.target === d) d.close(); });
    document.body.appendChild(d);
  }
  d.showModal();
}

document.addEventListener('keydown', e => {
  const m = document.getElementById('fxMas');
  if (e.key === 'Escape' && m?.open) { m.open = false; m.querySelector('summary').focus(); return; }
  if (e.target.closest('input, textarea, select')) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || document.querySelector('dialog[open]')) return;
  if (visor >= 0) {
    if (e.key === 'Escape') cerrarVisor();
    if (e.key === 'ArrowLeft') abrirVisor(visor - 1);
    if (e.key === 'ArrowRight') abrirVisor(visor + 1);
    return;
  }
  if (!listing) return;
  const k = e.key;
  if (k === '?') { e.preventDefault(); ayudaAtajos(); return; }
  if (e.repeat) return;
  const v = vecinos();
  if (k === 'j' || k === 'J') irA(v?.next);
  else if (k === 'k' || k === 'K') irA(v?.prev);
  else if (k === 'z' || k === 'Z') deshacerUltimo();
  // Cambiar el estado no se hace ante el cliente en modo presentación.
  else if (PRESENTA_A) return;
  else if (/^[1-9]$/.test(k) && Anuncio.ESTADOS[+k - 1]) atajoEstado(Anuncio.ESTADOS[+k - 1]);
  else if (k === 's' || k === 'S') destacar();
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
      <div class="pr-precio"><b>${precio != null ? '$' + mx(Math.round(precio)) + (Anuncio.moneda(l) === 'MXN' ? '' : ' ' + Anuncio.moneda(l)) : 'Precio a consultar'}</b><span>${{ sale: 'EN VENTA', rent: 'EN RENTA' }[v?.datos.operacion] ?? { Venta: 'EN VENTA', Renta: 'EN RENTA' }[l.transaccion] ?? ''}</span></div>
      ${v?.datos.operacion ? '' : segundaPdf(l, f)}
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
// La propiedad se pinta en cuanto llega; el CRM (ficha, documentos, clientes), el mercado y
// los anuncios hermanos se piden aparte y en paralelo, y ninguno retrasa a los demás.
async function iniciar() {
  const detalle = document.getElementById('detail');
  try {
    currentUser = await API.me();
    document.getElementById('authBox').hidden = true;
    document.getElementById('userBox').hidden = false;
    if (!id) { detalle.innerHTML = '<p class="pg-empty">Falta el identificador de la propiedad.</p>'; return; }
    listing = Anuncio.de(await API.get(`/listings/${encodeURIComponent(id)}`));
  } catch (err) {
    UI.errorCarga(detalle, `No se pudo cargar esta propiedad: ${err.message}`, iniciar);
    return;
  }
  render();
  deshacerPendiente();
  // El mapa de una propiedad propia necesita saber si hay ficha: espera al CRM.
  if (!esPropia(listing)) pintarUbicacion();
  // Aparte y sin await: el análisis tarda ~400 ms y la ficha no tiene por qué
  // esperarlo, ni caerse si falla.
  cargarMercado().catch(err => console.error(err));
  cargarPropiedad().catch(err => console.error(err));
  await cargarCrm();
  if (esPropia(listing)) pintarUbicacion();
}
iniciar();

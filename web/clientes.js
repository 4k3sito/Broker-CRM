// Clientes (diseño 1a): lista compacta a la izquierda y, a la derecha, el cliente
// seleccionado con TODAS sus propuestas en una tabla. Sustituye a la rejilla de
// tarjetas, que obligaba a hacer scroll para ver las propuestas de cada uno.

// Las etapas de un proceso vienen de etapas.js (compartido con tareas y la ficha);
// `esc` y `norm`, de texto.js.
const mx = n => Number(n).toLocaleString('es-MX');

let currentUser = null;
let clientes = [];          // cada uno con .proceso[] embebido
let filterStatus = 'all';
let searchQ = '';
let selId = decodeURIComponent(location.hash.slice(1)) || null;
let equipo = [];            // personas con cuenta, para el selector de "Cuenta"
let critAbierto = null;     // qué criterio se está editando en el menú de "Qué busca"
let lugarSugs = [];         // sugerencias del autocompletado de ubicación
let filterCuenta = 'all';   // lista: 'all' | 'none' (sin asignar) | id de quien lleva la cuenta
let filterEstatus = 'all';  // lista: 'all' | 'none' (sin estatus) | llave de ESTATUS
let abierto = null;         // id del proceso cuya fila está desplegada
let colsAbierto = false;    // el menú de "Columnas"
let propEtapa = 'all';      // tabla de propiedades: filtro por etapa…
let propTrae = 'all';       // …y por quién la presentó
let tareas = [];            // las tareas del cliente abierto (suyas y de sus propiedades)
let tareasDe = null;        // de qué cliente son: evita pedirlas en cada render

// ── Datos ────────────────────────────────────────────────────────────────────
async function loadClientes() {
  clientes = await API.get('/clientes').catch(err => { console.warn('Carga de clientes falló:', err.message); return []; });
}
async function createCliente(patch) {
  try {
    const c = await API.post('/clientes', patch);
    clientes.unshift({ proceso: [], ...c });
    seleccionar(c.id);
  } catch (err) { alert('No se pudo crear el cliente: ' + err.message); }
}
function saveCliente(id, field, value) {
  const c = clientes.find(x => String(x.id) === String(id));
  if (!c || c[field] === value) return;
  c[field] = value;
  API.patch(`/clientes/${id}`, { [field]: value }).catch(err => console.warn('No se pudo guardar:', err.message));
  renderLista();
}
async function deleteCliente(id) {
  if (!confirm('¿Eliminar este cliente y todos sus procesos?')) return;
  try {
    await API.del(`/clientes/${id}`);
    clientes = clientes.filter(c => String(c.id) !== String(id));
    selId = null; render();
  } catch (err) { alert('No se pudo eliminar: ' + err.message); }
}
function setProcesoStatus(procId, status) {
  for (const c of clientes) {
    const p = (c.proceso ?? []).find(x => String(x.id) === String(procId));
    if (p) p.status = status;
  }
  API.patch(`/procesos/${procId}`, { status }).catch(err => console.warn(err.message));
  render();
}
async function removeProceso(procId) {
  if (!confirm('¿Quitar esta propuesta?')) return;
  try {
    await API.del(`/procesos/${procId}`);
    for (const c of clientes) c.proceso = (c.proceso ?? []).filter(p => String(p.id) !== String(procId));
    if (abierto === String(procId)) abierto = null;
    render();
  } catch (err) { alert('No se pudo quitar: ' + err.message); }
}

// Una fila nueva escrita a mano: una ficha sin anuncio de origen (queda en
// Inmobiliaria como propiedad propia) más su proceso con este cliente. Se abre
// desplegada para capturarle el resto.
async function agregarPropiedad(c, titulo) {
  titulo = (titulo ?? '').trim();
  if (!titulo) return;
  try {
    const f = await API.post('/fichas', { titulo });
    const p = await API.post('/procesos', {
      cliente_id: c.id, ficha_id: f.id, status: 'prospecto', numero: (c.proceso ?? []).length + 1,
    });
    c.proceso = [...(c.proceso ?? []), { ...p, trae_nombre: null, ficha: f }];
    abierto = String(p.id);
    propEtapa = 'all'; propTrae = 'all';
    render();
  } catch (err) { alert('No se pudo agregar la propiedad: ' + err.message); }
}

// Un campo del panel desplegado. Los de la propiedad van a la ficha (que es la misma
// para todos los clientes a los que se presentó); junta, marca, notas y quién la
// presentó son de ESTE proceso. No vuelve a pintar el panel —perdería el foco al
// pasar de un campo a otro—, sólo la fila.
const NUMERICOS = ['tamano_m2', 'precio', 'precio_m2'];
function guardarCampo(c, p, tabla, f, crudo) {
  let v = NUMERICOS.includes(f) ? (crudo === '' ? null : Number(crudo)) : (crudo.trim() === '' ? null : crudo.trim());
  if (Number.isNaN(v)) return;
  const fallo = err => alert('No se pudo guardar: ' + err.message);
  if (tabla === 'ficha') {
    if (f === 'titulo' && v == null) return;
    if ((p.ficha[f] ?? null) === v) return;
    // La misma ficha puede estar con otro cliente: que diga lo mismo en todos.
    const poner = datos => { for (const x of clientes) for (const q of x.proceso ?? [])
      if (String(q.ficha?.id) === String(p.ficha.id)) Object.assign(q.ficha, datos); };
    poner({ [f]: v });
    API.patch(`/fichas/${p.ficha.id}`, { [f]: v }).then(fila => {
      if (!NUMERICOS.includes(f)) return;
      // Con dos de precio / m² / $/m² la API calcula el tercero (derivar_precio): se
      // trae de vuelta a la fila y a los campos del panel, sin repintarlo.
      const antes = { ...p.ficha };
      poner(Object.fromEntries(NUMERICOS.map(k => [k, fila[k] == null ? null : Number(fila[k])])));
      refrescarFila(c, p);
      const panel = document.querySelector(`#clDetail .cl-exp[data-proc="${CSS.escape(String(p.id))}"]`);
      for (const k of NUMERICOS) {
        const el = panel?.querySelector(`.cl-ein[data-f="${k}"]`);
        // El campo con el foco sólo se toca si la persona no ha escrito nada en él.
        if (el && (el !== document.activeElement || el.value === String(antes[k] ?? ''))) el.value = p.ficha[k] ?? '';
      }
    }).catch(fallo);
  } else {
    let patch = { [f]: v };
    if (f === 'trae_id') {
      const quien = equipo.find(x => String(x.id) === v);
      patch = { trae_id: v, trae: quien ? nombreDe(quien) : null };
      p.trae_nombre = quien ? nombreDe(quien) : null;
    }
    if (Object.keys(patch).every(k => (p[k] ?? null) === patch[k])) return;
    Object.assign(p, patch);
    API.patch(`/procesos/${p.id}`, patch).catch(fallo);
  }
  refrescarFila(c, p);
}

// El orden que quedó al soltar una fila: `numero` pasa a ser la posición.
function reordenar(c, deId, aId, despues) {
  const ps = c.proceso ?? [];
  const de = ps.findIndex(p => String(p.id) === deId);
  if (de < 0 || deId === aId) return;
  const [fila] = ps.splice(de, 1);
  let a = ps.findIndex(p => String(p.id) === aId);
  if (a < 0) { ps.splice(de, 0, fila); return; }
  ps.splice(a + (despues ? 1 : 0), 0, fila);
  ps.forEach((p, i) => { p.numero = i + 1; });
  API.put(`/clientes/${c.id}/orden`, { ids: ps.map(p => p.id) })
    .catch(err => alert('No se pudo guardar el orden: ' + err.message));
  renderDetalle();
}

// ── Tareas del cliente ───────────────────────────────────────────────────────
// Una tarea es del cliente (`cliente_id`) y, si se generó desde una propiedad, también
// de ese proceso (`proceso_id`). Son las mismas del tablero de tareas.html.
async function cargarTareas(cid) {
  tareasDe = cid;
  tareas = [];
  const ts = await API.get(`/tareas${API.qs({ cliente: cid })}`).catch(() => []);
  if (tareasDe !== cid) return;        // ya se cambió de cliente mientras llegaba
  tareas = ts;
  renderDetalle();
}
async function crearTarea(c, form) {
  const v = n => form.querySelector(`[data-t="${n}"]`)?.value ?? '';
  const titulo = v('titulo').trim();
  if (!titulo) return;
  const asignado = v('asignado') || null;
  try {
    tareas.unshift(await API.post('/tareas', {
      titulo, tipo: 'Seguimiento', prioridad: 'media',
      columna: asignado ? 'asignado' : 'pendiente', asignado_a: asignado,
      cliente_id: c.id, proceso_id: form.dataset.proc || v('proceso') || null,
      vence_el: v('vence') || null,
    }));
    renderDetalle();
  } catch (err) { alert('No se pudo crear la tarea: ' + err.message); }
}
function completarTarea(id, hecha) {
  const t = tareas.find(x => String(x.id) === String(id));
  if (!t) return;
  t.columna = hecha ? 'completado' : (t.asignado_a ? 'asignado' : 'pendiente');
  API.patch(`/tareas/${id}`, { columna: t.columna }).catch(err => alert('No se pudo guardar: ' + err.message));
  renderDetalle();
}

// ── Derivados ────────────────────────────────────────────────────────────────
const cuenta = (procs, st) => procs.filter(p => p.status === st).length;
const iniciales = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
// Quién trajo/presentó una propiedad: la cuenta ligada manda; si no hay, el texto del
// sheet. El tono sale del id con la misma fórmula que tareas.js, para que cada
// persona tenga el mismo color en el pipeline y aquí.
const TONOS = Array.from({ length: 7 }, (_, i) => `var(--tono-${i})`);
const tono = id => TONOS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % TONOS.length];
function traeHtml(p) {
  const quien = p.trae_nombre || p.trae || '';
  return `<span class="cl-trae">${quien
    ? `<span class="tk-ava" style="background:${tono(p.trae_id ?? quien)}">${esc(iniciales(quien.replace('/', ' ')))}</span><span class="cl-trae-n">${esc(quien)}</span>`
    : '<span class="tk-ava sin">&#8212;</span><span class="cl-trae-n sin">Sin asignar</span>'}</span>`;
}
// Etapa del cliente: la del proceso más avanzado que tenga (no hay columna `etapa`).
const etapaDe = c => etapaMayor((c.proceso ?? []).map(p => p.status));
// Estatus del cliente: en qué va la relación con él. No es la etapa —esa sale de sus
// propiedades—; lo marca el asesor en la ficha del cliente (`cliente.estatus`).
const ESTATUS = [
  { key: 'activo',        label: 'Activo' },
  { key: 'contactando',   label: 'Contactando' },
  { key: 'por_contactar', label: 'Por contactar' },
  { key: 'inactivo',      label: 'Inactivo' },
];
const estatusLabel = k => ESTATUS.find(e => e.key === k)?.label ?? null;
// Búsqueda, estatus y "quién lleva la cuenta": la base sobre la que cuentan las
// píldoras de etapa.
function pasaBase(c) {
  if (searchQ && !norm(`${c.nombre} ${c.empresa ?? ''} ${c.contacto ?? ''}`).includes(norm(searchQ))) return false;
  if (filterEstatus !== 'all' && (c.estatus ?? 'none') !== filterEstatus) return false;
  if (filterCuenta === 'none') return !c.responsable_id && !c.responsable;
  return filterCuenta === 'all' || String(c.responsable_id) === filterCuenta;
}
// Cuántos clientes hay de cada estatus con lo demás aplicado (el propio filtro de
// estatus no cuenta: si contara, las otras opciones dirían siempre 0).
function cuentaEstatus() {
  const puesto = filterEstatus;
  filterEstatus = 'all';
  const n = {};
  for (const c of clientes.filter(pasaBase)) n[c.estatus ?? 'none'] = (n[c.estatus ?? 'none'] ?? 0) + 1;
  filterEstatus = puesto;
  return n;
}
const pasaFiltro = c => pasaBase(c) && (filterStatus === 'all' || (c.proceso ?? []).some(p => p.status === filterStatus));
const fecha = iso => iso ? new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }) : '—';
const telDe = s => { const d = String(s ?? '').replace(/\D/g, ''); return d.length >= 10 ? d : null; };

function seleccionar(id) {
  selId = id == null ? null : String(id);
  history.replaceState(null, '', selId ? `#${encodeURIComponent(selId)}` : location.pathname);
  render();
}

// ── Cuenta: quién del equipo lleva al cliente ────────────────────────────────
// Se elige de la lista de cuentas (`responsable_id`). El texto `responsable` viene
// del Google Sheet del pipeline, de cuando casi nadie tenía cuenta: se sigue
// mostrando mientras el cliente no esté ligado, y al elegir una persona se iguala a
// su nombre para que el panel del pipeline diga lo mismo.
const nombreDe = p => p.nombre || p.email;
function cuentaHtml(c) {
  const suelto = !c.responsable_id && c.responsable;
  return `<label class="cl-f"><span>Cuenta</span>
    <select class="cl-sel" id="clCuenta">
      <option value="">${suelto ? `${esc(c.responsable)} · sin cuenta` : 'Sin asignar'}</option>
      ${equipo.map(p => `<option value="${esc(p.id)}"${String(p.id) === String(c.responsable_id) ? ' selected' : ''}>${esc(nombreDe(p))}</option>`).join('')}
    </select></label>`;
}
function estatusHtml(c) {
  return `<label class="cl-f"><span>Estatus</span>
    <select class="cl-sel${c.estatus ? ` est-${esc(c.estatus)}` : ''}" id="clEstatus">
      <option value="">Sin estatus</option>
      ${ESTATUS.map(e => `<option value="${e.key}"${e.key === c.estatus ? ' selected' : ''}>${e.label}</option>`).join('')}
    </select></label>`;
}
function asignarCuenta(c, uid) {
  const p = equipo.find(x => String(x.id) === uid);
  const patch = { responsable_id: uid || null, ...(p ? { responsable: nombreDe(p) } : {}) };
  Object.assign(c, patch, { responsable_nombre: p ? nombreDe(p) : null });
  API.patch(`/clientes/${c.id}`, patch).catch(err => alert('No se pudo asignar la cuenta: ' + err.message));
  renderLista();
}

// ── Qué busca: criterios como píldoras ───────────────────────────────────────
// Un menú fijo de criterios que el tablero sabe aplicar (`index.html?cliente=<id>`).
// Se guardan en `cliente.criterios` con las mismas llaves que /api/listings; el
// texto libre de `requerimientos` se queda para lo que no cabe en una píldora.
const TIPOS_CRIT = ['oficina', 'local', 'bodega', 'terreno'];
const CRITERIOS = {
  tipos:     { label: 'Tipo' },
  operacion: { label: 'Operación' },
  m2:        { label: 'Superficie', min: 'm2_min', max: 'm2_max', fmt: v => `${mx(v)} m²` },
  ppm:       { label: 'Precio por m²', min: 'ppm_min', max: 'ppm_max', fmt: v => `$${mx(v)}/m²` },
  precio:    { label: 'Precio total', min: 'precio_min', max: 'precio_max', fmt: v => `$${mx(v)}` },
  lugares:   { label: 'Ubicación' },
};
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
const rangoTxt = (min, max, fmt) =>
  min != null && max != null ? `${fmt(min)} – ${fmt(max)}` : max != null ? `hasta ${fmt(max)}` : `desde ${fmt(min)}`;

// Las píldoras que se pintan: una por criterio puesto (y una por lugar).
function pildoras(cr) {
  const out = [];
  if (cr.tipos?.length) out.push({ k: 'tipos', txt: cr.tipos.map(cap).join(' · ') });
  if (cr.operacion) out.push({ k: 'operacion', txt: cr.operacion === 'rent' ? 'Renta' : 'Venta' });
  for (const k of ['m2', 'ppm', 'precio']) {
    const d = CRITERIOS[k];
    if (cr[d.min] != null || cr[d.max] != null) out.push({ k, txt: rangoTxt(cr[d.min], cr[d.max], d.fmt) });
  }
  (cr.lugares ?? []).forEach((l, i) => out.push({ k: 'lugares', i, txt: l.nombre }));
  return out;
}

function queBuscaHtml(c) {
  const ps = pildoras(c.criterios ?? {});
  return `<div class="cl-f wide cl-busca"><span>Qué busca</span>
    <div class="crit-row">
      ${ps.map(p => `<span class="crit-pill"><b>${esc(CRITERIOS[p.k].label)}</b>${esc(p.txt)}` +
        `<button class="crit-x" data-k="${p.k}"${p.i != null ? ` data-i="${p.i}"` : ''} title="Quitar">&times;</button></span>`).join('')}
      <span class="crit-wrap">
        <button class="crit-add" id="critAdd">+ Criterio</button>
        ${critAbierto ? critPopHtml(c.criterios ?? {}) : ''}
      </span>
      ${ps.length ? `<a class="crit-buscar" href="index.html?cliente=${encodeURIComponent(c.id)}">Buscar inmuebles &#8594;</a>` : ''}
    </div>
    <input class="cli-in crit-nota" data-f="requerimientos" value="${esc(c.requerimientos)}" placeholder="Notas: lo que no cabe en una píldora…">
  </div>`;
}

// El menú: primero la lista de criterios; al elegir uno, su editor.
function critPopHtml(cr) {
  if (critAbierto === 'menu') return `<div class="crit-pop" role="menu">
    ${Object.entries(CRITERIOS).map(([k, d]) => `<button class="crit-opt" data-k="${k}">${d.label}</button>`).join('')}</div>`;
  const d = CRITERIOS[critAbierto];
  let cuerpo;
  if (critAbierto === 'tipos') cuerpo = `<div class="crit-chips">${TIPOS_CRIT.map(t =>
    `<label><input type="checkbox" name="tipo" value="${t}"${(cr.tipos ?? []).includes(t) ? ' checked' : ''}>${cap(t)}</label>`).join('')}</div>`;
  else if (critAbierto === 'operacion') cuerpo = `<div class="crit-chips">${[['rent', 'Renta'], ['sale', 'Venta']].map(([v, l]) =>
    `<label><input type="radio" name="op" value="${v}"${cr.operacion === v ? ' checked' : ''}>${l}</label>`).join('')}</div>`;
  else if (critAbierto === 'lugares') cuerpo = `<input class="crit-in" id="critLugar" placeholder="Municipio o colonia…" autocomplete="off">
    <div class="crit-sugs" id="critSugs"></div>`;
  else cuerpo = `<div class="crit-rango">
    <input class="crit-in" type="number" min="0" id="critMin" placeholder="Mín" value="${cr[d.min] ?? ''}">
    <span>–</span>
    <input class="crit-in" type="number" min="0" id="critMax" placeholder="Máx" value="${cr[d.max] ?? ''}"></div>`;
  return `<div class="crit-pop"><div class="crit-pop-t">${d.label}</div>${cuerpo}
    <div class="crit-pop-f"><button class="crit-cancel" id="critCancel">Cancelar</button>
    ${critAbierto === 'lugares' ? '' : '<button class="crit-ok" id="critOk">Agregar</button>'}</div></div>`;
}

function guardarCriterios(c, cr) {
  // Sin llaves vacías: el tablero trata una llave ausente como "sin filtro".
  for (const k of Object.keys(cr))
    if (cr[k] == null || cr[k] === '' || (Array.isArray(cr[k]) && !cr[k].length)) delete cr[k];
  c.criterios = cr;
  API.patch(`/clientes/${c.id}`, { criterios: cr }).catch(err => alert('No se pudo guardar: ' + err.message));
  critAbierto = null;
  render();
}

function conectarCriterios(c, box) {
  const cr = () => ({ ...(c.criterios ?? {}) });
  box.querySelector('#critAdd').addEventListener('click', () => { critAbierto = critAbierto ? null : 'menu'; renderDetalle(); });
  box.querySelectorAll('.crit-opt').forEach(b => b.addEventListener('click', () => {
    critAbierto = b.dataset.k; lugarSugs = []; renderDetalle();
    document.querySelector('#clDetail .crit-pop input')?.focus();
  }));
  box.querySelector('#critCancel')?.addEventListener('click', () => { critAbierto = null; renderDetalle(); });
  box.querySelectorAll('.crit-x').forEach(b => b.addEventListener('click', () => {
    const n = cr(), k = b.dataset.k;
    if (k === 'lugares') n.lugares = (n.lugares ?? []).filter((_, i) => i !== Number(b.dataset.i));
    else if (CRITERIOS[k].min) { delete n[CRITERIOS[k].min]; delete n[CRITERIOS[k].max]; }
    else delete n[k];
    guardarCriterios(c, n);
  }));
  box.querySelector('#critOk')?.addEventListener('click', () => {
    const n = cr(), k = critAbierto, pop = box.querySelector('.crit-pop');
    if (k === 'tipos') n.tipos = [...pop.querySelectorAll('input[name=tipo]:checked')].map(i => i.value);
    else if (k === 'operacion') n.operacion = pop.querySelector('input[name=op]:checked')?.value ?? '';
    else {
      const v = sel => { const x = pop.querySelector(sel).value; return x === '' ? null : Number(x); };
      let [min, max] = [v('#critMin'), v('#critMax')];
      if (min != null && max != null && min > max) [min, max] = [max, min];
      n[CRITERIOS[k].min] = min; n[CRITERIOS[k].max] = max;
    }
    guardarCriterios(c, n);
  });
  const lugar = box.querySelector('#critLugar');
  if (!lugar) return;
  let t;
  lugar.addEventListener('input', () => {
    clearTimeout(t);
    const q = lugar.value.trim();
    if (q.length < 2) { box.querySelector('#critSugs').innerHTML = ''; return; }
    t = setTimeout(async () => {
      lugarSugs = await API.get(`/lugares${API.qs({ q })}`).catch(() => []);
      const ya = new Set((c.criterios?.lugares ?? []).map(l => l.valor));
      box.querySelector('#critSugs').innerHTML = lugarSugs.filter(l => !ya.has(l.valor)).slice(0, 8).map(l =>
        `<button class="crit-sug" data-v="${esc(l.valor)}">${esc(l.nombre)}<small>${esc(l.contexto ?? '')}</small></button>`).join('')
        || '<p class="crit-vacio">Sin coincidencias</p>';
    }, 200);
  });
  box.querySelector('#critSugs').addEventListener('click', e => {
    const s = lugarSugs.find(l => l.valor === e.target.closest('.crit-sug')?.dataset.v);
    if (!s) return;
    const n = cr();
    n.lugares = [...(n.lugares ?? []), { valor: s.valor, nombre: s.nombre, contexto: s.contexto }];
    guardarCriterios(c, n);
  });
}

// ── Render ───────────────────────────────────────────────────────────────────
// Una píldora por etapa, generada de etapas.js: el pipeline trae ocho.
function renderEtapaPills() {
  document.getElementById('etapaPills').innerHTML = ETAPAS.map(e =>
    `<button class="pill-line${filterStatus === e.key ? ' active' : ''}" data-status="${e.key}">${e.label} ` +
    `<span class="pill-count" data-count="${e.key}">0</span></button>`).join('');
}

function renderLista() {
  const box = document.getElementById('clList');
  renderEtapaPills();
  const fc = document.getElementById('fCuenta');
  fc.innerHTML = `<option value="all">Cuenta: todas</option><option value="none">Sin asignar</option>` +
    equipo.map(p => `<option value="${esc(p.id)}">${esc(nombreDe(p))}</option>`).join('');
  fc.value = filterCuenta;
  fc.classList.toggle('on', filterCuenta !== 'all');
  // Cuántos hay de cada estatus, con la búsqueda y la cuenta ya aplicadas.
  const fe = document.getElementById('fEstatus');
  const sinEst = cuentaEstatus();
  fe.innerHTML = `<option value="all">Estatus: todos</option>` +
    ESTATUS.map(e => `<option value="${e.key}">${e.label} (${sinEst[e.key] ?? 0})</option>`).join('') +
    `<option value="none">Sin estatus (${sinEst.none ?? 0})</option>`;
  fe.value = filterEstatus;
  fe.classList.toggle('on', filterEstatus !== 'all');
  const base = clientes.filter(pasaBase);
  document.querySelectorAll('.pill-count[data-count]').forEach(el => {
    const k = el.dataset.count;
    el.textContent = k === 'all' ? base.length : base.filter(c => (c.proceso ?? []).some(p => p.status === k)).length;
  });
  const lista = clientes.filter(pasaFiltro);
  document.getElementById('countTag').hidden = false;
  document.getElementById('countNum').textContent = lista.length;
  document.getElementById('countTotal').textContent = clientes.length;
  if (!lista.length) {
    box.innerHTML = `<p class="cl-empty">${clientes.length ? 'Ningún cliente coincide.' : 'Aún no hay clientes. Crea el primero con “+”.'}</p>`;
    return;
  }
  box.innerHTML = lista.map(c => {
    const ps = c.proceso ?? [];
    const w = n => `${Math.min(n, 8) * 7}px`;
    const resp = c.responsable_nombre || c.responsable;
    return `<div class="cl-item${String(c.id) === selId ? ' on' : ''}" data-id="${esc(c.id)}" role="button" tabindex="0">
      <span class="cl-grip" title="Arrastra para cambiar el orden" aria-hidden="true">&#8942;&#8942;</span>
      <span class="cl-ava">${esc(iniciales(c.nombre))}</span>
      <span class="cl-txt"><b>${esc(c.nombre)}</b><small>${c.estatus ? `<i class="cl-est est-${esc(c.estatus)}">${esc(estatusLabel(c.estatus) ?? c.estatus)}</i>` : ''}${esc(pildoras(c.criterios ?? {}).map(p => p.txt).join(' · ') || c.requerimientos || c.empresa || 'Sin requerimientos')}</small></span>
      <span class="cl-meta">
        <span class="cl-bars"><i style="width:${w(cuenta(ps, 'presentado'))};background:var(--s-presentado)"></i><i style="width:${w(cuenta(ps, 'aprobado'))};background:var(--s-aprobado)"></i><i style="width:${w(cuenta(ps, 'rechazado'))};background:var(--s-rechazado)"></i></span>
        <small>${ps.length} prop.</small>
      </span>
      ${resp ? `<span class="tk-ava cl-resp" style="background:${tono(c.responsable_id ?? resp)}" title="Cuenta: ${esc(resp)}">${esc(iniciales(resp.replace('/', ' ')))}</span>`
             : '<span class="tk-ava cl-resp sin" title="Sin asignar">&#8212;</span>'}
    </div>`;
  }).join('');
}

// ── Tabla de propiedades del cliente ─────────────────────────────────────────
// Cada fila es un proceso (cliente × propiedad). Lleva su número a la izquierda, se
// arrastra del asa para cambiar el orden, y al hacer clic despliega debajo un panel
// con todos los datos de la propiedad, editables, y las tareas ligadas a ella.
const lidDe = p => p.ficha?.source_listing_id ?? (p.ficha?.id ? `pipeline:${p.ficha.id}` : null);
const dinero = n => n != null ? '$' + mx(Math.round(n)) : '—';
const ppmDe = f => f.precio_m2 ?? (f.precio && f.tamano_m2 ? f.precio / f.tamano_m2 : null);
const texto = v => esc(v ?? '—');

// Las columnas que se pueden prender y apagar. `w` es el ancho en px: la rejilla de la
// fila se arma con las que estén prendidas (ver rejilla()).
const COLS = [
  { k: 'presento',  label: 'Presentó',  w: 150, html: p => traeHtml(p) },
  { k: 'tipo',      label: 'Tipo',      w: 84,  html: p => texto(p.ficha.tipo) },
  { k: 'municipio', label: 'Municipio', w: 120, html: p => texto(p.ficha.municipio) },
  { k: 'precio',    label: 'Precio',    w: 104, cls: 'cl-precio', html: p => dinero(p.ficha.precio) },
  { k: 'm2',        label: 'm²',        w: 64,  cls: 'cl-mono', html: p => p.ficha.tamano_m2 ? mx(Math.round(p.ficha.tamano_m2)) : '—' },
  { k: 'ppm',       label: '$/m²',      w: 76,  cls: 'cl-mono', html: p => dinero(ppmDe(p.ficha)) },
  { k: 'junta',     label: 'Junta',     w: 56,  cls: 'cl-mono', html: p => texto(p.junta) },
  { k: 'marca',     label: 'Marca',     w: 100, html: p => texto(p.marca) },
  { k: 'notas',     label: 'Notas',     w: 200, html: p => texto(p.notas || p.ficha.notas) },
  { k: 'estatus',   label: 'Estatus',   w: 132, html: p => `<select class="proc-status e-${esc(p.status)}" data-proc="${esc(p.id)}">${etapaOpciones(p.status)}</select>` },
  { k: 'fecha',     label: 'Fecha',     w: 60,  cls: 'cl-mono', html: p => fecha(p.created_at ?? p.creado_el) },
];
// Qué columnas ve cada quien se queda en su navegador: es gusto, no dato del equipo.
let colsOn = ['presento', 'precio', 'm2', 'estatus', 'fecha'];
try {
  const g = JSON.parse(localStorage.getItem('ol-cl-cols') ?? 'null');
  if (Array.isArray(g)) colsOn = g.filter(k => COLS.some(c => c.k === k));
} catch { /* sin persistencia */ }
const colsVisibles = () => COLS.filter(c => colsOn.includes(c.k));
// asa · número · foto · inmueble · [columnas] · tareas · quitar
function rejilla() {
  const anchos = [18, 26, 48, 180, ...colsVisibles().map(c => c.w), 30, 22];
  const cols = anchos.map((w, i) => i === 3 ? `minmax(${w}px,1fr)` : `${w}px`).join(' ');
  return `--cl-cols:${cols};--cl-min:${anchos.reduce((a, b) => a + b, 0) + (anchos.length - 1) * 10 + 24}px`;
}

const traeKey = p => String(p.trae_id ?? p.trae ?? '');
const filtrando = () => propEtapa !== 'all' || propTrae !== 'all';
const tareasAbiertas = procId => tareas.filter(t => String(t.proceso_id) === String(procId) && t.columna !== 'completado').length;

function filaHtml(c, p) {
  const f = p.ficha ?? {};
  const foto = f.fotos?.[0];
  const pos = (c.proceso ?? []).indexOf(p) + 1;
  const n = tareasAbiertas(p.id);
  return `<div class="cl-tr${abierto === String(p.id) ? ' open' : ''}" data-proc="${esc(p.id)}">
    <span class="cl-grip${filtrando() ? ' off' : ''}" title="${filtrando() ? 'Quita los filtros para reordenar' : 'Arrastra para cambiar el orden'}" aria-hidden="true">&#8942;&#8942;</span>
    <span class="cl-num">${pos}</span>
    ${foto ? `<img class="cl-th-img" src="${srcSeguro(foto)}" alt="">` : '<span class="cl-th-img vacio"></span>'}
    <span class="cl-inm">${esc(f.titulo ?? '(sin título)')}</span>
    ${colsVisibles().map(col => `<span class="cl-c ${col.cls ?? ''}" data-c="${col.k}">${col.html(p)}</span>`).join('')}
    <span class="cl-tn${n ? ' on' : ''}" title="${n ? `${n} ${n === 1 ? 'tarea abierta' : 'tareas abiertas'}` : 'Sin tareas abiertas'}">${n || ''}</span>
    <button class="cl-x" data-proc="${esc(p.id)}" title="Quitar propuesta">&times;</button>
  </div>`;
}
function refrescarFila(c, p) {
  const fila = document.querySelector(`#clDetail .cl-tr[data-proc="${CSS.escape(String(p.id))}"]`);
  if (fila) fila.outerHTML = filaHtml(c, p);
}

function tareaHtml(t, conPropiedad) {
  const hecha = t.columna === 'completado';
  return `<div class="cl-tarea${hecha ? ' done' : ''}">
    <input type="checkbox" class="cl-tchk" data-id="${esc(t.id)}"${hecha ? ' checked' : ''} aria-label="Completada">
    <span class="cl-tt">${esc(t.titulo)}</span>
    ${conPropiedad && t.proceso_titulo ? `<span class="cl-tprop">${esc(t.proceso_titulo)}</span>` : ''}
    <span class="cl-tmeta">${esc(t.asignado_nombre ?? t.asignado_email ?? 'Sin asignar')}${t.vence_el ? ` · vence ${fecha(t.vence_el + 'T12:00')}` : ''}</span>
  </div>`;
}
// El alta rápida. Con `procId` la tarea nace ligada a esa propiedad; sin él se elige
// —o se deja "del cliente", que es una tarea que no cuelga de ninguna propiedad.
function tareaFormHtml(c, procId) {
  return `<form class="cl-tadd" data-proc="${esc(procId ?? '')}">
    <input data-t="titulo" placeholder="+ Nueva tarea${procId ? ' para esta propiedad' : ''}…" aria-label="Nueva tarea">
    ${procId ? '' : `<select data-t="proceso" aria-label="Propiedad"><option value="">Del cliente, sin propiedad</option>
      ${(c.proceso ?? []).map(p => `<option value="${esc(p.id)}">${esc(p.ficha?.titulo ?? '(sin título)')}</option>`).join('')}</select>`}
    <select data-t="asignado" aria-label="Asignar a"><option value="">Sin asignar</option>
      ${equipo.map(u => `<option value="${esc(u.id)}"${String(u.id) === String(c.responsable_id) ? ' selected' : ''}>${esc(nombreDe(u))}</option>`).join('')}</select>
    <input type="date" data-t="vence" aria-label="Vence">
    <button>Agregar</button>
  </form>`;
}

function panelHtml(c, p) {
  const f = p.ficha ?? {};
  const lid = lidDe(p);
  const suyas = tareas.filter(t => String(t.proceso_id) === String(p.id))
    .sort((a, b) => (a.columna === 'completado') - (b.columna === 'completado'));
  const campo = (tb, k, label, v, { tipo = 'text', wide = false, ph = '' } = {}) =>
    `<label class="cl-ef${wide ? ' wide' : ''}"><span>${label}</span>
      <input class="cl-ein" type="${tipo}" data-tb="${tb}" data-f="${k}" value="${esc(v ?? '')}" placeholder="${ph}"${tipo === 'number' ? ' min="0" step="any"' : ''}></label>`;
  const area = (tb, k, label, v, ph) =>
    `<label class="cl-ef wide"><span>${label}</span>
      <textarea class="cl-ein" rows="3" data-tb="${tb}" data-f="${k}" placeholder="${ph}">${esc(v ?? '')}</textarea></label>`;
  return `<div class="cl-exp" data-proc="${esc(p.id)}">
    <div class="cl-exp-main">
      ${f.fotos?.[0] ? `<img class="cl-exp-foto" src="${srcSeguro(f.fotos[0])}" alt="">` : ''}
      <div class="cl-exp-grid">
        ${campo('ficha', 'titulo', 'Inmueble', f.titulo, { wide: true })}
        ${campo('ficha', 'tipo', 'Tipo', f.tipo, { ph: 'Local, terreno…' })}
        ${campo('ficha', 'municipio', 'Municipio', f.municipio)}
        ${campo('ficha', 'tamano_m2', 'Superficie m²', f.tamano_m2, { tipo: 'number' })}
        ${campo('ficha', 'precio', 'Precio', f.precio, { tipo: 'number' })}
        ${campo('ficha', 'precio_m2', 'Precio por m²', f.precio_m2, { tipo: 'number' })}
        ${campo('proceso', 'junta', 'Junta', p.junta, { ph: '1ra, 2da…' })}
        ${campo('proceso', 'marca', 'Marca', p.marca, { ph: 'Marca del cliente' })}
        <label class="cl-ef"><span>Presentó</span>
          <select class="cl-ein" data-tb="proceso" data-f="trae_id">
            <option value="">${!p.trae_id && p.trae ? `${esc(p.trae)} · sin cuenta` : 'Sin asignar'}</option>
            ${equipo.map(u => `<option value="${esc(u.id)}"${String(u.id) === String(p.trae_id) ? ' selected' : ''}>${esc(nombreDe(u))}</option>`).join('')}
          </select></label>
        ${campo('ficha', 'mapa_url', 'Liga del mapa', f.mapa_url, { wide: true, ph: 'https://maps.app.goo.gl/…' })}
        ${area('ficha', 'notas', 'Descripción de la propiedad', f.notas, 'Lo que se sabe del inmueble.')}
        ${area('proceso', 'notas', 'Notas con este cliente', p.notas, 'Qué dijo, qué falta, condiciones…')}
      </div>
    </div>
    <div class="cl-exp-links">
      ${lid ? `<a href="listing.html?id=${encodeURIComponent(lid)}">Abrir ficha completa &#8594;</a>` : ''}
      ${f.mapa_url ? `<a href="${hrefSeguro(f.mapa_url)}" target="_blank" rel="noopener">Ver en mapa &#8599;</a>` : ''}
      <span>Los datos del inmueble son de la ficha: cambian para todos los clientes a los que se presentó.</span>
    </div>
    <div class="cl-exp-tareas">
      <h3>Tareas de esta propiedad · ${suyas.filter(t => t.columna !== 'completado').length}</h3>
      ${suyas.map(t => tareaHtml(t, false)).join('')}
      ${tareaFormHtml(c, p.id)}
    </div>
  </div>`;
}

function propiedadesHtml(c) {
  const ps = c.proceso ?? [];
  const visibles = ps.filter(p => (propEtapa === 'all' || p.status === propEtapa) && (propTrae === 'all' || traeKey(p) === propTrae));
  // Quién ha presentado algo a este cliente, para el filtro. Sin repetir.
  const quienes = [...new Map(ps.filter(p => traeKey(p)).map(p => [traeKey(p), p.trae_nombre || p.trae])).entries()];
  return `
    <div class="cl-props-head">
      <h2>Propiedades · ${filtrando() ? `${visibles.length} de ${ps.length}` : ps.length}</h2>
      ${ETAPAS.map(e => cuenta(ps, e.key) ? `<button class="cl-chip e-${e.key}${propEtapa === e.key ? ' on' : ''}" data-etapa="${e.key}" title="Filtrar por etapa">${cuenta(ps, e.key)} ${e.label.toLowerCase()}</button>` : '').join('')}
      ${quienes.length ? `<select class="cl-fsel${propTrae !== 'all' ? ' on' : ''}" id="propTrae" aria-label="Filtrar por quién presentó">
        <option value="all">Presentó: todos</option>
        ${quienes.map(([k, n]) => `<option value="${esc(k)}"${propTrae === k ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>` : ''}
      <span class="cl-colswrap">
        <button class="cl-btn" id="colsBtn" aria-expanded="${colsAbierto}">Columnas</button>
        ${colsAbierto ? `<div class="crit-pop cl-colspop">${COLS.map(col =>
          `<label><input type="checkbox" class="cl-colchk" value="${col.k}"${colsOn.includes(col.k) ? ' checked' : ''}>${col.label}</label>`).join('')}</div>` : ''}
      </span>
      ${ps.length ? `<a class="cl-proponer" href="index.html?tab=inmobiliaria&amp;pcliente=${encodeURIComponent(c.id)}">Ver en Inmobiliaria</a>` : ''}
      <a class="cl-proponer${ps.length ? ' cl-proponer-2' : ''}" href="index.html">+ Proponer desde Bolsa</a>
    </div>
    <div class="cl-table" style="${rejilla()}">
      ${ps.length ? `<div class="cl-tr cl-th"><span></span><span>N°</span><span></span><span>Inmueble</span>
        ${colsVisibles().map(col => `<span>${col.label}</span>`).join('')}<span></span><span></span></div>` : ''}
      ${visibles.map(p => filaHtml(c, p) + (abierto === String(p.id) ? panelHtml(c, p) : '')).join('')}
      ${ps.length && !visibles.length ? '<p class="cl-empty">Ninguna propiedad pasa el filtro.</p>' : ''}
      <form class="cl-addrow" id="addProp">
        <input placeholder="+ Agregar propiedad: escribe el nombre y Enter…" aria-label="Agregar propiedad">
        <button>Agregar</button>
      </form>
    </div>`;
}

function tareasClienteHtml(c) {
  const orden = tareas.slice().sort((a, b) => (a.columna === 'completado') - (b.columna === 'completado'));
  return `
    <div class="cl-props-head">
      <h2>Tareas · ${tareas.filter(t => t.columna !== 'completado').length} abiertas</h2>
      <a class="cl-proponer" href="tareas.html">Abrir tablero de tareas &#8594;</a>
    </div>
    <div class="cl-tareas">
      ${orden.map(t => tareaHtml(t, true)).join('') || '<p class="cl-empty">Sin tareas para este cliente.</p>'}
      ${tareaFormHtml(c, null)}
    </div>`;
}

function renderDetalle() {
  const box = document.getElementById('clDetail');
  const c = clientes.find(x => String(x.id) === selId);
  document.getElementById('clientes').classList.toggle('has-sel', !!c);
  if (!c) {
    box.innerHTML = `<div class="cl-none">${clientes.length ? 'Selecciona un cliente para ver sus propuestas.' : ''}</div>`;
    return;
  }
  // Al cambiar de cliente: sin fila desplegada, sin filtros de tabla, y sus tareas.
  if (tareasDe !== String(c.id)) {
    abierto = null; propEtapa = 'all'; propTrae = 'all'; colsAbierto = false;
    cargarTareas(String(c.id));
  }
  const etapa = etapaDe(c);
  const tel = telDe(c.contacto);
  const campo = (f, label, ph, wide) => `<label class="cl-f${wide ? ' wide' : ''}"><span>${label}</span>
    <input class="cli-in" data-f="${f}" value="${esc(c[f])}" placeholder="${ph}"></label>`;
  box.innerHTML = `
    <div class="cl-head">
      <button class="cl-back" id="clBack">&#8592; Clientes</button>
      <div class="cl-title">
        <span class="cl-ava lg">${esc(iniciales(c.nombre))}</span>
        <div class="cl-names">
          <input class="cli-in cl-nombre" data-f="nombre" value="${esc(c.nombre)}" aria-label="Nombre">
          <input class="cli-in cl-empresa" data-f="empresa" value="${esc(c.empresa)}" placeholder="Empresa" aria-label="Empresa">
        </div>
        ${etapa ? `<span class="cliente-etapa e-${etapa}">${etapaLabel(etapa)}</span>` : ''}
        <div class="cl-acts">
          ${tel ? `<a class="fx-btn" href="https://wa.me/${tel.length === 10 ? '52' + tel : tel}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
          <button class="fx-btn" id="clDel" title="Eliminar cliente">Eliminar</button>
        </div>
      </div>
      <div class="cl-fields">
        ${cuentaHtml(c)}
        ${estatusHtml(c)}
        ${campo('contacto', 'Contacto', 'Teléfono o correo')}
        ${queBuscaHtml(c)}
      </div>
    </div>
    ${propiedadesHtml(c)}
    ${tareasClienteHtml(c)}`;

  box.querySelectorAll('.cli-in[data-f]').forEach(el => el.addEventListener('blur', e => saveCliente(c.id, e.target.dataset.f, e.target.value)));
  box.querySelector('#clCuenta').addEventListener('change', e => asignarCuenta(c, e.target.value));
  box.querySelector('#clEstatus').addEventListener('change', e => {
    saveCliente(c.id, 'estatus', e.target.value || null);
    e.target.className = `cl-sel${e.target.value ? ` est-${e.target.value}` : ''}`;
  });
  conectarCriterios(c, box);
  document.getElementById('clDel').addEventListener('click', () => deleteCliente(c.id));
  document.getElementById('clBack').addEventListener('click', () => seleccionar(null));
}

function render() {
  if (!currentUser) {
    document.getElementById('clList').innerHTML = '<p class="cl-empty">Inicia sesión para ver tus clientes.</p>';
    return;
  }
  // En escritorio siempre hay un cliente abierto: el primero de la lista si no hay otro.
  if (!selId && matchMedia('(min-width: 801px)').matches) {
    const primero = clientes.find(pasaFiltro);
    if (primero) selId = String(primero.id);
  }
  renderLista();
  renderDetalle();
}

// ── Eventos ──────────────────────────────────────────────────────────────────
document.getElementById('filterbar').addEventListener('click', e => {
  const pill = e.target.closest('.pill-line');
  if (!pill) return;
  document.querySelectorAll('.pill-line[data-status]').forEach(p => p.classList.toggle('active', p === pill));
  filterStatus = pill.dataset.status;
  render();
});
// ── Tabla de propiedades y tareas: un solo juego de listeners ────────────────
// #clDetail se reescribe en cada render y las filas se repintan sueltas (refrescarFila),
// así que estos eventos se delegan en el contenedor, que es el que no cambia.
const detalle = document.getElementById('clDetail');
const cSel = () => clientes.find(x => String(x.id) === selId);
const procDe = el => { const id = el.closest('[data-proc]')?.dataset.proc; return (cSel()?.proceso ?? []).find(p => String(p.id) === id); };

detalle.addEventListener('click', e => {
  const t = e.target;
  if (t.closest('.cl-x')) return removeProceso(t.closest('.cl-x').dataset.proc);
  if (t.closest('#colsBtn')) { colsAbierto = !colsAbierto; return renderDetalle(); }
  const chip = t.closest('.cl-chip[data-etapa]');
  if (chip) { propEtapa = propEtapa === chip.dataset.etapa ? 'all' : chip.dataset.etapa; return renderDetalle(); }
  // Clic en la fila (no en sus controles): despliega o recoge el panel.
  const fila = t.closest('.cl-tr[data-proc]');
  if (fila && !t.closest('select, button, a, input, .cl-grip')) {
    abierto = abierto === fila.dataset.proc ? null : fila.dataset.proc;
    renderDetalle();
  }
});
detalle.addEventListener('change', e => {
  const t = e.target, c = cSel();
  if (!c) return;
  if (t.matches('.proc-status')) return setProcesoStatus(t.dataset.proc, t.value);
  if (t.matches('.cl-tchk')) return completarTarea(t.dataset.id, t.checked);
  if (t.id === 'propTrae') { propTrae = t.value; return renderDetalle(); }
  if (t.matches('.cl-colchk')) {
    colsOn = COLS.map(col => col.k).filter(k => k === t.value ? t.checked : colsOn.includes(k));
    try { localStorage.setItem('ol-cl-cols', JSON.stringify(colsOn)); } catch { /* sin persistencia */ }
    return renderDetalle();
  }
  if (t.matches('.cl-ein')) { const p = procDe(t); if (p) guardarCampo(c, p, t.dataset.tb, t.dataset.f, t.value); }
});
detalle.addEventListener('submit', e => {
  e.preventDefault();
  const c = cSel();
  if (!c) return;
  if (e.target.id === 'addProp') return agregarPropiedad(c, e.target.querySelector('input').value);
  if (e.target.matches('.cl-tadd')) crearTarea(c, e.target);
});
document.addEventListener('click', e => {
  if (colsAbierto && !e.target.closest('.cl-colswrap')) { colsAbierto = false; renderDetalle(); }
});

// Reordenar arrastrando. La fila sólo es arrastrable mientras se sostiene el asa: si
// lo fuera siempre, seleccionar texto o usar el <select> de etapa iniciaría un arrastre.
let arrastrando = null;
const limpiarMarcas = () => detalle.querySelectorAll('.drop-a, .drop-b').forEach(f => f.classList.remove('drop-a', 'drop-b'));
detalle.addEventListener('mousedown', e => {
  const asa = e.target.closest('.cl-grip:not(.off)');
  if (asa) asa.closest('.cl-tr').draggable = true;
});
detalle.addEventListener('mouseup', () => detalle.querySelectorAll('.cl-tr[draggable="true"]').forEach(f => { f.draggable = false; }));
detalle.addEventListener('dragstart', e => {
  const fila = e.target.closest?.('.cl-tr[data-proc]');
  if (!fila?.draggable) return;
  arrastrando = fila.dataset.proc;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', arrastrando);
  fila.classList.add('dragging');
});
detalle.addEventListener('dragover', e => {
  const fila = e.target.closest?.('.cl-tr[data-proc]');
  if (!arrastrando || !fila) return;
  e.preventDefault();
  const r = fila.getBoundingClientRect();
  limpiarMarcas();
  if (fila.dataset.proc !== arrastrando) fila.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-b' : 'drop-a');
});
detalle.addEventListener('drop', e => {
  const fila = e.target.closest?.('.cl-tr[data-proc]');
  const c = cSel();
  if (!arrastrando || !fila || !c) return;
  e.preventDefault();
  const r = fila.getBoundingClientRect();
  const de = arrastrando;
  arrastrando = null;
  reordenar(c, de, fila.dataset.proc, e.clientY > r.top + r.height / 2);
});
detalle.addEventListener('dragend', () => {
  arrastrando = null;
  limpiarMarcas();
  detalle.querySelectorAll('.cl-tr.dragging').forEach(f => { f.classList.remove('dragging'); f.draggable = false; });
});

document.getElementById('fCuenta').addEventListener('change', e => { filterCuenta = e.target.value; render(); });
document.getElementById('fEstatus').addEventListener('change', e => { filterEstatus = e.target.value; render(); });

// ── Orden de la lista de clientes ────────────────────────────────────────────
// Igual que las propiedades de un cliente: se arrastra del asa y el orden es del
// equipo (`cliente.orden`). Con un filtro o una búsqueda puestos se sigue pudiendo:
// los que se ven intercambian lugares entre sí y los demás no se mueven.
function reordenarClientes(deId, aId, despues) {
  const vis = clientes.filter(pasaFiltro).map(c => String(c.id));
  const de = vis.indexOf(deId);
  if (de < 0 || deId === aId) return;
  vis.splice(de, 1);
  const a = vis.indexOf(aId);
  if (a < 0) return;
  vis.splice(a + (despues ? 1 : 0), 0, deId);
  const porId = new Map(clientes.map(c => [String(c.id), c]));
  let i = 0;
  clientes = clientes.map(c => vis.includes(String(c.id)) ? porId.get(vis[i++]) : c);
  API.put('/clientes/orden', { ids: clientes.map(c => c.id) })
    .catch(err => alert('No se pudo guardar el orden: ' + err.message));
  renderLista();
}
const listaEl = document.getElementById('clList');
let arrastrandoCl = null;
const limpiarMarcasCl = () => listaEl.querySelectorAll('.drop-a, .drop-b').forEach(f => f.classList.remove('drop-a', 'drop-b'));
listaEl.addEventListener('mousedown', e => {
  const asa = e.target.closest('.cl-grip');
  if (asa) asa.closest('.cl-item').draggable = true;
});
listaEl.addEventListener('mouseup', () => listaEl.querySelectorAll('.cl-item[draggable="true"]').forEach(f => { f.draggable = false; }));
listaEl.addEventListener('dragstart', e => {
  const it = e.target.closest?.('.cl-item');
  if (!it?.draggable) return;
  arrastrandoCl = it.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', arrastrandoCl);
  it.classList.add('dragging');
});
listaEl.addEventListener('dragover', e => {
  const it = e.target.closest?.('.cl-item');
  if (!arrastrandoCl || !it) return;
  e.preventDefault();
  const r = it.getBoundingClientRect();
  limpiarMarcasCl();
  if (it.dataset.id !== arrastrandoCl) it.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-b' : 'drop-a');
});
listaEl.addEventListener('drop', e => {
  const it = e.target.closest?.('.cl-item');
  if (!arrastrandoCl || !it) return;
  e.preventDefault();
  const r = it.getBoundingClientRect();
  const de = arrastrandoCl;
  arrastrandoCl = null;
  reordenarClientes(de, it.dataset.id, e.clientY > r.top + r.height / 2);
});
listaEl.addEventListener('dragend', () => {
  arrastrandoCl = null;
  limpiarMarcasCl();
  listaEl.querySelectorAll('.cl-item.dragging').forEach(f => { f.classList.remove('dragging'); f.draggable = false; });
});

// El cliente abierto vive en la URL (#id): atrás/adelante y una liga a otro cliente
// desde esta misma página sólo cambian el hash, que no recarga.
window.addEventListener('hashchange', () => {
  const id = decodeURIComponent(location.hash.slice(1)) || null;
  if (id !== selId) { selId = id; critAbierto = null; render(); }
});
listaEl.addEventListener('click', e => {
  const it = e.target.closest('.cl-item');
  if (it && !e.target.closest('.cl-grip')) seleccionar(it.dataset.id);
});
// La fila ya no es un <button> (Firefox no deja arrastrar botones): Enter la abre.
listaEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('.cl-item')) seleccionar(e.target.dataset.id);
});
document.getElementById('clientSearch').addEventListener('input', e => { searchQ = e.target.value.trim(); render(); });
document.getElementById('new-client-btn').addEventListener('click', () => {
  const nombre = prompt('Nombre del cliente:');
  if (nombre?.trim()) createCliente({ nombre: nombre.trim() });
});
// ↑/↓ recorren la lista cuando el foco no está en un campo.
document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select') || !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
  const ids = clientes.filter(pasaFiltro).map(c => String(c.id));
  const i = ids.indexOf(selId);
  const j = e.key === 'ArrowDown' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1);
  if (ids[j] && j !== i) { e.preventDefault(); seleccionar(ids[j]); }
});
document.getElementById('logout-btn').addEventListener('click', async () => {
  await API.logout().catch(() => {});
  location.replace('login.html');
});

API.me().then(async user => {
  currentUser = user;
  document.getElementById('authBox').hidden = true;
  document.getElementById('userBox').hidden = false;
  [equipo] = await Promise.all([API.get('/equipo').catch(() => []), loadClientes()]);
  render();
}).catch(err => console.error('No se pudo validar la sesión:', err));

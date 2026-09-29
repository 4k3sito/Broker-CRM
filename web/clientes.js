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
    render();
  } catch (err) { alert('No se pudo quitar: ' + err.message); }
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
function pasaFiltro(c) {
  if (searchQ && !norm(`${c.nombre} ${c.empresa ?? ''} ${c.contacto ?? ''}`).includes(norm(searchQ))) return false;
  return filterStatus === 'all' || (c.proceso ?? []).some(p => p.status === filterStatus);
}
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
  const base = clientes.filter(c => !searchQ || norm(`${c.nombre} ${c.empresa ?? ''} ${c.contacto ?? ''}`).includes(norm(searchQ)));
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
    return `<button class="cl-item${String(c.id) === selId ? ' on' : ''}" data-id="${esc(c.id)}">
      <span class="cl-ava">${esc(iniciales(c.nombre))}</span>
      <span class="cl-txt"><b>${esc(c.nombre)}</b><small>${esc(pildoras(c.criterios ?? {}).map(p => p.txt).join(' · ') || c.requerimientos || c.empresa || 'Sin requerimientos')}</small></span>
      <span class="cl-meta">
        <span class="cl-bars"><i style="width:${w(cuenta(ps, 'presentado'))};background:var(--s-presentado)"></i><i style="width:${w(cuenta(ps, 'aprobado'))};background:var(--s-aprobado)"></i><i style="width:${w(cuenta(ps, 'rechazado'))};background:var(--s-rechazado)"></i></span>
        <small>${ps.length} prop.</small>
      </span>
    </button>`;
  }).join('');
}

function renderDetalle() {
  const box = document.getElementById('clDetail');
  const c = clientes.find(x => String(x.id) === selId);
  document.getElementById('clientes').classList.toggle('has-sel', !!c);
  if (!c) {
    box.innerHTML = `<div class="cl-none">${clientes.length ? 'Selecciona un cliente para ver sus propuestas.' : ''}</div>`;
    return;
  }
  const ps = c.proceso ?? [];
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
        ${campo('contacto', 'Contacto', 'Teléfono o correo')}
        ${queBuscaHtml(c)}
      </div>
    </div>
    <div class="cl-props-head">
      <h2>Propuestas · ${ps.length}</h2>
      ${ETAPAS.map(e => cuenta(ps, e.key) ? `<span class="cl-chip e-${e.key}">${cuenta(ps, e.key)} ${e.label.toLowerCase()}</span>` : '').join('')}
      <a class="cl-proponer" href="index.html">+ Proponer desde el tablero</a>
    </div>
    ${ps.length ? `<div class="cl-table">
      <div class="cl-tr cl-th"><span></span><span>Inmueble</span><span>Presentó</span><span>Precio</span><span>m²</span><span>Estatus</span><span>Fecha</span><span></span></div>
      ${ps.map(p => {
        const f = p.ficha ?? {};
        const foto = f.fotos?.[0];
        const lid = f.source_listing_id ?? p.listing_id;
        return `<div class="cl-tr">
          ${foto ? `<img class="cl-th-img" src="${hrefSeguro(foto)}" alt="">` : '<span class="cl-th-img vacio"></span>'}
          <span class="cl-inm">${lid ? `<a href="listing.html?id=${encodeURIComponent(lid)}">${esc(f.titulo ?? '(sin título)')}</a>` : esc(f.titulo ?? '(sin título)')}</span>
          ${traeHtml(p)}
          <span class="cl-precio">${f.precio != null ? '$' + mx(Math.round(f.precio)) : '—'}</span>
          <span class="cl-mono">${f.tamano_m2 ? mx(Math.round(f.tamano_m2)) : '—'}</span>
          <select class="proc-status e-${esc(p.status)}" data-proc="${esc(p.id)}">${etapaOpciones(p.status)}</select>
          <span class="cl-mono">${fecha(p.created_at ?? p.creado_el)}</span>
          <button class="cl-x" data-proc="${esc(p.id)}" title="Quitar propuesta">&times;</button>
        </div>`;
      }).join('')}
    </div>` : `<p class="cl-empty pad">Aún sin propuestas. Selecciona inmuebles en el tablero y usa “Asignar a cliente”.</p>`}`;

  box.querySelectorAll('.cli-in[data-f]').forEach(el => el.addEventListener('blur', e => saveCliente(c.id, e.target.dataset.f, e.target.value)));
  box.querySelector('#clCuenta').addEventListener('change', e => asignarCuenta(c, e.target.value));
  conectarCriterios(c, box);
  box.querySelectorAll('.proc-status').forEach(s => s.addEventListener('change', e => setProcesoStatus(e.target.dataset.proc, e.target.value)));
  box.querySelectorAll('.cl-x').forEach(b => b.addEventListener('click', e => removeProceso(e.currentTarget.dataset.proc)));
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
// El cliente abierto vive en la URL (#id): atrás/adelante y una liga a otro cliente
// desde esta misma página sólo cambian el hash, que no recarga.
window.addEventListener('hashchange', () => {
  const id = decodeURIComponent(location.hash.slice(1)) || null;
  if (id !== selId) { selId = id; critAbierto = null; render(); }
});
document.getElementById('clList').addEventListener('click', e => {
  const it = e.target.closest('.cl-item');
  if (it) seleccionar(it.dataset.id);
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

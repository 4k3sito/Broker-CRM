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
      <span class="cl-txt"><b>${esc(c.nombre)}</b><small>${esc(c.requerimientos || c.empresa || 'Sin requerimientos')}</small></span>
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
        ${campo('responsable', 'Cuenta', 'Quién lleva la cuenta')}
        ${campo('contacto', 'Contacto', 'Teléfono o correo')}
        ${campo('requerimientos', 'Qué busca', 'Tipo, m², zona, presupuesto…', true)}
      </div>
    </div>
    <div class="cl-props-head">
      <h2>Propuestas · ${ps.length}</h2>
      ${ETAPAS.map(e => cuenta(ps, e.key) ? `<span class="cl-chip e-${e.key}">${cuenta(ps, e.key)} ${e.label.toLowerCase()}</span>` : '').join('')}
      <a class="cl-proponer" href="index.html">+ Proponer desde el tablero</a>
    </div>
    ${ps.length ? `<div class="cl-table">
      <div class="cl-tr cl-th"><span></span><span>Inmueble</span><span>Precio</span><span>m²</span><span>Estatus</span><span>Fecha</span><span></span></div>
      ${ps.map(p => {
        const f = p.ficha ?? {};
        const foto = f.fotos?.[0];
        const lid = f.source_listing_id ?? p.listing_id;
        return `<div class="cl-tr">
          ${foto ? `<img class="cl-th-img" src="${hrefSeguro(foto)}" alt="">` : '<span class="cl-th-img vacio"></span>'}
          <span class="cl-inm">${lid ? `<a href="listing.html?id=${encodeURIComponent(lid)}">${esc(f.titulo ?? '(sin título)')}</a>` : esc(f.titulo ?? '(sin título)')}</span>
          <span class="cl-precio">${f.precio != null ? '$' + mx(Math.round(f.precio)) : '—'}</span>
          <span class="cl-mono">${f.tamano_m2 ? mx(Math.round(f.tamano_m2)) : '—'}</span>
          <select class="proc-status e-${esc(p.status)}" data-proc="${esc(p.id)}">${etapaOpciones(p.status)}</select>
          <span class="cl-mono">${fecha(p.created_at ?? p.creado_el)}</span>
          <button class="cl-x" data-proc="${esc(p.id)}" title="Quitar propuesta">&times;</button>
        </div>`;
      }).join('')}
    </div>` : `<p class="cl-empty pad">Aún sin propuestas. Selecciona inmuebles en el tablero y usa “Asignar a cliente”.</p>`}`;

  box.querySelectorAll('.cli-in[data-f]').forEach(el => el.addEventListener('blur', e => saveCliente(c.id, e.target.dataset.f, e.target.value)));
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
  await loadClientes();
  render();
}).catch(err => console.error('No se pudo validar la sesión:', err));

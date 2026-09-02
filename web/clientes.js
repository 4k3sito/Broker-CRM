
const PROC_STATUS = ['presentado', 'aprobado', 'rechazado'];
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
const escAttr = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const norm = s => (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

let currentUser  = null;
let clientes     = [];          // cada uno con .proceso[] embebido
let filterStatus = 'all';
let searchQ      = '';

// ── Data ─────────────────────────────────────────────────────────────────────

async function loadClientes() {
  clientes = await API.get('/clientes').catch(err => {
    console.warn('Carga de clientes falló:', err.message);
    return [];
  });
}

async function createCliente(patch) {
  try {
    clientes.unshift(await API.post('/clientes', patch));
    render();
  } catch (err) {
    alert('No se pudo crear el cliente: ' + err.message);
  }
}

function saveCliente(id, field, value) {
  const c = clientes.find(x => x.id === id);
  if (c) c[field] = value;
  API.patch(`/clientes/${id}`, { [field]: value })
    .catch(err => console.warn('No se pudo guardar el cliente:', err.message));
}

async function deleteCliente(id) {
  if (!confirm('¿Eliminar este cliente y todos sus procesos?')) return;
  try {
    await API.del(`/clientes/${id}`);
    clientes = clientes.filter(c => c.id !== id);
    render();
  } catch (err) {
    alert('No se pudo eliminar: ' + err.message);
  }
}

function setProcesoStatus(procId, status) {
  for (const c of clientes) {
    const p = (c.proceso ?? []).find(x => x.id === procId);
    if (p) p.status = status;
  }
  API.patch(`/procesos/${procId}`, { status })
    .catch(err => console.warn('No se pudo guardar el proceso:', err.message));
  render();
}

// ── Render ───────────────────────────────────────────────────────────────────

const PROC_COLOR = { presentado: 'var(--s-presentado)', aprobado: 'var(--s-aprobado)',
                     rechazado: 'var(--s-rechazado)' };
const ICON_WARN = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

// Un cliente pasa el filtro de estado si alguno de sus procesos está en ese estado.
function pasaFiltro(c) {
  if (searchQ && !norm(c.nombre).includes(norm(searchQ))) return false;
  if (filterStatus !== 'all' && !(c.proceso ?? []).some(p => p.status === filterStatus)) return false;
  return true;
}

function cuenta(procs, estado) {
  return procs.filter(p => p.status === estado).length;
}

// aprobados / (aprobados + rechazados). Sin decisiones todavía no hay tasa que dar.
function tasaAceptacion(aprob, rech) {
  const decididos = aprob + rech;
  return decididos ? Math.round((aprob / decididos) * 100) + '%' : '—';
}

function statCell(n, label, color) {
  return `<div class="stat"><span class="stat-num" style="color:${color}">${n}</span>` +
         `<span class="stat-label">${label}</span></div>`;
}

// Los KPI del encabezado. Cuatro cifras Bodoni separadas por filete, a la derecha
// del título — no la fila de stats a lo ancho que tenía antes.
function renderStatsGlobal(filtrados) {
  const procs = filtrados.flatMap(c => c.proceso ?? []);
  const kpi = (n, label, color) =>
    `<div class="pg-kpi"><span class="pg-kpi-n" style="color:${color}">${n}</span>` +
    `<span class="pg-kpi-l">${label}</span></div>`;
  document.getElementById('kpis').innerHTML =
    kpi(filtrados.length, 'clientes', 'var(--ink)') +
    kpi(cuenta(procs, 'presentado'), 'en proceso', PROC_COLOR.presentado) +
    kpi(cuenta(procs, 'aprobado'),   'aprobados',  PROC_COLOR.aprobado) +
    kpi(cuenta(procs, 'rechazado'),  'rechazados', PROC_COLOR.rechazado);
}

function renderPillCounts() {
  const base = clientes.filter(c => !searchQ || norm(c.nombre).includes(norm(searchQ)));
  document.querySelectorAll('.pill-count[data-count]').forEach(el => {
    const k = el.dataset.count;
    el.textContent = k === 'all'
      ? base.length
      : base.filter(c => (c.proceso ?? []).some(p => p.status === k)).length;
  });
}

function procesoRow(p) {
  const titulo = p.ficha?.titulo ?? '(propiedad sin título)';
  const opts = PROC_STATUS.map(s =>
    `<option value="${s}"${s === p.status ? ' selected' : ''}>${cap(s)}</option>`).join('');
  return `<div class="proc-row">
    <span class="proc-ficha" title="${escAttr(titulo)}">${escAttr(titulo)}</span>
    <select class="proc-status status-${p.status}" data-proc="${p.id}">${opts}</select>
  </div>`;
}

function campoRow(c, campo, label, placeholder) {
  return `<div class="cliente-field">
    <span>${label}</span>
    <input class="cli-in" data-f="${campo}" placeholder="${placeholder}" value="${escAttr(c[campo])}">
  </div>`;
}

// Etapa del cliente: la del proceso más avanzado que tenga. No hay columna
// `etapa` en la base — el mock la pinta como dato propio, aquí se deriva.
function etapaDe(c) {
  const st = (c.proceso ?? []).map(p => p.status);
  if (st.includes('aprobado')) return 'aprobado';
  if (st.includes('presentado')) return 'presentado';
  if (st.includes('rechazado')) return 'rechazado';
  return null;
}

// Iniciales para el avatar: dos palabras como mucho, sin emoji ni foto.
const iniciales = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

function campoRow(c, campo, label, placeholder) {
  return `<div class="cliente-field">
    <span>${label}</span>
    <input class="cli-in" data-f="${campo}" placeholder="${placeholder}" value="${escAttr(c[campo])}">
  </div>`;
}

function clienteCard(c) {
  const todos = c.proceso ?? [];
  const procs = todos.filter(p => filterStatus === 'all' || p.status === filterStatus);
  const etapa = etapaDe(c);
  const pend = cuenta(todos, 'presentado');
  return `<article class="cliente-card" data-id="${c.id}">
    <div class="cliente-head">
      <span class="cliente-ava">${escAttr(iniciales(c.nombre))}</span>
      <div class="cliente-id">
        <input class="cliente-nombre cli-in" data-f="nombre" value="${escAttr(c.nombre)}">
        <input class="cliente-sub cli-in" data-f="empresa" placeholder="Empresa" value="${escAttr(c.empresa)}">
      </div>
      ${etapa ? `<span class="cliente-etapa status-${etapa}">${cap(etapa)}</span>` : ''}
      <button class="cliente-del" title="Eliminar cliente">&times;</button>
    </div>
    ${campoRow(c, 'contacto', 'Contacto', 'Teléfono o correo')}
    ${campoRow(c, 'requerimientos', 'Qué busca', 'Requerimientos')}
    <div class="card-sep"></div>
    <div class="cliente-foot">
      <span class="cliente-chip">${todos.length} ${todos.length === 1 ? 'inmueble' : 'inmuebles'}</span>
      <span class="cliente-pend${pend ? '' : ' cero'}">${pend ? `${pend} pendiente${pend === 1 ? '' : 's'}` : 'sin pendientes'}</span>
    </div>
    <div class="cliente-procs">
      ${procs.length ? procs.map(procesoRow).join('')
        : `<div class="proc-empty">${todos.length
             ? 'Sin procesos con este estatus'
             : 'Aún sin propiedades — agrégalas desde una propiedad'}</div>`}
    </div>
  </article>`;
}

function render() {
  const main = document.getElementById('clientesBody');
  if (!currentUser) {
    main.innerHTML = `<p class="pg-empty">Inicia sesión para ver y administrar tus clientes.</p>`;
    return;
  }
  const filtrados = clientes.filter(pasaFiltro);

  document.getElementById('countTag').hidden = false;
  document.getElementById('countNum').textContent   = filtrados.length;
  document.getElementById('countTotal').textContent = clientes.length;
  renderPillCounts();
  renderStatsGlobal(filtrados);

  if (!filtrados.length) {
    main.innerHTML = `<p class="pg-empty">${clientes.length
      ? 'Ningún cliente coincide con la búsqueda.'
      : 'Aún no tienes clientes — crea el primero con “+ Nuevo cliente”'}</p>`;
    return;
  }
  main.innerHTML = `<div class="clientes-grid">${filtrados.map(clienteCard).join('')}</div>`;

  main.querySelectorAll('.cliente-card').forEach(card => {
    const id = card.dataset.id;
    card.querySelectorAll('.cli-in[data-f]').forEach(el =>
      el.addEventListener('blur', e => saveCliente(id, e.target.dataset.f, e.target.value)));
    card.querySelector('.cliente-del').addEventListener('click', () => deleteCliente(id));
    card.querySelectorAll('.proc-status').forEach(sel =>
      sel.addEventListener('change', e => setProcesoStatus(e.target.dataset.proc, e.target.value)));
  });
}

// ── New client form ──────────────────────────────────────────────────────────

function openNewClient() {
  if (!currentUser) { alert('Inicia sesión para crear clientes.'); return; }
  const nombre = prompt('Nombre del cliente:');
  if (!nombre || !nombre.trim()) return;
  createCliente({ nombre: nombre.trim() });
}

// ── Events ───────────────────────────────────────────────────────────────────

document.getElementById('filterbar').addEventListener('click', e => {
  const pill = e.target.closest('.pill-line');
  if (!pill) return;
  document.querySelectorAll('.pill-line[data-status]').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
  filterStatus = pill.dataset.status;
  render();
});
document.getElementById('clientSearch').addEventListener('input', e => { searchQ = e.target.value.trim(); render(); });
document.getElementById('new-client-btn').addEventListener('click', openNewClient);

document.getElementById('logout-btn').addEventListener('click', async () => {
  await API.logout().catch(() => {});
  location.replace('login.html');
});

// ── Init ─────────────────────────────────────────────────────────────────────

API.me().then(async user => {
  currentUser = user;
  document.getElementById('authBox').hidden = true;
  document.getElementById('userBox').hidden = false;
  await loadClientes();
  render();
}).catch(err => console.error('No se pudo validar la sesión:', err));

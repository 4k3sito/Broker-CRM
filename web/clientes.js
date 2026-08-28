
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

function renderStatsGlobal(filtrados) {
  const procs = filtrados.flatMap(c => c.proceso ?? []);
  const aprob = cuenta(procs, 'aprobado');
  const rech  = cuenta(procs, 'rechazado');
  const pend  = cuenta(procs, 'presentado');
  const box = document.getElementById('statsbar');
  box.hidden = false;
  box.innerHTML =
    `<div class="stat stat-main"><span class="stat-num">${filtrados.length}</span>` +
    `<span class="stat-label">Clientes activos</span></div>` +
    statCell(procs.length, 'propuestas', 'var(--ink)') +
    statCell(pend,  'pendientes', PROC_COLOR.presentado) +
    statCell(aprob, 'aprobadas',  PROC_COLOR.aprobado) +
    statCell(rech,  'rechazadas', PROC_COLOR.rechazado) +
    statCell(tasaAceptacion(aprob, rech), 'aceptación', 'var(--accent)');
}

// Los contadores de las píldoras cuentan clientes, no procesos: dicen a cuántos
// llegarías si cambiaras de estado, con la búsqueda ya aplicada.
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

function clienteStats(c) {
  const procs = c.proceso ?? [];
  const a = cuenta(procs, 'aprobado');
  const r = cuenta(procs, 'rechazado');
  const p = cuenta(procs, 'presentado');
  const celda = (n, label, color) =>
    `<div><strong style="color:${color}">${n}</strong><span>${label}</span></div>`;
  return `<div class="cliente-stats">
    ${celda(procs.length, 'propuestas', 'var(--ink)')}
    ${celda(a, 'aprob.', PROC_COLOR.aprobado)}
    ${celda(r, 'rech.',  PROC_COLOR.rechazado)}
    ${celda(p, 'pend.',  PROC_COLOR.presentado)}
    ${celda(tasaAceptacion(a, r), 'aceptación', 'var(--accent)')}
  </div>`;
}

function clienteCard(c) {
  const todos = c.proceso ?? [];
  const procs = todos.filter(p => filterStatus === 'all' || p.status === filterStatus);
  const aviso = todos.length === 0
    ? `<div class="cliente-warn">${ICON_WARN}Sin propuestas presentadas</div>` : '';
  return `<article class="cliente-card" data-id="${c.id}">
    <div class="cliente-head">
      <input class="cliente-nombre cli-in" data-f="nombre" value="${escAttr(c.nombre)}">
      <button class="cliente-del" title="Eliminar cliente">&times;</button>
    </div>
    ${campoRow(c, 'contacto', 'Contacto', 'Teléfono o correo')}
    ${campoRow(c, 'empresa', 'Empresa', 'Empresa')}
    ${campoRow(c, 'requerimientos', 'Qué busca', 'Requerimientos')}
    ${aviso}
    ${clienteStats(c)}
    <div class="cliente-procs">
      <div class="cliente-procs-label">
        <span>Procesos</span><span class="proc-count">${todos.length}</span>
      </div>
      ${procs.length ? procs.map(procesoRow).join('')
        : `<div class="proc-empty">${todos.length
             ? 'Sin procesos con este estatus'
             : 'Aún sin propiedades — agrégalas desde una propiedad'}</div>`}
    </div>
  </article>`;
}

function render() {
  const main = document.getElementById('clientes');
  if (!currentUser) {
    main.innerHTML = `<p class="empty">Inicia sesión para ver y administrar tus clientes.</p>`;
    return;
  }
  const filtrados = clientes.filter(pasaFiltro);

  document.getElementById('countTag').hidden = false;
  document.getElementById('countNum').textContent   = filtrados.length;
  document.getElementById('countTotal').textContent = clientes.length;
  renderPillCounts();
  renderStatsGlobal(filtrados);

  if (!filtrados.length) {
    main.innerHTML = `<p class="empty">${clientes.length
      ? 'Sin clientes para este filtro'
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
  const pill = e.target.closest('.pill');
  if (!pill) return;
  document.querySelectorAll('.pill[data-status]').forEach(p => p.classList.remove('active'));
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
  document.getElementById('userEmail').textContent = user.email;
  await loadClientes();
  render();
}).catch(err => console.error('No se pudo validar la sesión:', err));

// Las etapas de un proceso vienen de etapas.js, compartido con tareas y la ficha.

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
    kpi(procs.filter(p => etapaActiva(p.status)).length, 'en proceso', 'var(--e-presentado)') +
    kpi(cuenta(procs, 'aprobado'),  'aprobados',   'var(--e-aprobado)') +
    kpi(cuenta(procs, 'rechazado'), 'descartados', 'var(--e-rechazado)');
}

// Una píldora por etapa, generada de etapas.js en vez de escrita en el HTML: eran
// tres fijas y el pipeline trae ocho.
function renderEtapaPills() {
  document.getElementById('etapaPills').innerHTML = ETAPAS.map(e =>
    `<button class="pill-line${filterStatus === e.key ? ' active' : ''}" data-status="${e.key}">${e.label} ` +
    `<span class="pill-count" data-count="${e.key}">0</span></button>`).join('');
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
  return `<div class="proc-row">
    <span class="proc-ficha" title="${esc(titulo)}">${esc(titulo)}</span>
    <select class="proc-status e-${esc(p.status)}" data-proc="${p.id}">${etapaOpciones(p.status)}</select>
  </div>`;
}

// Etapa del cliente: la del proceso más avanzado que tenga. No hay columna
// `etapa` en la base — el mock la pinta como dato propio, aquí se deriva.
const etapaDe = c => etapaMayor((c.proceso ?? []).map(p => p.status));

// Iniciales para el avatar: dos palabras como mucho, sin emoji ni foto.
const iniciales = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

function campoRow(c, campo, label, placeholder) {
  return `<div class="cliente-field">
    <span>${label}</span>
    <input class="cli-in" data-f="${campo}" placeholder="${placeholder}" value="${esc(c[campo])}">
  </div>`;
}

function clienteCard(c) {
  const todos = c.proceso ?? [];
  // Sin filtro, lo descartado se cuenta pero no se lista: con el pipeline importado
  // un cliente grande trae docenas de propiedades ya descartadas.
  const procs = todos.filter(p => filterStatus === 'all' ? p.status !== 'rechazado' : p.status === filterStatus);
  const ocultos = filterStatus === 'all' ? cuenta(todos, 'rechazado') : 0;
  const etapa = etapaDe(c);
  const pend = todos.filter(p => etapaActiva(p.status) && p.status !== 'cerrado').length;
  return `<article class="cliente-card" data-id="${c.id}">
    <div class="cliente-head">
      <span class="cliente-ava">${esc(iniciales(c.nombre))}</span>
      <div class="cliente-id">
        <input class="cliente-nombre cli-in" data-f="nombre" value="${esc(c.nombre)}">
        <input class="cliente-sub cli-in" data-f="empresa" placeholder="Empresa" value="${esc(c.empresa)}">
      </div>
      ${etapa ? `<span class="cliente-etapa e-${etapa}">${etapaLabel(etapa)}</span>` : ''}
      <button class="cliente-del" title="Eliminar cliente">&times;</button>
    </div>
    ${campoRow(c, 'responsable', 'Cuenta', 'Quién lleva la cuenta')}
    ${campoRow(c, 'contacto', 'Contacto', 'Teléfono o correo')}
    ${campoRow(c, 'requerimientos', 'Qué busca', 'Requerimientos')}
    <div class="card-sep"></div>
    <div class="cliente-foot">
      <span class="cliente-chip">${todos.length} ${todos.length === 1 ? 'inmueble' : 'inmuebles'}</span>
      <span class="cliente-pend${pend ? '' : ' cero'}">${pend ? `${pend} en proceso` : 'sin pendientes'}</span>
    </div>
    <div class="cliente-procs">
      ${procs.length ? procs.map(procesoRow).join('')
        : `<div class="proc-empty">${todos.length
             ? 'Sin procesos con este estatus'
             : 'Aún sin propiedades — agrégalas desde una propiedad'}</div>`}
      ${ocultos ? `<div class="proc-empty">${ocultos} descartada${ocultos === 1 ? '' : 's'} sin mostrar</div>` : ''}
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
  renderEtapaPills();
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

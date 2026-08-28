
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

function procesoRow(p) {
  const titulo = p.ficha?.titulo ?? '(propiedad sin título)';
  const opts = PROC_STATUS.map(s => `<option value="${s}"${s === p.status ? ' selected' : ''}>${cap(s)}</option>`).join('');
  return `<div class="proc-row">
    <span class="proc-ficha">${escAttr(titulo)}</span>
    <select class="proc-status status-${p.status}" data-proc="${p.id}">${opts}</select>
  </div>`;
}

function clienteStats(c) {
  const procs = c.proceso ?? [];
  const aprob = procs.filter(p => p.status === 'aprobado').length;
  const rech  = procs.filter(p => p.status === 'rechazado').length;
  const pend  = procs.filter(p => p.status === 'presentado').length;
  const decididos = aprob + rech;
  const tasa = decididos ? Math.round((aprob / decididos) * 100) + '%' : '—';
  return `<div class="cliente-stats">
    <div><strong>${procs.length}</strong><span>propuestas</span></div>
    <div><strong style="color:var(--s-rentado)">${aprob}</strong><span>aprob.</span></div>
    <div><strong style="color:#B5542F">${rech}</strong><span>rech.</span></div>
    <div><strong style="color:var(--s-nuevo)">${pend}</strong><span>pend.</span></div>
    <div class="stat-tasa"><strong>${tasa}</strong><span>aceptación</span></div>
  </div>`;
}

function clienteCard(c) {
  const total = (c.proceso ?? []).length;
  const procs = (c.proceso ?? []).filter(p => filterStatus === 'all' || p.status === filterStatus);
  const reminder = total === 0
    ? `<div class="cliente-warn">&#9888; Sin propuestas presentadas — recuérdale ofrecerle una propiedad.</div>` : '';
  return `<article class="cliente-card" data-id="${c.id}">
    <div class="cliente-head">
      <input class="cliente-nombre cli-in" data-f="nombre" value="${escAttr(c.nombre)}">
      <button class="cliente-del" title="Eliminar cliente">&times;</button>
    </div>
    <div class="cliente-fields">
      <input class="cli-in" data-f="contacto" placeholder="Contacto (tel / correo)" value="${escAttr(c.contacto)}">
      <input class="cli-in" data-f="empresa" placeholder="Empresa" value="${escAttr(c.empresa)}">
      <input class="cli-in" data-f="requerimientos" placeholder="Qué busca / requerimientos" value="${escAttr(c.requerimientos)}">
    </div>
    ${reminder}
    ${clienteStats(c)}
    <div class="cliente-procs">
      <div class="cliente-procs-label">Procesos <span class="proc-count">${total}</span></div>
      ${procs.length ? procs.map(procesoRow).join('')
        : `<p class="ficha-hint">${total ? 'Sin procesos con este estatus.' : 'Aún sin propiedades. Agrégalo desde una propiedad.'}</p>`}
    </div>
  </article>`;
}

function render() {
  const main = document.getElementById('clientes');
  if (!currentUser) {
    main.innerHTML = `<p class="empty">Inicia sesión para ver y administrar tus clientes.</p>`;
    return;
  }
  const filtered = clientes.filter(c => {
    if (searchQ && !norm(c.nombre).includes(norm(searchQ))) return false;
    if (filterStatus !== 'all' && !(c.proceso ?? []).some(p => p.status === filterStatus)) return false;
    return true;
  });
  if (!filtered.length) {
    main.innerHTML = `<p class="empty">${clientes.length ? 'Sin clientes para este filtro.' : 'Aún no tienes clientes. Crea el primero con “＋ Nuevo cliente”.'}</p>`;
    return;
  }
  main.innerHTML = `<div class="clientes-grid">${filtered.map(clienteCard).join('')}</div>`;

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

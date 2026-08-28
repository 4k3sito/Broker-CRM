// Tablero de tareas del equipo. Mismo patrón que app.js: estado global mutable +
// un render() que lo recalcula todo. Sin diffing y sin framework.
//
// A diferencia del resto del CRM, las tareas NO se filtran por usuario: son de
// equipo. Ver el comentario en api/main.py y SECURITY.md §5.

const COLS = [
  { key: 'pendiente',  label: 'Pendiente'  },
  { key: 'asignado',   label: 'Asignado'   },
  { key: 'encurso',    label: 'En curso'   },
  { key: 'completado', label: 'Completado' },
];
const PRIOS = ['alta', 'media', 'baja'];
const TIPOS = ['Visita', 'Llamada', 'Fotos', 'Contrato', 'Documentos', 'Publicación', 'Seguimiento', 'Otro'];

let tareas = [], equipo = [], vista = 'tablero', prio = 'all', persona = null, q = '';
let abierta = null;              // id de la tarea en el panel, o 'nueva'
let arrastrando = null;

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const norm = s => (s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// El tono del avatar sale del id, no de una columna: mismo color siempre para la
// misma persona sin tener que guardarlo.
const TONOS = ['#2B3FC4', '#1F6F4A', '#A85F14', '#6B3FB5', '#A83B22', '#6B7D6E', '#83808C'];
const tono = id => TONOS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % TONOS.length];
const iniciales = p => (p?.nombre || p?.email || '?').trim().split(/\s+/).slice(0, 2)
  .map(w => w[0]).join('').toUpperCase();

// ── Checklist en markdown ────────────────────────────────────────────────────
// El diseño escribe el checklist dentro de la descripción como `- [ ]` / `- [x]`.
// Se lee de ahí en vez de tener su propia tabla.
const RE_CHK = /^(\s*[-*]\s*\[)( |x|X)(\]\s*)(.*)$/;

function checklist(desc) {
  return (desc ?? '').split('\n').reduce((acc, linea, i) => {
    const m = linea.match(RE_CHK);
    if (m) acc.push({ i, done: m[2].toLowerCase() === 'x', texto: m[4] });
    return acc;
  }, []);
}

function marcar(desc, indice, done) {
  const lineas = (desc ?? '').split('\n');
  const m = lineas[indice]?.match(RE_CHK);
  if (m) lineas[indice] = `${m[1]}${done ? 'x' : ' '}${m[3]}${m[4]}`;
  return lineas.join('\n');
}

// ── Datos ────────────────────────────────────────────────────────────────────
async function cargar() {
  [tareas, equipo] = await Promise.all([API.get('/tareas'), API.get('/equipo')]);
  render();
}

async function guardar(id, patch) {
  const i = tareas.findIndex(t => t.id === id);
  const previo = tareas[i];
  tareas[i] = { ...previo, ...patch };          // optimista: el tablero no debe parpadear
  render();
  try {
    tareas[i] = await API.patch(`/tareas/${id}`, patch);
  } catch (err) {
    tareas[i] = previo;                          // el servidor manda: se revierte
    alert(err.message);
  }
  render();
}

function visibles() {
  return tareas.filter(t => {
    if (prio !== 'all' && t.prioridad !== prio) return false;
    if (persona && t.asignado_a !== persona) return false;
    if (q && !norm(`${t.titulo} ${t.listing_id ?? ''} ${t.cliente_nombre ?? ''}`).includes(norm(q))) return false;
    return true;
  });
}

// ── Render ───────────────────────────────────────────────────────────────────
function pill(txt, activo, onClick, extra = '') {
  const b = document.createElement('button');
  b.className = `pill${activo ? ' active' : ''}${extra}`;
  b.innerHTML = txt;
  b.addEventListener('click', onClick);
  return b;
}

function tarjeta(t) {
  const p = equipo.find(e => e.id === t.asignado_a);
  const chk = checklist(t.descripcion);
  const hechas = chk.filter(c => c.done).length;
  const tarde = t.vence_el && t.vence_el < new Date().toISOString().slice(0, 10)
                && t.columna !== 'completado';
  const art = document.createElement('article');
  art.className = `tk p-${t.prioridad}${arrastrando === t.id ? ' dragging' : ''}`;
  art.draggable = true;
  art.innerHTML = `
    <div class="tk-top">
      <span class="tk-tipo">${esc(t.tipo ?? 'Tarea')}</span>
      <span class="tk-prio p-${t.prioridad}">${t.prioridad}</span>
    </div>
    <div class="tk-titulo">${esc(t.titulo)}</div>
    <div class="tk-meta">
      ${t.listing_id ? `<span class="tk-cod">${esc(t.listing_id)}</span>` : ''}
      ${t.cliente_nombre ? `<span>${esc(t.cliente_nombre)}</span>` : ''}
      ${t.vence_el ? `<span class="tk-vence${tarde ? ' tarde' : ''}">${t.vence_el}</span>` : ''}
    </div>
    <div class="tk-foot">
      ${chk.length ? `<span class="tk-chk">${hechas}/${chk.length}</span>` : ''}
      <span class="tk-ava${p ? '' : ' sin'}" ${p ? `style="background:${tono(p.id)}"` : ''}
            title="${esc(p?.nombre ?? p?.email ?? 'Sin asignar')}">${p ? iniciales(p) : '—'}</span>
    </div>`;
  art.addEventListener('dragstart', e => {
    arrastrando = t.id;
    e.dataTransfer.effectAllowed = 'move';
    art.classList.add('dragging');
  });
  art.addEventListener('dragend', () => { arrastrando = null; render(); });
  art.addEventListener('click', () => { abierta = t.id; render(); });
  return art;
}

function zonaSoltar(el, alSoltar) {
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('over');
    if (arrastrando != null) alSoltar(arrastrando);
    arrastrando = null;
  });
}

function renderTablero(lista) {
  const kb = document.createElement('div');
  kb.className = 'kb';
  for (const col of COLS) {
    const items = lista.filter(t => t.columna === col.key);
    const div = document.createElement('div');
    div.className = 'kb-col';
    div.innerHTML = `<div class="kb-head"><span class="kb-dot" style="background:var(--c-${col.key})"></span>${col.label}<span class="kb-n">${items.length}</span></div>`;
    const cont = document.createElement('div');
    cont.className = 'kb-list';
    items.forEach(t => cont.appendChild(tarjeta(t)));
    if (!items.length) cont.innerHTML = '<div class="kb-empty">Vacío</div>';
    div.appendChild(cont);
    // Soltar en la columna mueve la tarea; sin asignado, "asignado" no tiene sentido.
    zonaSoltar(div, id => {
      const t = tareas.find(x => x.id === id);
      if (col.key === 'asignado' && !t.asignado_a) return alert('Asigna la tarea a alguien primero.');
      if (t.columna !== col.key) guardar(id, { columna: col.key });
    });
    kb.appendChild(div);
  }
  return kb;
}

function renderEquipo(lista) {
  const wrap = document.createElement('div');
  wrap.className = 'tk-matrix';
  const tabla = document.createElement('table');
  tabla.innerHTML = `<thead><tr><th>Persona</th>${COLS.map(c => `<th>${c.label}</th>`).join('')}</tr></thead>`;
  const tbody = document.createElement('tbody');
  // Una fila por persona, más una para lo que no tiene dueño.
  const filas = [...equipo, { id: null, nombre: 'Sin asignar', rol: '—' }];
  for (const p of filas) {
    const tr = document.createElement('tr');
    const th = document.createElement('td');
    th.innerHTML = `<div class="tk-persona">
      <span class="tk-ava${p.id ? '' : ' sin'}" ${p.id ? `style="background:${tono(p.id)}"` : ''}>${p.id ? iniciales(p) : '—'}</span>
      <span class="tk-persona-n"><strong>${esc(p.nombre ?? p.email)}</strong><span>${esc(p.rol ?? '')}</span></span>
    </div>`;
    tr.appendChild(th);
    for (const col of COLS) {
      const td = document.createElement('td');
      const cell = document.createElement('div');
      cell.className = 'tk-cell';
      lista.filter(t => t.asignado_a === p.id && t.columna === col.key)
           .forEach(t => cell.appendChild(tarjeta(t)));
      td.appendChild(cell);
      // Soltar en una celda hace las dos cosas a la vez: reasigna y mueve.
      zonaSoltar(td, id => guardar(id, { asignado_a: p.id, columna: col.key }));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  tabla.appendChild(tbody);
  wrap.appendChild(tabla);
  return wrap;
}

function renderStats(lista) {
  const n = k => lista.filter(t => t.columna === k).length;
  const celda = (num, label, color) =>
    `<div class="stat"><span class="stat-num" style="color:${color}">${num}</span><span class="stat-label">${label}</span></div>`;
  document.getElementById('statsBar').innerHTML =
    `<div class="stat stat-main"><span class="stat-num">${lista.length}</span><span class="stat-label">Tareas visibles</span></div>` +
    COLS.map(c => celda(n(c.key), c.label, `var(--c-${c.key})`)).join('') +
    celda(lista.filter(t => t.prioridad === 'alta' && t.columna !== 'completado').length,
          'alta prioridad', 'var(--p-alta)');
}

function opciones(lista, sel, valor = x => x, texto = x => x) {
  return lista.map(x => `<option value="${esc(valor(x))}"${valor(x) === sel ? ' selected' : ''}>${esc(texto(x))}</option>`).join('');
}

function renderPanel() {
  const side = document.getElementById('side');
  const scrim = document.getElementById('scrim');
  if (!abierta) { side.hidden = scrim.hidden = true; return; }
  side.hidden = scrim.hidden = false;

  const nueva = abierta === 'nueva';
  const t = nueva
    ? { titulo: '', tipo: 'Visita', prioridad: 'media', columna: 'pendiente',
        asignado_a: null, listing_id: '', descripcion: '', vence_el: null }
    : tareas.find(x => x.id === abierta);
  if (!t) { abierta = null; return renderPanel(); }

  const chk = checklist(t.descripcion);
  side.innerHTML = `
    <div class="tk-side-head">
      <h2>${nueva ? 'Nueva tarea' : esc(t.titulo)}</h2>
      <button class="tk-close" id="tkClose" title="Cerrar">&times;</button>
    </div>
    <div><label for="f-titulo">Título</label><input id="f-titulo" value="${esc(t.titulo)}" placeholder="Qué hay que hacer"></div>
    <div class="tk-row">
      <div><label for="f-tipo">Tipo</label><select id="f-tipo">${opciones(TIPOS, t.tipo)}</select></div>
      <div><label for="f-prio">Prioridad</label><select id="f-prio">${opciones(PRIOS, t.prioridad)}</select></div>
    </div>
    <div class="tk-row">
      <div><label for="f-col">Columna</label><select id="f-col">${opciones(COLS, t.columna, c => c.key, c => c.label)}</select></div>
      <div><label for="f-vence">Vence</label><input id="f-vence" type="date" value="${t.vence_el ?? ''}"></div>
    </div>
    <div><label for="f-asg">Asignada a</label>
      <select id="f-asg"><option value="">Sin asignar</option>${opciones(equipo, t.asignado_a, p => p.id, p => `${p.nombre ?? p.email}${p.rol ? ' — ' + p.rol : ''}`)}</select></div>
    <div><label for="f-listing">Inmueble (source:id)</label><input id="f-listing" value="${esc(t.listing_id ?? '')}" placeholder="pincali:EB-7741"></div>
    ${chk.length ? `<div><label>Checklist · ${chk.filter(c => c.done).length}/${chk.length}</label>
      <div class="tk-check">${chk.map(c => `<label><input type="checkbox" data-i="${c.i}"${c.done ? ' checked' : ''}><span class="${c.done ? 'listo' : ''}">${esc(c.texto)}</span></label>`).join('')}</div></div>` : ''}
    <div><label for="f-desc">Descripción · markdown, <code>- [ ]</code> crea checklist</label>
      <textarea id="f-desc" placeholder="- [ ] Primer paso&#10;- [ ] Segundo paso">${esc(t.descripcion ?? '')}</textarea></div>
    <div class="tk-actions">
      <button class="btn-solid" id="tkSave">${nueva ? 'Crear tarea' : 'Guardar'}</button>
      ${nueva ? '' : '<button class="tk-del" id="tkDel">Borrar</button>'}
    </div>`;

  const val = id => document.getElementById(id).value.trim();
  const cuerpo = () => ({
    titulo: val('f-titulo'), tipo: val('f-tipo'), prioridad: val('f-prio'),
    columna: val('f-col'), asignado_a: val('f-asg') || null,
    listing_id: val('f-listing') || null, descripcion: document.getElementById('f-desc').value,
    vence_el: val('f-vence') || null,
  });

  document.getElementById('tkClose').addEventListener('click', () => { abierta = null; renderPanel(); });
  document.getElementById('tkSave').addEventListener('click', async () => {
    const body = cuerpo();
    if (!body.titulo) return alert('El título es obligatorio.');
    try {
      if (nueva) tareas.unshift(await API.post('/tareas', body));
      else await guardar(abierta, body);
      abierta = null;
      render();
    } catch (err) { alert(err.message); }
  });
  document.getElementById('tkDel')?.addEventListener('click', async () => {
    if (!confirm('¿Borrar esta tarea?')) return;
    await API.del(`/tareas/${abierta}`);
    tareas = tareas.filter(x => x.id !== abierta);
    abierta = null;
    render();
  });
  // Marcar una casilla reescribe la línea del markdown, no un campo aparte.
  side.querySelectorAll('.tk-check input').forEach(cb =>
    cb.addEventListener('change', () => {
      const ta = document.getElementById('f-desc');
      ta.value = marcar(ta.value, +cb.dataset.i, cb.checked);
      if (!nueva) guardar(abierta, { descripcion: ta.value });
    }));
}

function render() {
  const lista = visibles();
  document.getElementById('countNum').textContent = lista.length;
  document.getElementById('countTotal').textContent = tareas.length;

  const vp = document.getElementById('viewPills');
  vp.innerHTML = '';
  [['tablero', 'Tablero'], ['equipo', 'Equipo']].forEach(([k, l]) =>
    vp.appendChild(pill(l, vista === k, () => { vista = k; render(); })));

  const pp = document.getElementById('prioPills');
  pp.innerHTML = '';
  pp.appendChild(pill('Todas', prio === 'all', () => { prio = 'all'; render(); }));
  PRIOS.forEach(p => pp.appendChild(pill(
    `${p}<span class="pill-count">${tareas.filter(t => t.prioridad === p).length}</span>`,
    prio === p, () => { prio = p; render(); })));

  const pg = document.getElementById('personaGroup');
  pg.hidden = vista !== 'tablero';
  if (vista === 'tablero') {
    const cont = document.getElementById('personaPills');
    cont.innerHTML = '';
    cont.appendChild(pill('Todo el equipo', !persona, () => { persona = null; render(); }));
    equipo.forEach(p => cont.appendChild(pill(
      `${esc(p.nombre ?? p.email)}<span class="pill-count">${p.abiertas}</span>`,
      persona === p.id, () => { persona = p.id; render(); })));
  }

  renderStats(lista);
  const main = document.getElementById('vista');
  main.innerHTML = '';
  main.appendChild(vista === 'equipo' ? renderEquipo(lista) : renderTablero(lista));
  renderPanel();
}

// ── Arranque ─────────────────────────────────────────────────────────────────
document.getElementById('searchInput').addEventListener('input', e => { q = e.target.value; render(); });
document.getElementById('nueva-btn').addEventListener('click', () => { abierta = 'nueva'; renderPanel(); });
document.getElementById('scrim').addEventListener('click', () => { abierta = null; renderPanel(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && abierta) { abierta = null; renderPanel(); } });

API.me().then(u => {
  document.getElementById('authBox').hidden = true;
  document.getElementById('userBox').hidden = false;
  document.getElementById('userEmail').textContent = u.email;
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await API.logout();
    location.href = 'login.html';
  });
  return cargar();
}).catch(() => {});

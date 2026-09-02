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
let coments = [];                // comentarios de la tarea abierta
let previo = false;              // el editor de descripción muestra la vista previa
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

// ── Markdown ─────────────────────────────────────────────────────────────────
// Lo justo para que la vista previa sirva: encabezados, negrita, cursiva, código,
// enlaces, listas y el checklist. No es un parser de CommerMark y no pretende serlo.
function mdInline(t) {
  return esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function mdHtml(src) {
  const out = [];
  let lista = null;
  const cerrar = () => { if (lista) { out.push(`</${lista}>`); lista = null; } };
  for (const linea of (src ?? '').split('\n')) {
    const chk = linea.match(RE_CHK);
    const h = linea.match(/^(#{1,3})\s+(.*)$/);
    const li = linea.match(/^\s*[-*]\s+(.*)$/);
    const ol = linea.match(/^\s*\d+\.\s+(.*)$/);
    if (chk) {
      if (lista !== 'ul') { cerrar(); out.push('<ul class="md-chk">'); lista = 'ul'; }
      out.push(`<li>${chk[2].toLowerCase() === 'x' ? '☑' : '☐'} <span class="${chk[2].toLowerCase() === 'x' ? 'listo' : ''}">${mdInline(chk[4])}</span></li>`);
    } else if (h) { cerrar(); out.push(`<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`); }
    else if (li) {
      if (lista !== 'ul') { cerrar(); out.push('<ul>'); lista = 'ul'; }
      out.push(`<li>${mdInline(li[1])}</li>`);
    } else if (ol) {
      if (lista !== 'ol') { cerrar(); out.push('<ol>'); lista = 'ol'; }
      out.push(`<li>${mdInline(ol[1])}</li>`);
    } else if (!linea.trim()) { cerrar(); }
    else { cerrar(); out.push(`<p>${mdInline(linea)}</p>`); }
  }
  cerrar();
  return out.join('') || '<p class="md-vacio">Sin descripción</p>';
}

// Envuelve la selección del textarea, que es lo que hace la barra del canvas.
function envolver(ta, antes, despues = antes) {
  const { selectionStart: a, selectionEnd: b, value: v } = ta;
  ta.value = v.slice(0, a) + antes + (v.slice(a, b) || '') + despues + v.slice(b);
  ta.focus();
  ta.selectionStart = a + antes.length;
  ta.selectionEnd = b + antes.length;
}

function prefijar(ta, marca) {
  const { selectionStart: a, value: v } = ta;
  const ini = v.lastIndexOf('\n', a - 1) + 1;
  ta.value = v.slice(0, ini) + marca + v.slice(ini);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = a + marca.length;
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

async function abrirTarea(id) {
  abierta = id; coments = []; previo = false;
  render();
  coments = await API.get(`/tareas/${id}/comentarios`).catch(() => []);
  renderPanel();
}

// ── Render ───────────────────────────────────────────────────────────────────
function pill(txt, activo, onClick, extra = '') {
  const b = document.createElement('button');
  b.className = `pill-line${activo ? ' active' : ''}${extra}`;
  b.innerHTML = txt;
  b.addEventListener('click', onClick);
  return b;
}

const ICON_CHK = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"/></svg>`;
const ICON_COD = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21V7l9-4 9 4v14"/></svg>`;

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
      <span class="tk-prio p-${t.prioridad}">${t.prioridad}</span>
      <span class="tk-tipo">${esc(t.tipo ?? 'Tarea')}</span>
    </div>
    <div class="tk-titulo">${esc(t.titulo)}</div>
    ${t.listing_id || t.cliente_nombre || t.vence_el ? `<div class="tk-meta">
      ${t.listing_id ? `<span class="tk-cod">${ICON_COD}${esc(t.listing_id)}</span>` : ''}
      ${t.cliente_nombre ? `<span class="tk-cod">${esc(t.cliente_nombre)}</span>` : ''}
      ${t.vence_el ? `<span class="tk-vence${tarde ? ' tarde' : ''}">${t.vence_el}</span>` : ''}
    </div>` : ''}
    <div class="tk-sep"></div>
    <div class="tk-foot">
      <span class="tk-marks">
        ${chk.length ? `<span class="tk-chk${hechas === chk.length ? ' full' : ''}">${ICON_CHK}${hechas}/${chk.length}</span>` : ''}
      </span>
      <span class="tk-ava${p ? '' : ' sin'}" ${p ? `style="background:${tono(p.id)}"` : ''}
            title="${esc(p?.nombre ?? p?.email ?? 'Sin asignar')}">${p ? iniciales(p) : '—'}</span>
    </div>`;
  art.addEventListener('dragstart', e => {
    arrastrando = t.id;
    e.dataTransfer.effectAllowed = 'move';
    art.classList.add('dragging');
  });
  art.addEventListener('dragend', () => { arrastrando = null; render(); });
  art.addEventListener('click', () => abrirTarea(t.id));
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
    div.innerHTML = `<div class="kb-head"><span class="kb-dot" style="background:var(--c-${col.key})"></span>` +
                     `<span>${col.label}</span><span class="kb-n">${items.length}</span></div>`;
    const cont = document.createElement('div');
    cont.className = 'kb-list';
    items.forEach(t => cont.appendChild(tarjeta(t)));
    if (!items.length) cont.innerHTML = '<div class="kb-empty">Suelta tareas aquí</div>';
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
  wrap.appendChild(renderDirectorio());
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

function renderPersona(lista) {
  const p = equipo.find(e => e.id === persona);
  if (!p) return renderTablero(lista);
  const mias = lista.filter(t => t.asignado_a === p.id);
  const wrap = document.createElement('div');
  const cab = document.createElement('div');
  cab.className = 'tk-persona-head';
  const st = (n, l, c) => `<div class="stat"><span class="stat-num" style="color:${c}">${n}</span><span class="stat-label">${l}</span></div>`;
  cab.innerHTML = `
    <div class="tk-persona">
      <span class="tk-ava" style="background:${tono(p.id)}">${iniciales(p)}</span>
      <span class="tk-persona-n"><strong>${esc(p.nombre ?? p.email)}</strong><span>${esc(p.rol ?? p.email)}</span></span>
    </div>
    <div class="tk-persona-stats">
      ${st(mias.filter(t => t.columna !== 'completado').length, 'activas', 'var(--ink)')}
      ${st(mias.filter(t => t.columna === 'encurso').length, 'en curso', 'var(--c-encurso)')}
      ${st(mias.filter(t => t.columna === 'completado').length, 'completadas', 'var(--c-completado)')}
      ${st(mias.length, 'en total', 'var(--muted)')}
    </div>`;
  wrap.appendChild(cab);
  wrap.appendChild(renderTablero(mias));
  return wrap;
}

function renderDirectorio() {
  const dir = document.createElement('div');
  dir.className = 'tk-dir';
  dir.innerHTML = equipo.map(p => {
    const suyas = tareas.filter(t => t.asignado_a === p.id);
    const act = suyas.filter(t => t.columna !== 'completado').length;
    return `<button class="tk-dir-card" data-id="${p.id}">
      <span class="tk-ava" style="background:${tono(p.id)}">${iniciales(p)}</span>
      <span class="tk-persona-n"><strong>${esc(p.nombre ?? p.email)}</strong><span>${esc(p.rol ?? '')}</span></span>
      <span class="tk-dir-n">${act}<small>activas</small></span>
    </button>`;
  }).join('');
  dir.querySelectorAll('.tk-dir-card').forEach(b =>
    b.addEventListener('click', () => { persona = b.dataset.id; vista = 'persona'; render(); }));
  return dir;
}

// El panel derecho fijo del mock. Muestra el equipo mientras no haya una tarea
// abierta; cuando la hay, `renderPanel` lo reemplaza por el detalle.
function renderEquipoAside() {
  const aside = document.getElementById('aside');
  if (abierta) return;                       // el detalle manda sobre el resumen
  aside.innerHTML = `
    <div class="tk-aside-head">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
      Equipo
      <button class="tk-todo" id="verTodo">Ver todo</button>
    </div>
    ${equipo.map(p => `
      <div class="tk-mini" data-persona="${esc(p.id)}">
        <span class="tk-ava" style="background:${tono(p.id)}">${iniciales(p)}</span>
        <span class="tk-mini-n"><strong>${esc(p.nombre ?? p.email)}</strong><small>${esc(p.rol ?? '')}</small></span>
        <span class="tk-mini-k"><b>${p.abiertas ?? 0}</b><span>activas</span></span>
        <span class="tk-mini-k"><b>${p.hechas ?? 0}</b><span>hechas</span></span>
      </div>`).join('') || '<div class="tk-aside-body"><p class="proc-empty">Sin equipo todavía.</p></div>'}`;
  aside.querySelector('#verTodo')?.addEventListener('click', () => { vista = 'equipo'; render(); });
  aside.querySelectorAll('.tk-mini').forEach(el => el.addEventListener('click', () => {
    vista = 'persona'; persona = el.dataset.persona; render();
  }));
  // Soltar una tarjeta sobre una persona la asigna, como en el mock.
  aside.querySelectorAll('.tk-mini').forEach(el =>
    zonaSoltar(el, id => guardar(id, { asignado_a: el.dataset.persona })));
}

function opciones(lista, sel, valor = x => x, texto = x => x) {
  return lista.map(x => `<option value="${esc(valor(x))}"${valor(x) === sel ? ' selected' : ''}>${esc(texto(x))}</option>`).join('');
}

function renderPanel() {
  const side = document.getElementById('aside');
  if (!abierta) return renderEquipoAside();

  const nueva = abierta === 'nueva';
  const t = nueva
    ? { titulo: '', tipo: 'Visita', prioridad: 'media', columna: 'pendiente',
        asignado_a: null, listing_id: '', descripcion: '', vence_el: null }
    : tareas.find(x => x.id === abierta);
  if (!t) { abierta = null; return renderPanel(); }

  const chk = checklist(t.descripcion);
  side.innerHTML = `
    <div class="tk-aside-head">
      ${nueva ? 'Nueva tarea' : 'Detalle'}
      <button class="tk-x" id="tkClose" title="Cerrar">&times;</button>
    </div>
    <div class="tk-aside-body">
    ${nueva ? '' : `<h2>${esc(t.titulo)}</h2>`}
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
    <div>
      <label>Descripción · markdown</label>
      <div class="md-bar">
        ${[['b','Negrita','**'],['i','Cursiva','*'],['`','Código','`']].map(([l,ti,m]) =>
          `<button class="md-b" data-wrap="${m}" title="${ti}">${l}</button>`).join('')}
        ${[['H','Encabezado','## '],['•','Lista','- '],['☐','Checklist','- [ ] '],['1.','Numerada','1. ']].map(([l,ti,m]) =>
          `<button class="md-b" data-pre="${esc(m)}" title="${ti}">${l}</button>`).join('')}
        <button class="md-b" data-link="1" title="Enlace">↗</button>
        <button class="md-b md-prev${previo ? ' on' : ''}" id="mdPrev">${previo ? 'Editar' : 'Vista previa'}</button>
      </div>
      <textarea id="f-desc" ${previo ? 'hidden' : ''} placeholder="- [ ] Primer paso&#10;- [ ] Segundo paso">${esc(t.descripcion ?? '')}</textarea>
      ${previo ? `<div class="md-out">${mdHtml(t.descripcion)}</div>` : ''}
    </div>
    <div><label for="f-adj">Adjuntos · una URL por línea</label>
      <textarea id="f-adj" class="md-adj" placeholder="https://…">${esc((t.adjuntos ?? []).join('\n'))}</textarea>
      ${(t.adjuntos ?? []).length ? `<div class="tk-adj">${t.adjuntos.map(u =>
        `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.split('/').pop() || u)}</a>`).join('')}</div>` : ''}</div>
    <div class="tk-actions">
      <button class="btn-solid" id="tkSave">${nueva ? 'Crear tarea' : 'Guardar'}</button>
      ${nueva ? '' : '<button class="tk-del" id="tkDel">Borrar</button>'}
    </div>
    ${nueva ? '' : `<div class="tk-com">
      <label>Comentarios · ${coments.length}</label>
      ${coments.map(c => `<div class="tk-com-row">
          <span class="tk-ava" style="background:${tono(c.autor_email)}">${iniciales({ nombre: c.autor, email: c.autor_email })}</span>
          <span class="tk-com-b">
            <span class="tk-com-h"><strong>${esc(c.autor ?? c.autor_email)}</strong><small>${(c.created_at ?? '').slice(0, 16).replace('T', ' ')}</small></span>
            <span class="tk-com-t">${esc(c.texto)}</span>
          </span>
        </div>`).join('') || '<p class="md-vacio">Nadie ha comentado.</p>'}
      <div class="tk-com-new">
        <input id="f-com" placeholder="Escribe un comentario">
        <button class="btn-solid" id="tkCom">Enviar</button>
      </div>
    </div>`}
    </div>`;

  const val = id => document.getElementById(id).value.trim();
  const cuerpo = () => ({
    titulo: val('f-titulo'), tipo: val('f-tipo'), prioridad: val('f-prio'),
    columna: val('f-col'), asignado_a: val('f-asg') || null,
    listing_id: val('f-listing') || null, descripcion: document.getElementById('f-desc').value,
    vence_el: val('f-vence') || null,
    adjuntos: document.getElementById('f-adj').value.split('\n').map(x => x.trim()).filter(Boolean),
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
  side.querySelectorAll('.md-b[data-wrap]').forEach(b =>
    b.addEventListener('click', () => envolver(document.getElementById('f-desc'), b.dataset.wrap)));
  side.querySelectorAll('.md-b[data-pre]').forEach(b =>
    b.addEventListener('click', () => prefijar(document.getElementById('f-desc'), b.dataset.pre)));
  side.querySelector('.md-b[data-link]')?.addEventListener('click', () => {
    const url = prompt('URL del enlace:');
    if (url) envolver(document.getElementById('f-desc'), '[', `](${url})`);
  });
  document.getElementById('mdPrev').addEventListener('click', () => {
    // Al alternar se conserva lo escrito: el textarea desaparece del DOM.
    const ta = document.getElementById('f-desc');
    if (ta && !nueva) tareas[tareas.findIndex(x => x.id === abierta)].descripcion = ta.value;
    else if (ta) t.descripcion = ta.value;
    previo = !previo;
    renderPanel();
  });
  document.getElementById('tkCom')?.addEventListener('click', async () => {
    const inp = document.getElementById('f-com');
    if (!inp.value.trim()) return;
    coments.push(await API.post(`/tareas/${abierta}/comentarios`, { texto: inp.value }));
    renderPanel();
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
  [['tablero', 'Tablero'], ['equipo', 'Equipo'], ['persona', 'Persona']].forEach(([k, l]) =>
    vp.appendChild(pill(l, vista === k, () => {
      vista = k;
      // La vista de una persona necesita una persona: si no hay, toma la primera.
      if (k === 'persona' && !persona) persona = equipo[0]?.id ?? null;
      render();
    })));

  const pp = document.getElementById('prioPills');
  pp.innerHTML = '';
  pp.appendChild(pill('Todas', prio === 'all', () => { prio = 'all'; render(); }));
  PRIOS.forEach(p => pp.appendChild(pill(
    `${p}<span class="pill-count">${tareas.filter(t => t.prioridad === p).length}</span>`,
    prio === p, () => { prio = p; render(); })));

  const pg = document.getElementById('personaGroup');
  pg.hidden = vista === 'equipo';
  if (vista !== 'equipo') {
    const cont = document.getElementById('personaPills');
    cont.innerHTML = '';
    if (vista === 'tablero') cont.appendChild(pill('Todo el equipo', !persona, () => { persona = null; render(); }));
    equipo.forEach(p => cont.appendChild(pill(
      `${esc(p.nombre ?? p.email)}<span class="pill-count">${p.abiertas}</span>`,
      persona === p.id, () => { persona = p.id; render(); })));
  }

  const main = document.getElementById('vista');
  main.innerHTML = '';
  main.appendChild(vista === 'equipo' ? renderEquipo(lista)
                 : vista === 'persona' ? renderPersona(lista)
                 : renderTablero(lista));
  renderEquipoAside();
  renderPanel();
}

// ── Arranque ─────────────────────────────────────────────────────────────────
document.getElementById('searchInput').addEventListener('input', e => { q = e.target.value; render(); });
document.getElementById('nueva-btn').addEventListener('click', () => { abierta = 'nueva'; coments = []; previo = false; renderPanel(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && abierta) { abierta = null; renderPanel(); } });

API.me().then(u => {
  document.getElementById('authBox').hidden = true;
  document.getElementById('userBox').hidden = false;
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await API.logout();
    location.href = 'login.html';
  });
  return cargar();
}).catch(() => {});

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

// En el teléfono el kanban medía 7,374 px de alto: ahí se abre en Lista.
const VISTA_BASE = matchMedia('(max-width: 760px)').matches ? 'lista' : 'tablero';   // la vista con que abre, para contar filtros
let tareas = [], equipo = [], vista = VISTA_BASE;
let prio = 'all', persona = null, q = '';
let miId = null, yo = null;      // quién abrió sesión (/me) y su id dentro de `equipo` (null si no está)
let defPersona = null;           // el filtro de persona con que abrió la página (para contar filtros)
let arrancado = false;           // la primera carga abre filtrada a «yo»; las siguientes respetan la elección
let listaVer = 'abiertas';       // la Lista: «Abiertas» o «Completadas»
let abierta = null;              // id de la tarea en el panel, o 'nueva'
let coments = [];                // comentarios de la tarea abierta
let previo = false;              // el editor de descripción muestra la vista previa
let arrastrando = null;
let editado = false;             // el panel tiene cambios sin guardar (ver `panelSucio`)
let borrador = null;             // lo escrito en el panel, para que Vista previa no lo pierda
let comentFallo = false;         // los comentarios de la tarea abierta no se pudieron cargar

// Preferencias de este navegador (localStorage puede fallar: modo privado, datos bloqueados).
const almacen = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento: se olvida al recargar */ } },
};
let complPlegada = almacen.get('tk-compl-plegada') !== '0';   // «Completado» abre plegada en el tablero
let yaArrastro = almacen.get('tk-arrastro') === '1';          // la pista de arrastrar sólo hasta el primer arrastre

// El tono del avatar sale del id, no de una columna: mismo color siempre para la
// misma persona sin tener que guardarlo.
const TONOS = Array.from({ length: 7 }, (_, i) => `var(--tono-${i})`);
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
  // El pipeline también: el panel de una tarea ofrece ligarla a un proceso, y son
  // unos cientos de filas.
  [tareas, equipo] = await Promise.all([API.get('/tareas'), API.get('/equipo'),
    cargarPipeline().catch(err => console.warn('Carga del pipeline falló:', err.message))]);
  yo = equipo.find(e => String(e.id) === String(miId))?.id ?? null;
  if (!arrancado) {
    // Sin tareas abiertas propias, abrir filtrado a «yo» sólo muestra un tablero vacío: se abre con todo el equipo.
    const mias = tareas.filter(t => t.asignado_a === yo && t.columna !== 'completado').length;
    persona = yo != null && mias ? yo : null;
    defPersona = persona;
    arrancado = true;
  }
  render();
}

// Devuelve si el servidor aceptó el cambio: quien guarda desde el panel no debe cerrarlo
// (y tirar lo escrito) cuando el guardado falló.
async function guardar(id, patch) {
  const i = tareas.findIndex(t => t.id === id);
  const previo = tareas[i];
  tareas[i] = { ...previo, ...patch };          // optimista: el tablero no debe parpadear
  render();
  let ok = true;
  try {
    tareas[i] = await API.patch(`/tareas/${id}`, patch);
  } catch (err) {
    tareas[i] = previo;                          // el servidor manda: se revierte
    UI.aviso(`No se guardó el cambio: ${err.message}`);
    ok = false;
  }
  render();
  return ok;
}

function visibles() {
  return tareas.filter(t => {
    if (prio !== 'all' && t.prioridad !== prio) return false;
    if (persona && t.asignado_a !== persona) return false;
    if (q && !norm(`${t.titulo} ${t.tipo ?? ''} ${t.descripcion ?? ''} ${t.listing_id ?? ''} ${t.cliente_nombre ?? ''}`).includes(norm(q))) return false;
    return true;
  });
}

// ── Cambios sin guardar en el panel ──────────────────────────────────────────
// Esc, filtrar, arrastrar o abrir otra tarjeta reconstruían el panel y se llevaban lo
// escrito. Mientras haya algo sin guardar `render()` no lo toca, y cerrarlo o abrir otro
// pregunta antes. Un comentario a medias también cuenta.
const panelSucio = () => abierta
  && (editado || !!document.getElementById('f-com')?.value.trim());

// true si se puede seguir (no había nada o el usuario aceptó perderlo).
async function descartar() {
  if (!panelSucio()) { editado = false; borrador = null; return true; }
  const ok = await UI.confirmar({ titulo: '¿Descartar los cambios?',
    texto: 'Lo que escribiste en el panel todavía no se ha guardado.', verbo: 'Descartar', peligro: true });
  if (ok) {
    editado = false; borrador = null;
    const com = document.getElementById('f-com');
    if (com) com.value = '';        // si no, `panelSucio` seguiría dando true y el panel no se rehace
  }
  return ok;
}

async function cerrarPanel() {
  if (!(await descartar())) return;
  abierta = null;
  renderPanel();
}

async function abrirTarea(id) {
  if (!(await descartar())) return;
  abierta = id; coments = []; previo = false; comentFallo = false;
  render();
  mostrarPanel();
  await cargarComentarios(id);
}

// Los comentarios llegan después del panel: sólo se repinta su bloque, no el panel, para
// no pisar lo que ya se haya escrito. Un fallo no es «nadie ha comentado».
async function cargarComentarios(id) {
  try {
    const c = await API.get(`/tareas/${id}/comentarios`);
    if (abierta !== id) return;                 // se abrió otra mientras tanto
    coments = c; comentFallo = false;
  } catch {
    if (abierta !== id) return;
    coments = []; comentFallo = true;
  }
  refrescarComentarios();
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
  const hecha = t.columna === 'completado';
  const v = t.vence_el ? venceTxt(t.vence_el, hecha) : null;
  const art = document.createElement('article');
  art.className = `tk p-${t.prioridad}${hecha ? ' hecha' : ''}${arrastrando === t.id ? ' dragging' : ''}`;
  art.draggable = true;
  // La prioridad «media» era el 98% de las tarjetas y no distinguía a ninguna: sólo se
  // rotula lo que se sale de lo normal. El avatar sube a la fila de arriba: antes ocupaba
  // un pie entero, con su filete, sólo para una letra.
  art.innerHTML = `
    <div class="tk-top">
      <span class="tk-chips">
        ${t.prioridad !== 'media' ? `<span class="tk-prio p-${esc(t.prioridad)}">${esc(t.prioridad)}</span>` : ''}
        <span class="tk-tipo">${esc(t.tipo ?? 'Tarea')}</span>
      </span>
      <span class="tk-ava${p ? '' : ' sin'}" ${p ? `style="background:${tono(p.id)}"` : ''}
            title="${esc(p?.nombre ?? p?.email ?? 'Sin asignar')}">${p ? iniciales(p) : '—'}</span>
    </div>
    <div class="tk-titulo">${esc(t.titulo)}</div>
    ${t.proceso_titulo || t.listing_id || t.cliente_nombre || v || chk.length ? `<div class="tk-meta">
      ${t.proceso_titulo ? `<span class="tk-cod" title="Propiedad del pipeline">${ICON_COD}${esc(t.proceso_titulo)}</span>` : ''}
      ${t.listing_id ? `<span class="tk-cod">${ICON_COD}${esc(t.listing_id)}</span>` : ''}
      ${t.cliente_nombre ? `<span class="tk-cod">${esc(t.cliente_nombre)}</span>` : ''}
      ${v ? `<span class="tk-vence${v.tarde ? ' tarde' : ''}">${esc(v.txt)}</span>` : ''}
      ${chk.length ? `<span class="tk-chk${hechas === chk.length ? ' full' : ''}">${ICON_CHK}${hechas}/${chk.length}</span>` : ''}
    </div>` : ''}`;
  art.addEventListener('dragstart', e => {
    arrastrando = t.id;
    e.dataTransfer.effectAllowed = 'move';
    art.classList.add('dragging');
    if (!yaArrastro) { yaArrastro = true; almacen.set('tk-arrastro', '1'); }
  });
  art.addEventListener('dragend', () => { arrastrando = null; render(); });
  // Igual que las del pipeline: con teclado también se abre (Tab + Enter o Espacio).
  art.tabIndex = 0;
  art.setAttribute('role', 'button');
  art.addEventListener('click', () => abrirTarea(t.id));
  art.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirTarea(t.id); } });
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

// Cuando el filtro de persona deja la vista sin tareas: de quién son las que se muestran y una salida.
function avisoPersona(base) {
  const p = equipo.find(e => e.id === persona);
  const quien = persona === yo ? 'tus tareas' : `las tareas de ${p?.nombre ?? p?.email ?? 'esta persona'}`;
  const div = document.createElement('div');
  div.className = 'kb-empty tk-vacio-filtro';
  const msg = document.createElement('span');
  msg.textContent = `${base} Estás viendo sólo ${quien}.`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cl-btn';
  btn.textContent = 'Ver todo el equipo';
  btn.addEventListener('click', () => { persona = null; render(); });
  div.append(msg, btn);
  return div;
}

function renderTablero(lista) {
  const kb = document.createElement('div');
  kb.className = 'kb';
  const out = document.createDocumentFragment();
  if (persona && !lista.length) out.appendChild(avisoPersona('Sin tareas con este filtro.'));
  out.appendChild(kb);
  for (const col of COLS) {
    const items = lista.filter(t => t.columna === col.key);
    const div = document.createElement('div');
    // Una columna vacía se pliega (hermes.css): «Pendiente 0» y «En curso 0» ocupaban
    // media pantalla mientras 38 tarjetas se apretaban en las otras dos. Sigue siendo
    // un lugar donde soltar.
    // «Completado» arranca plegada (sólo título y cuenta); se despliega con un clic y se recuerda.
    const plegable = col.key === 'completado', plegada = plegable && complPlegada;
    div.className = `kb-col${plegada ? ' plegada' : items.length ? '' : ' vacia'}`;
    div.innerHTML = `<div class="kb-head${plegable ? ' plegable' : ''}"><span class="kb-dot" style="background:var(--c-${col.key})"></span>` +
                     `<span>${col.label}</span><span class="kb-n">${items.length}</span></div>`;
    if (plegable) {
      const head = div.firstElementChild;
      head.tabIndex = 0;
      head.setAttribute('role', 'button');
      head.setAttribute('aria-expanded', String(!plegada));
      head.title = plegada ? 'Mostrar las completadas' : 'Plegar las completadas';
      const alternar = () => { complPlegada = !complPlegada; almacen.set('tk-compl-plegada', complPlegada ? '1' : '0'); render(); };
      head.addEventListener('click', alternar);
      head.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); alternar(); } });
    }
    if (!plegada) {
      const cont = document.createElement('div');
      cont.className = 'kb-list';
      items.forEach(t => cont.appendChild(tarjeta(t)));
      if (!items.length) cont.innerHTML = '<div class="kb-empty">Suelta tareas aquí</div>';
      div.appendChild(cont);
    }
    // Soltar en la columna mueve la tarea; sin asignado, "asignado" no tiene sentido.
    zonaSoltar(div, id => {
      const t = tareas.find(x => x.id === id);
      if (col.key === 'asignado' && !t.asignado_a) return UI.aviso('Asigna la tarea a alguien primero.');
      if (t.columna === col.key) return;
      const antes = t.columna;
      guardar(id, { columna: col.key }).then(ok => {
        // Completar sin querer es fácil de arrastrar: seis segundos para arrepentirse, como en la Lista.
        if (ok && col.key === 'completado') avisoDeshacer(`«${t.titulo}» completada`, () => {
          if (tareas.find(x => x.id === id)?.columna === 'completado') guardar(id, { columna: antes });
        });
      });
    });
    kb.appendChild(div);
  }
  return out;
}

// ── Lista: la bandeja del teléfono (ui_change.md §5.4) ───────────────────────
// Una fila por tarea, de la que vence antes a la que vence después; sin fecha al final.
const DIA = 864e5;
// `hoyLocal()` (texto.js), no `toISOString()`: éste da la fecha UTC y desde las 18:00 en
// México lo que vence hoy salía como «Vencida».
function venceTxt(fecha, hecha) {
  if (!fecha) return { txt: 'Sin fecha', tarde: false };
  const dias = Math.round((Date.parse(fecha) - Date.parse(hoyLocal())) / DIA);
  if (dias < 0 && !hecha) return { txt: `Vencida · hace ${-dias} ${-dias === 1 ? 'día' : 'días'}`, tarde: true };
  if (dias === 0) return { txt: 'Hoy', tarde: false };
  if (dias === 1) return { txt: 'Mañana', tarde: false };
  return { txt: fechaCorta(fecha), tarde: false };
}

// Aviso con «Deshacer» (mismo patrón que toast() de app.js): 6 s, y no corre con el puntero o el
// foco encima.
let avisoReloj = 0;
function avisoDeshacer(msg, deshacer) {
  const t = document.getElementById('toast');
  t.innerHTML = `<span>${esc(msg)}</span><button type="button" id="toastUndo">Deshacer</button>` +
    '<button type="button" id="toastCerrar" aria-label="Cerrar aviso">&times;</button>';
  t.hidden = false;
  const cerrar = () => { clearTimeout(avisoReloj); t.hidden = true; };
  const programar = () => { clearTimeout(avisoReloj); avisoReloj = setTimeout(cerrar, 6000); };
  programar();
  t.onmouseenter = t.onfocusin = () => clearTimeout(avisoReloj);
  t.onmouseleave = t.onfocusout = programar;
  document.getElementById('toastCerrar').onclick = cerrar;
  document.getElementById('toastUndo').onclick = () => { cerrar(); deshacer(); };
}

// Los grupos de la Lista abierta, por la fecha de vencimiento (en hora local: hoyLocal).
// «Esta semana» llega hasta el domingo; lo posterior es «Más adelante».
const GRUPOS = ['Vencidas', 'Hoy', 'Esta semana', 'Más adelante', 'Sin fecha'];
function grupoVence(fecha) {
  if (!fecha) return 4;
  const f = String(fecha).slice(0, 10), hoy = hoyLocal();
  if (f < hoy) return 0;
  if (f === hoy) return 1;
  const t0 = Date.parse(hoy);
  const domingo = new Date(t0 + (7 - (new Date(t0).getUTCDay() || 7)) * DIA).toISOString().slice(0, 10);
  return f <= domingo ? 2 : 3;
}

function filaLista(t) {
  const p = equipo.find(e => e.id === t.asignado_a);
  const chk = checklist(t.descripcion);
  const hecha = t.columna === 'completado';
  const v = venceTxt(t.vence_el, hecha);
  const liga = t.cliente_nombre || t.proceso_titulo || t.listing_id;
  const fila = document.createElement('div');
  fila.className = `tk-fila p-${t.prioridad}${hecha ? ' hecha' : ''}`;
  fila.innerHTML = `
    <input type="checkbox" class="tk-fila-chk" ${hecha ? 'checked' : ''}
           aria-label="${hecha ? 'Reabrir' : 'Completar'}: ${esc(t.titulo)}">
    <button type="button" class="tk-fila-abrir">
      <span class="tk-fila-tit">${esc(t.titulo)}${chk.length ? ` <span class="tk-chk">${chk.filter(c => c.done).length}/${chk.length}</span>` : ''}</span>
      <span class="tk-fila-meta">
        <span class="tk-vence${v.tarde ? ' tarde' : ''}">${esc(v.txt)}</span>
        <span class="tk-tipo">${esc(t.tipo ?? 'Tarea')}</span>
        ${t.prioridad !== 'media' ? `<span class="tk-prio p-${esc(t.prioridad)}">${esc(t.prioridad)}</span>` : ''}
        ${liga ? `<span class="tk-cod">${esc(liga)}</span>` : ''}
      </span>
    </button>
    <span class="tk-ava${p ? '' : ' sin'}" ${p ? `style="background:${tono(p.id)}"` : ''}
          title="${esc(p?.nombre ?? p?.email ?? 'Sin asignar')}">${p ? iniciales(p) : '—'}</span>`;
  fila.querySelector('.tk-fila-abrir').addEventListener('click', () => abrirTarea(t.id));
  // Reabrir la regresa a donde le toca: asignada si tiene dueño, si no pendiente.
  fila.querySelector('.tk-fila-chk').addEventListener('change', async e => {
    const marcar = e.target.checked, antes = t.columna;
    const ok = await guardar(t.id, { columna: marcar ? 'completado' : (t.asignado_a ? 'asignado' : 'pendiente') });
    if (!ok) { e.target.checked = !marcar; return; }   // guardar() ya avisó y repintó la lista
    // Completar la saca de «Abiertas» sin más: seis segundos para arrepentirse.
    if (marcar) avisoDeshacer(`«${t.titulo}» completada`, () => {
      if (tareas.find(x => x.id === t.id)?.columna === 'completado') guardar(t.id, { columna: antes });
    });
  });
  return fila;
}

function renderLista(lista) {
  const wrap = document.createElement('div');
  wrap.className = 'tk-lista';
  const abiertas = lista.filter(t => t.columna !== 'completado');
  const hechas = lista.filter(t => t.columna === 'completado');
  const seg = document.createElement('div');
  seg.className = 'seg tk-lista-seg';
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Qué tareas');
  seg.innerHTML = `<button type="button" data-ver="abiertas" class="${listaVer === 'abiertas' ? 'on' : ''}">Abiertas ${abiertas.length}</button>` +
                  `<button type="button" data-ver="completadas" class="${listaVer === 'completadas' ? 'on' : ''}">Completadas ${hechas.length}</button>`;
  seg.addEventListener('click', e => {
    const b = e.target.closest('[data-ver]');
    if (b) { listaVer = b.dataset.ver; render(); }
  });
  wrap.appendChild(seg);
  const filas = (listaVer === 'abiertas' ? abiertas : hechas).slice().sort((a, b) =>
    (a.vence_el ?? '9999') < (b.vence_el ?? '9999') ? -1 : (a.vence_el ?? '9999') > (b.vence_el ?? '9999') ? 1
      : PRIOS.indexOf(a.prioridad) - PRIOS.indexOf(b.prioridad));
  if (!filas.length) {
    const vacio = document.createElement('div');
    const base = listaVer === 'abiertas' ? 'No hay tareas abiertas para este filtro.' : 'Nada completado con este filtro.';
    if (persona) wrap.appendChild(avisoPersona(base));
    else {
      vacio.className = 'kb-empty';
      vacio.textContent = base;
      wrap.appendChild(vacio);
    }
  }
  if (listaVer !== 'abiertas') filas.forEach(t => wrap.appendChild(filaLista(t)));
  else GRUPOS.forEach((nombre, g) => {
    const delGrupo = filas.filter(t => grupoVence(t.vence_el) === g);
    if (!delGrupo.length) return;
    const h = document.createElement('h3');
    h.className = 'tk-grupo';
    h.innerHTML = `${nombre} <span class="tk-grupo-n">${delGrupo.length}</span>`;
    wrap.appendChild(h);
    delGrupo.forEach(t => wrap.appendChild(filaLista(t)));
  });
  return wrap;
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
    b.addEventListener('click', () => { persona = b.dataset.id; vista = 'tablero'; render(); }));
  return dir;
}

// El panel derecho fijo del mock. Muestra el equipo mientras no haya una tarea
// abierta; cuando la hay, `renderPanel` lo reemplaza por el detalle.
function renderEquipoAside() {
  const aside = document.getElementById('aside');
  if (abierta) return;                       // el detalle manda sobre el resumen
  // En el pipeline el panel es el filtro por cliente: se queda a la vista.
  if (vista === 'pipeline') { aside.classList.add('open'); return renderPipeAside(); }
  // Diseño 1c: sin tarea abierta, el panel se oculta y el tablero usa todo el
  // ancho. El equipo vive en la vista "Equipo" y en el filtro de persona.
  aside.classList.remove('open');
  aside.innerHTML = '';
}

function opciones(lista, sel, valor = x => x, texto = x => x) {
  return lista.map(x => `<option value="${esc(valor(x))}"${valor(x) === sel ? ' selected' : ''}>${esc(texto(x))}</option>`).join('');
}

// El panel derecho: cinco bloques de marcado y el cableado, cada uno con nombre.
// Antes era una sola función de 128 líneas donde la plantilla y los listeners se
// turnaban, y había que leerla entera para encontrar cualquiera de los dos.

// El anuncio de una tarea se busca por título en el inventario (la misma búsqueda del
// tablero) y se guarda su código: la opción del datalist lleva el código como valor y el
// título como rótulo. Un código pegado (lleva «:») no dispara la búsqueda.
function buscadorAnuncio(input) {
  const lista = document.getElementById('f-listing-op');
  let reloj, pedido = 0;
  input.addEventListener('input', () => {
    clearTimeout(reloj);
    const q = input.value.trim();
    if (q.length < 3 || q.includes(':')) { lista.innerHTML = ''; return; }
    reloj = setTimeout(async () => {
      const yo = ++pedido;
      let r;
      try { r = await API.get(`/listings${API.qs({ q, per_page: 8 })}`); } catch { return; }
      if (yo !== pedido) return;
      lista.innerHTML = (r.items ?? []).map(a =>
        `<option value="${esc(a.id)}" label="${esc([a.title, a.neighborhood || a.location].filter(Boolean).join(' · '))}"></option>`).join('');
    }, 300);
  });
}

function panelCamposHtml(t, nueva) {
  return `
    ${nueva ? '' : `<h2>${esc(t.titulo)}</h2>`}
    <div><label for="f-titulo">Título</label><input id="f-titulo" value="${esc(t.titulo)}" placeholder="Qué hay que hacer"></div>
    <div class="tk-row">
      <div><label for="f-tipo">Tipo</label><select id="f-tipo">${opciones(TIPOS, t.tipo)}</select></div>
      <div><label for="f-prio">Prioridad</label><select id="f-prio">${opciones(PRIOS, t.prioridad)}</select></div>
    </div>
    <div class="tk-row">
      <div><label for="f-col">Estado</label><select id="f-col">${opciones(COLS, t.columna, c => c.key, c => c.label)}</select></div>
      <div><label for="f-vence">Vence</label><input id="f-vence" type="date" lang="es-MX" value="${esc(t.vence_el ?? '')}"></div>
    </div>
    <div><label for="f-asg">Asignada a</label>
      <select id="f-asg"><option value="">Sin asignar</option>${opciones(equipo, t.asignado_a, p => p.id, p => `${esc(p.nombre ?? p.email)}${p.rol ? ' — ' + esc(p.rol) : ''}`)}</select></div>
    <div><label for="f-listing">Anuncio (opcional)</label><input id="f-listing" list="f-listing-op" value="${esc(t.listing_id ?? '')}" placeholder="Busca por título, colonia o pega el código" autocomplete="off"><datalist id="f-listing-op"></datalist></div>
    ${panelProcesoHtml(t)}`;
}

// La liga con el pipeline: a qué proceso (cliente × propiedad) pertenece la tarea.
// Se ofrecen los procesos activos agrupados por cliente, más el que ya tenga aunque
// esté descartado, para no soltarlo sin querer al guardar.
function panelProcesoHtml(t) {
  if (!pipe) return '';
  const porCliente = {};
  pipe.filter(p => etapaActiva(p.status) || p.id === t.proceso_id)
      .forEach(p => (porCliente[p.cliente_nombre] ||= []).push(p));
  return `<div><label for="f-proc">Propiedad del pipeline</label>
    <select id="f-proc"><option value="">Sin ligar</option>${Object.entries(porCliente).map(([c, ps]) =>
      `<optgroup label="${esc(c)}">${ps.map(p =>
        `<option value="${esc(p.id)}"${p.id === t.proceso_id ? ' selected' : ''}>${esc(p.titulo)} · ${esc(etapaLabel(p.status))}</option>`).join('')}</optgroup>`).join('')}</select>
    ${t.proceso_id ? '<button class="pp-abrir" id="tkAbrirProc">Abrir en Clientes →</button>' : ''}</div>`;
}

function panelChecklistHtml(chk) {
  if (!chk.length) return '';
  return `<div><label>Checklist · ${chk.filter(c => c.done).length}/${chk.length}</label>
      <div class="tk-check">${chk.map(c => `<label><input type="checkbox" data-i="${c.i}"${c.done ? ' checked' : ''}><span class="${c.done ? 'listo' : ''}">${esc(c.texto)}</span></label>`).join('')}</div></div>`;
}

function panelDescripcionHtml(t) {
  return `
    <div>
      <label>Descripción</label>
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
    </div>`;
}

function panelAdjuntosHtml(t) {
  const adj = t.adjuntos ?? [];
  return `
    <div><label for="f-adj">Enlaces · uno por línea</label>
      <textarea id="f-adj" class="md-adj" placeholder="https://…">${esc(adj.join('\n'))}</textarea>
      ${adj.length ? `<div class="tk-adj">${adj.map(u =>
        `<a href="${hrefSeguro(u)}" target="_blank" rel="noopener">${esc(u.split('/').pop() || u)}</a>`).join('')}</div>` : ''}</div>`;
}

// created_at llega como instante (UTC): se enseña en la hora de quien lo lee.
const comentFecha = v => {
  const d = new Date(v);
  return isNaN(d) ? '' : d.toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace('.', '');
};

function panelComentariosHtml() {
  return `<div class="tk-com">
      <label>Comentarios${comentFallo ? '' : ` · ${coments.length}`}</label>
      ${coments.map(c => `<div class="tk-com-row">
          <span class="tk-ava" style="background:${tono(c.autor_email)}">${iniciales({ nombre: c.autor, email: c.autor_email })}</span>
          <span class="tk-com-b">
            <span class="tk-com-h"><strong>${esc(c.autor ?? c.autor_email)}</strong><small>${esc(comentFecha(c.created_at))}</small></span>
            <span class="tk-com-t">${esc(c.texto)}</span>
          </span>
        </div>`).join('') || (comentFallo
          ? '<p class="md-vacio">No se pudieron cargar los comentarios. <button type="button" class="pp-abrir" id="tkReintCom">Reintentar</button></p>'
          : '<p class="md-vacio">Nadie ha comentado.</p>')}
      <div class="tk-com-new">
        <input id="f-com" placeholder="Escribe un comentario">
        <button class="btn-solid" id="tkCom">Enviar</button>
      </div>
    </div>`;
}

async function enviarComentario() {
  const inp = document.getElementById('f-com');
  const texto = inp?.value.trim();
  if (!texto || !abierta || abierta === 'nueva') return;
  const id = abierta;
  try {
    const c = await API.post(`/tareas/${id}/comentarios`, { texto });
    if (abierta !== id) return;
    coments.push(c);
    inp.value = '';
    refrescarComentarios();
  } catch (err) {
    UI.aviso(`No se envió el comentario: ${err.message}`);   // lo escrito se queda en el campo
  }
}

// Sólo el bloque de comentarios: reconstruir todo el panel borraba lo editado arriba.
function refrescarComentarios() {
  const viejo = document.querySelector('#aside .tk-com');
  if (!viejo) return;
  const escrito = document.getElementById('f-com')?.value ?? '';
  viejo.outerHTML = panelComentariosHtml();
  document.getElementById('f-com').value = escrito;
  conectarComentarios();
}

function conectarComentarios() {
  document.getElementById('tkCom')?.addEventListener('click', enviarComentario);
  document.getElementById('f-com')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); enviarComentario(); }
  });
  document.getElementById('tkReintCom')?.addEventListener('click', () => { comentFallo = false; cargarComentarios(abierta); });
}

function conectarPanel(t, nueva) {
  const side = document.getElementById('aside');
  const val = id => document.getElementById(id).value.trim();
  // Ligar a un proceso liga también a su cliente. Sin el <select> (el pipeline no
  // cargó) no se manda nada: mandar null soltaría la liga que ya tuviera.
  const liga = () => {
    const sel = document.getElementById('f-proc');
    if (!sel) return {};
    const p = pipe.find(x => x.id === sel.value);
    return p ? { proceso_id: p.id, cliente_id: p.cliente_id } : { proceso_id: null };
  };
  const cuerpo = () => ({
    ...liga(),
    titulo: val('f-titulo'), tipo: val('f-tipo'), prioridad: val('f-prio'),
    columna: val('f-col'), asignado_a: val('f-asg') || null,
    listing_id: val('f-listing') || null, descripcion: document.getElementById('f-desc').value,
    vence_el: val('f-vence') || null,
    adjuntos: document.getElementById('f-adj').value.split('\n').map(x => x.trim()).filter(Boolean),
  });

  buscadorAnuncio(document.getElementById('f-listing'));
  document.getElementById('tkClose').addEventListener('click', cerrarPanel);
  document.getElementById('tkAbrirProc')?.addEventListener('click', async () => {
    if (!(await descartar())) return;
    location.href = urlProc(t.proceso_id);
  });
  document.getElementById('tkSave').addEventListener('click', async () => {
    const body = cuerpo();
    if (!body.titulo) return UI.aviso('El título es obligatorio.');
    try {
      if (nueva) tareas.unshift(await API.post('/tareas', body));
      else if (!(await guardar(abierta, body))) return;   // falló: el panel se queda con lo escrito
    } catch (err) { return UI.aviso(`No se guardó la tarea: ${err.message}`); }
    editado = false; borrador = null;
    abierta = null;
    render();
  });
  document.getElementById('tkDel')?.addEventListener('click', async () => {
    const t = tareas.find(x => x.id === abierta), nc = coments.length;
    if (!(await UI.confirmar({ titulo: `¿Borrar «${t?.titulo ?? 'esta tarea'}»?`,
      texto: (nc ? `Se borran también sus ${nc} ${nc === 1 ? 'comentario' : 'comentarios'}. ` : '') + 'No se puede deshacer.',
      verbo: 'Borrar', peligro: true }))) return;
    try {
      await API.del(`/tareas/${abierta}`);
    } catch (err) { return UI.aviso(`No se borró la tarea: ${err.message}`); }
    tareas = tareas.filter(x => x.id !== abierta);
    editado = false; borrador = null;
    abierta = null;
    render();
  });
  // La barra de formato cambia el textarea por programa: no dispara `input`.
  side.querySelectorAll('.md-b[data-wrap]').forEach(b =>
    b.addEventListener('click', () => { editado = true; envolver(document.getElementById('f-desc'), b.dataset.wrap); }));
  side.querySelectorAll('.md-b[data-pre]').forEach(b =>
    b.addEventListener('click', () => { editado = true; prefijar(document.getElementById('f-desc'), b.dataset.pre); }));
  side.querySelector('.md-b[data-link]')?.addEventListener('click', async () => {
    const ta = document.getElementById('f-desc');
    const { selectionStart: a, selectionEnd: z } = ta;       // el diálogo le quita el foco
    const url = await UI.pedir({ titulo: 'Insertar enlace', etiqueta: 'Dirección web', verbo: 'Insertar',
                                 placeholder: 'https://…', tipo: 'url' });
    if (!url) return;
    ta.setSelectionRange(a, z);
    editado = true;
    envolver(ta, '[', `](${url})`);
  });
  document.getElementById('mdPrev').addEventListener('click', () => {
    // Al alternar el panel se rehace: lo escrito en todos los campos pasa al borrador, no
    // sólo la descripción (antes un título a medias se perdía al ver la vista previa).
    borrador = cuerpo();
    previo = !previo;
    renderPanel();
  });
  conectarComentarios();

  // Marcar una casilla reescribe la línea del markdown, no un campo aparte.
  side.querySelectorAll('.tk-check input').forEach(cb =>
    cb.addEventListener('change', () => {
      const ta = document.getElementById('f-desc');
      ta.value = marcar(ta.value, +cb.dataset.i, cb.checked);
      cb.nextElementSibling?.classList.toggle('listo', cb.checked);
      if (!nueva) guardar(abierta, { descripcion: ta.value });
    }));
}

function renderPanel() {
  const side = document.getElementById('aside');
  if (!abierta) return renderEquipoAside();
  side.classList.add('open');

  const nueva = abierta === 'nueva';
  const base = nueva
    ? { titulo: '', tipo: 'Visita', prioridad: 'media', columna: 'pendiente',
        asignado_a: null, listing_id: '', descripcion: '', vence_el: null }
    : tareas.find(x => x.id === abierta);
  if (!base) { abierta = null; return renderPanel(); }
  // Se pinta lo que el usuario llevaba escrito (si pidió la vista previa), en una copia:
  // la tarea de la lista no cambia hasta que se guarda.
  const t = { ...base, ...(borrador ?? {}) };
  borrador = null;

  side.innerHTML = `
    <div class="tk-aside-head">
      ${nueva ? 'Nueva tarea' : 'Detalle'}
      <button class="tk-x" id="tkClose" title="Cerrar">&times;</button>
    </div>
    <div class="tk-aside-body">
      ${panelCamposHtml(t, nueva)}
      ${panelChecklistHtml(checklist(t.descripcion))}
      ${panelDescripcionHtml(t)}
      ${panelAdjuntosHtml(t)}
      <div class="tk-actions">
        <button class="btn-solid" id="tkSave">${nueva ? 'Crear tarea' : 'Guardar'}</button>
        ${nueva ? '' : '<button class="tk-del" id="tkDel">Borrar</button>'}
      </div>
      ${nueva ? '' : panelComentariosHtml()}
    </div>`;

  conectarPanel(t, nueva);
}

// ── Pipeline comercial ───────────────────────────────────────────────────────
// Los procesos del CRM (cliente × propiedad) en columnas por etapa: el Google Sheet
// "PIPELINES PROREALTOR" del equipo, ahora con memoria. Una propiedad ofrecida a
// cuatro clientes es una sola ficha, así que corregir sus m² aquí los corrige en las
// cuatro tarjetas. Son cientos de filas, no el inventario: se cargan completas una
// vez, al abrir la vista, y se vuelven a pedir después de cada guardado.
let pipe = null, clientesLista = [], cargandoPipe = false;
let pipeCliente = '', pipeTrae = '', laterales = false;
let pipeError = null;            // por qué falló la última carga del pipeline (null = no ha fallado)

const mxn = n => '$' + Math.round(Number(n)).toLocaleString('es-MX');
const mxnCorto = n => n >= 1e6 ? '$' + (n / 1e6).toLocaleString('es-MX', { maximumFractionDigits: 1 }) + ' M'
                    : n >= 1e3 ? '$' + Math.round(n / 1e3).toLocaleString('es-MX') + ' k' : mxn(n);
const cifra = n => Number(n).toLocaleString('es-MX', { maximumFractionDigits: 2 });
const hay = v => v !== null && v !== undefined && v !== '';
// "Presentó" (quién lo trae) es texto mientras la persona no tenga cuenta; si ya la tiene, manda
// su nombre de usuario. Un valor como "A/B" son dos personas.
const traeNombre = p => p.trae_nombre || p.trae || '';
const traePersonas = p => traeNombre(p).split('/').map(x => x.trim()).filter(Boolean);

// El proceso se edita en Clientes: allí abre al cliente dueño y resalta la fila.
const urlProc = id => `clientes.html?proc=${encodeURIComponent(id)}`;

async function cargarPipeline() {
  [pipe, clientesLista] = await Promise.all([API.get('/pipeline'), API.get('/clientes')]);
  clientesLista.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

function pipeVisibles() {
  return (pipe ?? []).filter(p => {
    if (!laterales && !etapaActiva(p.status)) return false;
    if (pipeCliente && p.cliente_id !== pipeCliente) return false;
    if (pipeTrae && !traePersonas(p).includes(pipeTrae)) return false;
    if (q && !norm(`${p.titulo} ${p.cliente_nombre} ${p.municipio ?? ''} ${p.notas ?? ''} ` +
                   `${p.ficha_notas ?? ''} ${traeNombre(p)} ${p.marca ?? ''}`).includes(norm(q))) return false;
    return true;
  });
}

function tarjetaProc(p, clientesDeLaFicha) {
  const quien = traeNombre(p);
  const abiertas = tareas.filter(x => x.proceso_id === p.id && x.columna !== 'completado').length;
  const marcas = [abiertas ? `${abiertas} ${abiertas === 1 ? 'tarea' : 'tareas'}` : '',
                  clientesDeLaFicha > 1 ? `+${clientesDeLaFicha - 1} ${clientesDeLaFicha > 2 ? 'clientes' : 'cliente'}` : '']
                 .filter(Boolean).join(' · ');
  const cifras = [hay(p.tamano_m2) ? `${cifra(p.tamano_m2)} m²` : '',
                  hay(p.precio_m2) ? `$${cifra(p.precio_m2)}/m²` : ''].filter(Boolean).join(' · ');
  const art = document.createElement('article');
  art.className = `tk pp e-${p.status}${arrastrando === p.id ? ' dragging' : ''}`;
  art.draggable = true;
  art.tabIndex = 0;
  art.setAttribute('role', 'link');
  art.title = 'Abrir en Clientes';
  art.innerHTML = `
    <div class="tk-top">
      <span class="pp-cliente">${esc(p.cliente_nombre)}</span>
      <span class="tk-tipo">${esc([p.tipo, p.junta ? `${p.junta} junta` : '', p.marca].filter(Boolean).join(' · '))}</span>
    </div>
    <div class="tk-titulo">${esc(p.titulo)}</div>
    ${p.municipio ? `<div class="pp-mun">${esc(p.municipio)}</div>` : ''}
    ${cifras || hay(p.precio) ? `<div class="pp-cifras"><span class="pp-m2">${esc(cifras)}</span>
      ${hay(p.precio) ? `<span class="pp-monto">${mxn(p.precio)}</span>` : '<span class="pp-monto pend">Monto por definir</span>'}</div>` : ''}
    ${p.notas ? `<div class="pp-seg">${esc(p.notas)}</div>` : ''}
    <div class="tk-sep"></div>
    <div class="tk-foot">
      <span class="pp-trae"><span class="tk-ava${quien ? '' : ' sin'}" ${quien ? `style="background:${tono(p.trae_id ?? quien)}"` : ''}>${quien ? esc(iniciales({ nombre: quien.replace('/', ' ') })) : '—'}</span>${esc(quien || 'Sin asignar')}</span>
      ${marcas ? `<span class="pp-comp" title="Tareas abiertas ligadas · otros clientes con la misma propiedad">${marcas}</span>` : ''}
    </div>`;
  art.addEventListener('dragstart', e => {
    arrastrando = p.id;
    e.dataTransfer.effectAllowed = 'move';
    art.classList.add('dragging');
  });
  art.addEventListener('dragend', () => { arrastrando = null; render(); });
  art.addEventListener('click', () => { location.href = urlProc(p.id); });
  art.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); location.href = urlProc(p.id); } });
  return art;
}

function renderPipeline(lista) {
  if (!pipe) {
    const div = document.createElement('div');
    div.className = 'kb-empty';
    if (cargandoPipe || !pipeError) div.textContent = 'Cargando el pipeline…';
    else UI.errorCarga(div, `No se pudo cargar el pipeline. ${pipeError}`, () => { pipeError = null; render(); });
    return div;
  }
  const porFicha = {};
  pipe.forEach(p => { porFicha[p.ficha_id] = (porFicha[p.ficha_id] ?? 0) + 1; });
  const kb = document.createElement('div');
  kb.className = 'kb kb-pipe';
  for (const e of ETAPAS.filter(e => laterales || !e.lateral)) {
    const items = lista.filter(p => p.status === e.key);
    const suma = items.reduce((a, p) => a + (Number(p.precio) || 0), 0);
    const col = document.createElement('div');
    col.className = `kb-col e-${e.key}`;
    col.innerHTML = `<div class="kb-head"><span class="kb-dot"></span><span>${e.label}</span>` +
      `<span class="kb-n">${items.length}</span>` +
      (suma ? `<span class="kb-sum" title="Suma del monto de salida">${mxnCorto(suma)}</span>` : '') +
      `</div><div class="kb-ayuda">${esc(e.ayuda)}</div>`;
    const cont = document.createElement('div');
    cont.className = 'kb-list';
    items.forEach(p => cont.appendChild(tarjetaProc(p, porFicha[p.ficha_id])));
    if (!items.length) cont.innerHTML = '<div class="kb-empty">Nada en esta etapa</div>';
    col.appendChild(cont);
    zonaSoltar(col, id => {
      const p = pipe.find(x => x.id === id);
      if (p && p.status !== e.key) moverProc(p, e.key);
    });
    kb.appendChild(col);
  }
  return kb;
}

function renderPipeFiltros() {
  const cuenta = {};
  (pipe ?? []).filter(p => etapaActiva(p.status)).forEach(p => { cuenta[p.cliente_id] = (cuenta[p.cliente_id] ?? 0) + 1; });
  const personas = [...new Set((pipe ?? []).flatMap(traePersonas))].sort((a, b) => a.localeCompare(b, 'es'));
  if (pipeTrae && !personas.includes(pipeTrae)) pipeTrae = '';
  document.getElementById('f-cliente').innerHTML = '<option value="">Todos los clientes</option>' +
    clientesLista.filter(c => cuenta[c.id] || c.id === pipeCliente || (pipe ?? []).some(p => p.cliente_id === c.id))
      .map(c => `<option value="${esc(c.id)}"${c.id === pipeCliente ? ' selected' : ''}>${esc(c.nombre)} (${cuenta[c.id] ?? 0})</option>`).join('');
  document.getElementById('f-trae').innerHTML = '<option value="">Presentó: todos</option>' +
    personas.map(n => `<option value="${esc(n)}"${n === pipeTrae ? ' selected' : ''}>${esc(n)}</option>`).join('');
  document.getElementById('f-laterales').checked = laterales;
}

// Con el pipeline a la vista y nada abierto, el panel derecho resume a los clientes
// en vez de al equipo: es lo que se filtra desde aquí.
function renderPipeAside() {
  const aside = document.getElementById('aside');
  const filas = clientesLista.map(c => {
    const suyos = (pipe ?? []).filter(p => p.cliente_id === c.id);
    return { c, activos: suyos.filter(p => etapaActiva(p.status)).length, total: suyos.length };
  }).filter(f => f.total).sort((a, b) => b.activos - a.activos);
  aside.innerHTML = `
    <div class="tk-aside-head">Clientes
      ${pipeCliente ? '<button class="tk-todo" id="verTodos">Ver todos</button>' : ''}
    </div>
    ${filas.map(({ c, activos, total }) => `
      <div class="tk-mini" data-cliente="${esc(c.id)}" tabindex="0" role="button">
        <span class="tk-ava" style="background:${tono(c.id)}">${esc(iniciales({ nombre: c.nombre }))}</span>
        <span class="tk-mini-n"><strong>${esc(c.nombre)}</strong><small>Responsable: ${esc(c.responsable_nombre || c.responsable || '—')}</small></span>
        <span class="tk-mini-k"><b>${activos}</b><span>activas</span></span>
        <span class="tk-mini-k"><b>${total}</b><span>total</span></span>
      </div>`).join('') || '<div class="tk-aside-body"><p class="proc-empty">Todavía no hay procesos.</p></div>'}`;
  aside.querySelector('#verTodos')?.addEventListener('click', () => { pipeCliente = ''; render(); });
  aside.querySelectorAll('.tk-mini').forEach(el => {
    const elegir = () => { pipeCliente = el.dataset.cliente; render(); };
    el.addEventListener('click', elegir);
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); elegir(); }   // Espacio no debe desplazar la página
    });
  });
}

// En el teléfono el panel queda debajo del tablero: sin esto, tocar una tarjeta no
// daba ninguna señal (el detalle abría ~700 px bajo el pliegue).
function mostrarPanel() {
  if (!matchMedia('(max-width: 760px)').matches) return;
  const aside = document.getElementById('aside');
  const head = aside.querySelector('.tk-aside-head');
  if (head) { head.tabIndex = -1; head.focus({ preventScroll: true }); }
  // Su borde superior queda justo bajo la barra fija (scrollIntoView lo dejaba debajo de ella).
  const barra = document.querySelector('.topbar')?.offsetHeight ?? 0;
  window.scrollTo(0, Math.max(0, aside.getBoundingClientRect().top + window.scrollY - barra));
}

// Arrastrar una tarjeta a otra etapa sólo cambia el estado del proceso. Optimista (no debe
// parpadear); después vuelve a pedir el pipeline, que es la fuente de verdad.
async function moverProc(p, status) {
  const i = pipe.findIndex(x => x.id === p.id);
  if (i >= 0) { pipe[i] = { ...pipe[i], status }; render(); }
  try {
    await API.patch(`/procesos/${p.id}`, { status });
  } catch (err) {
    UI.aviso(`No se guardó el proceso: ${err.message}`);
  }
  await cargarPipeline().catch(() => UI.aviso('No se pudo refrescar el pipeline. Recarga la página si algo se ve desactualizado.'));
  render();
}

function render() {
  const esPipe = vista === 'pipeline';
  // Sin `pipeError`, un fallo volvía a pedirse en cuanto `render()` lo notaba: un bucle
  // de peticiones fallidas. Ahora se detiene y el usuario decide con «Reintentar».
  if (esPipe && !pipe && !cargandoPipe && !pipeError) {
    cargandoPipe = true;
    cargarPipeline().catch(err => { pipeError = err.message; })
                    .finally(() => { cargandoPipe = false; render(); });
  }
  const lista = esPipe ? pipeVisibles() : visibles();
  document.getElementById('countNum').textContent = lista.length;
  document.getElementById('countTotal').textContent = esPipe ? (pipe?.length ?? 0) : tareas.length;
  document.getElementById('countQue').textContent = esPipe ? 'procesos' : 'tareas';
  document.getElementById('nueva-btn').hidden = esPipe;     // los procesos se crean y editan en Clientes
  document.getElementById('prioGroup').hidden = esPipe;
  document.getElementById('pipeGroup').hidden = !esPipe;
  document.querySelector('.tk-bar-hint').hidden = vista !== 'tablero' || yaArrastro;
  // «Filtros (n)»: n = lo que está distinto del predeterminado.
  const nFiltros = (vista !== VISTA_BASE ? 1 : 0) + (esPipe
    ? (pipeCliente ? 1 : 0) + (pipeTrae ? 1 : 0) + (laterales ? 1 : 0)
    : (prio !== 'all' ? 1 : 0) + (persona !== defPersona && vista !== 'equipo' ? 1 : 0));
  const bf = document.getElementById('tkFiltrosBtn');
  bf.textContent = nFiltros ? `Filtros (${nFiltros})` : 'Filtros';
  bf.classList.toggle('on', nFiltros > 0);
  // Un solo buscador con dos cajas: la de la topbar (escritorio) y la de la barra (≤900 px).
  const ph = esPipe ? 'Buscar procesos…' : 'Buscar tareas…';
  for (const id of ['searchInput', 'searchInputMovil']) {
    const el = document.getElementById(id);
    el.placeholder = ph;
    if (el.value !== q) el.value = q;
  }
  if (esPipe) renderPipeFiltros();

  const vp = document.getElementById('viewPills');
  vp.innerHTML = '';
  // «Persona» ya no es una vista: era el tablero con el filtro de persona puesto.
  [['lista', 'Lista'], ['tablero', 'Tablero'], ['pipeline', 'Pipeline'], ['equipo', 'Equipo']].forEach(([k, l]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = l;
    b.className = vista === k ? 'on' : '';
    b.setAttribute('aria-pressed', String(vista === k));
    b.addEventListener('click', async () => {
      // El panel es de la vista: una tarea abierta no sigue abierta en el pipeline.
      if (k === 'pipeline' && abierta && !(await descartar())) return;
      vista = k;
      if (k === 'pipeline') abierta = null;
      render();
    });
    vp.appendChild(b);
  });

  const pp = document.getElementById('prioPills');
  pp.innerHTML = '';
  pp.appendChild(pill('Todas', prio === 'all', () => { prio = 'all'; render(); }));
  PRIOS.forEach(p => pp.appendChild(pill(
    `${p}<span class="pill-count">${tareas.filter(t => t.prioridad === p).length}</span>`,
    prio === p, () => { prio = p; render(); })));

  const pg = document.getElementById('personaGroup');
  pg.hidden = vista === 'equipo' || esPipe;
  if (!pg.hidden) {
    const cont = document.getElementById('personaPills');
    cont.innerHTML = '';
    cont.appendChild(pill('Todo el equipo', !persona, () => { persona = null; render(); }));
    equipo.forEach(p => cont.appendChild(pill(
      `${esc(p.nombre ?? p.email)}<span class="pill-count">${p.abiertas}</span>`,
      persona === p.id, () => { persona = p.id; render(); })));
    // En ≤900 px las píldoras de todo el equipo no caben en una fila: el mismo filtro, en select.
    document.getElementById('personaSel').innerHTML = '<option value="">Todo el equipo</option>' +
      equipo.map(p => `<option value="${esc(p.id)}"${persona === p.id ? ' selected' : ''}>${esc(p.nombre ?? p.email)} (${p.abiertas})</option>`).join('');
  }

  const main = document.getElementById('vista');
  main.innerHTML = '';
  main.appendChild(esPipe ? renderPipeline(lista)
                 : vista === 'equipo' ? renderEquipo(lista)
                 : vista === 'lista' ? renderLista(lista)
                 : renderTablero(lista));
  // Con algo escrito en el panel no se reconstruye: filtrar, arrastrar o guardar otra
  // tarjeta se llevaban lo escrito.
  if (!panelSucio()) { renderEquipoAside(); renderPanel(); }
}
document.getElementById('nueva-btn').addEventListener('click', async () => {
  if (!(await descartar())) return;
  abierta = 'nueva'; coments = []; previo = false; comentFallo = false; renderPanel(); mostrarPanel();
});
// Lo escrito en el panel (menos un comentario, que tiene su propio chequeo, y las casillas
// del checklist, que guardan solas) lo marca como sin guardar.
document.getElementById('aside').addEventListener('input', e => {
  if (e.target.id === 'f-com' || e.target.closest('.tk-check') || !e.target.closest('.tk-aside-body')) return;
  editado = true;
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !abierta || e.defaultPrevented) return;
  // Esc dentro de un campo es de ese campo (o del menú o diálogo abierto), no del panel.
  if (e.target.closest?.('input, textarea, select') || document.querySelector('dialog[open]')) return;
  cerrarPanel();
});
// El buscador de la topbar existía sin listener: `q` se leía y nunca cambiaba.
for (const id of ['searchInput', 'searchInputMovil'])
  document.getElementById(id).addEventListener('input', e => { q = e.target.value.trim(); render(); });
// «Filtros (n)» abre y cierra Prioridad, Persona y los filtros del pipeline (también en escritorio,
// donde es un panel flotante: se cierra con un clic fuera o con Esc).
const filtrosBtn = document.getElementById('tkFiltrosBtn'), filtrosPanel = document.getElementById('tkFiltros');
function filtrosAbrir(abrir) {
  filtrosPanel.classList.toggle('abierto', abrir);
  filtrosBtn.setAttribute('aria-expanded', String(abrir));
}
filtrosBtn.addEventListener('click', () => filtrosAbrir(!filtrosPanel.classList.contains('abierto')));
document.addEventListener('click', e => {
  // composedPath y no closest(): una píldora se repinta al hacer clic y su nodo ya no está en el documento.
  if (filtrosPanel.classList.contains('abierto') && !e.composedPath().some(n => n === filtrosPanel || n === filtrosBtn)) filtrosAbrir(false);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && filtrosPanel.classList.contains('abierto') && !document.querySelector('dialog[open]')) {
    filtrosAbrir(false);
    filtrosBtn.focus();
  }
});
document.getElementById('personaSel').addEventListener('change', e => { persona = e.target.value || null; render(); });
document.getElementById('f-cliente').addEventListener('change', e => { pipeCliente = e.target.value; render(); });
document.getElementById('f-trae').addEventListener('change', e => { pipeTrae = e.target.value; render(); });
document.getElementById('f-laterales').addEventListener('change', e => { laterales = e.target.checked; render(); });
// tareas.html#pipeline abre directo en el pipeline.
if (location.hash === '#pipeline') vista = 'pipeline';

// «Cargando…» y, si falla, el error con «Reintentar»: antes un fallo dejaba el tablero
// vacío y mudo (`.catch(() => {})`), igual que si no hubiera tareas.
async function iniciar() {
  const vistaEl = document.getElementById('vista');
  vistaEl.innerHTML = '<div class="kb-empty">Cargando tareas…</div>';
  try {
    miId = (await API.me()).id;
    document.getElementById('authBox').hidden = true;
    document.getElementById('userBox').hidden = false;
    await cargar();
  } catch (err) {
    if (err.message === 'Sesión expirada') return;    // api.js ya mandó al login
    UI.errorCarga(vistaEl, `No se pudieron cargar las tareas. ${err.message}`, iniciar);
  }
}
iniciar();

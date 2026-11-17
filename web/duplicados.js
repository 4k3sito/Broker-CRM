// Posibles duplicados: los pares que el agrupador encontró parecidos sin atreverse a
// fusionarlos (scrapers/v2/duplicados.py). El asesor ve los dos anuncios lado a lado y
// decide; la decisión es del equipo. Lo que ya se fusionó solo no pasa por aquí: se ve
// en el tablero como una tarjeta y se corrige desde la ficha.
//
// La misma cola revisa los precios atípicos (`?vista=outliers`): rentas que no cuadran,
// ocultas del tablero hasta que alguien diga que son reales (api/outliers.py).
//
// La página es una cola, no un listado con páginas: cada par decidido sale de la lista, el
// siguiente sube a su lugar, se rellena con el lote que sigue y durante unos segundos se
// puede deshacer. La cola de pares son miles, así que se decide con el teclado: S = «Son
// el mismo» (o «Es real»), N = «No son» (o «Dato erróneo»), Z = deshacer y X = saltar
// (manda el par al final de la cola local sin decidir). Los filtros viven en la URL:
// recargar o compartir la liga vuelve a la misma cola.

const TIPOS = [['', 'Todos'], ['oficina', 'Oficinas'], ['local', 'Locales'], ['bodega', 'Bodegas'], ['terreno', 'Terrenos']];
const SENALES = [['', 'Cualquier señal'], ['foto', 'Misma foto'], ['ubicacion', 'Misma ubicación']];
const MOTIVOS = [['', 'Cualquier motivo'], ['precio_imposible', 'Precio imposible'], ['titulo_venta', 'El título dice venta'], ['venta_imposible', 'Venta imposible']];
const MOTIVO_TXT = { precio_imposible: 'Precio imposible para una renta', titulo_venta: 'El título dice venta y el portal, renta', venta_imposible: 'Precio imposible para una venta' };
// Las dos vistas son pestañas de una misma sección, «Revisión»: la página se llama así
// y `titulo` sólo completa el título de la pestaña del navegador.
const VISTAS = {
  pares: { pestana: 'Duplicados', titulo: 'Duplicados', kpi: 'pares por revisar',
           atajos: [['S', 'son el mismo'], ['N', 'no son el mismo'], ['X', 'saltar'], ['Z', 'deshacer']],
           nota: 'Anuncios que se parecen pero no lo bastante para fusionarlos solos. Lo que decidas vale para todo el equipo: «Son el mismo» los deja en una sola tarjeta del tablero; «No son el mismo» quita el par de esta lista y no se vuelve a sugerir.' },
  outliers: { pestana: 'Precios atípicos', titulo: 'Precios atípicos', kpi: 'anuncios por revisar',
              atajos: [['S', 'es real'], ['N', 'dato erróneo'], ['X', 'saltar'], ['Z', 'deshacer']],
              nota: 'Rentas de más de $10 millones al mes y ventas de más de $1,000 millones que no cuadran. Están ocultas del tablero hasta que alguien las valide, y lo que decidas vale para todo el equipo: «Es real» las regresa al tablero; «Dato erróneo» las deja ocultas. Si el portal cambia el precio, vuelven a esta lista.' },
};
const AVISOS = { igual: 'Fusionados en una tarjeta', distinto: 'Marcados como distintos',
                 real: 'Regresa al tablero', erroneo: 'Se queda oculto' };
// Cuántos pares se muestran por lote (en el teléfono 10: D6), y lo más que la API da en una
// página (/outliers acepta 60 y /duplicados/sugerencias 50: se pide con el menor).
const LOTE = matchMedia('(max-width: 760px)').matches ? 10 : 20;
const TOPE = 50;
const ESTADOS = [['Nuevo León', 'Nuevo León'], ['', 'Todo el país']];
// Se abre en Nuevo León, que es donde trabaja el equipo.
const ESTADO_INICIAL = 'Nuevo León';
// Los filtros salen de la URL (`?vista=outliers&tipo=local`): lo que no esté, o no
// sea una opción válida, queda en su valor de fábrica.
function filtrosDeURL() {
  const q = new URLSearchParams(location.search);
  const valido = (lista, v, defecto) => lista.some(([x]) => x === v) ? v : defecto;
  return { vista: q.get('vista') === 'outliers' ? 'outliers' : 'pares',
           estado: q.has('estado') ? valido(ESTADOS, q.get('estado'), ESTADO_INICIAL) : ESTADO_INICIAL,
           tipo: valido(TIPOS, q.get('tipo'), ''), senal: valido(SENALES, q.get('senal'), ''),
           motivo: valido(MOTIVOS, q.get('motivo'), '') };
}
const F = filtrosDeURL();
// Sin `pushState`: cada filtro no es una página del historial, pero sí tiene que
// sobrevivir a una recarga. Sólo se escribe lo que difiere de lo de fábrica.
function guardarURL() {
  const q = new URLSearchParams();
  if (F.vista === 'outliers') q.set('vista', 'outliers');
  if (F.estado !== ESTADO_INICIAL) q.set('estado', F.estado);   // `estado=` es «todo el país»
  if (F.tipo) q.set('tipo', F.tipo);
  if (F.vista === 'pares' && F.senal) q.set('senal', F.senal);
  if (F.vista === 'outliers' && F.motivo) q.set('motivo', F.motivo);
  const t = q.toString();
  history.replaceState(null, '', t ? `?${t}` : location.pathname);
}
// Cuánto tiempo se puede deshacer una decisión antes de que se mande.
const ESPERA = 6000;
// Tras decidir, los botones del par siguiente quedan bajo el cursor: lo que llegue antes
// de esto es el segundo clic de un doble clic o una tecla sostenida, no una decisión.
const PAUSA = 500;
// Con menos pares que éstos a la vista, se piden más.
const RESERVA = 6;
const lista = document.getElementById('dpLista');
const aviso = document.getElementById('dpAviso');
let total = 0;
let vuelta = 0;        // cada carga la sube: la respuesta de una carga anterior se ignora
let rellenando = false;
let ultimaDecision = -PAUSA;

function pintarFiltros() {
  const pildoras = (lista, campo) => lista.map(([v, t]) =>
    `<button class="pill-line${F[campo] === v ? ' active' : ''}" data-campo="${esc(campo)}" data-valor="${esc(v)}" aria-pressed="${F[campo] === v}">${esc(t)}</button>`).join('');
  const ultimo = F.vista === 'outliers' ? pildoras(MOTIVOS, 'motivo') : pildoras(SENALES, 'senal');
  document.getElementById('dpFiltros').innerHTML = [pildoras(ESTADOS, 'estado'), pildoras(TIPOS, 'tipo'), ultimo].join('<span class="dp-sep"></span>');
  // En el teléfono la nota y las píldoras se esconden tras «Filtros (n)» (n = lo que se
  // apartó de lo de fábrica); en pantallas anchas el botón no se ve (hermes.css).
  const nFiltros = [F.estado !== ESTADO_INICIAL, !!F.tipo, !!(F.vista === 'outliers' ? F.motivo : F.senal)].filter(Boolean).length;
  const bf = document.getElementById('dpFiltrosBtn');
  bf.textContent = nFiltros ? `Filtros (${nFiltros})` : 'Filtros';
  bf.classList.toggle('on', nFiltros > 0);
  const v = VISTAS[F.vista];
  // Pestañas: tablist/tab con aria-selected; sólo la activa entra por Tab, las flechas
  // mueven entre ellas. El número es lo que queda por revisar en esa vista (si se sabe).
  document.getElementById('dpVistas').innerHTML = Object.entries(VISTAS).map(([k, x]) =>
    `<button class="dp-tab${F.vista === k ? ' active' : ''}" role="tab" id="dpTab-${esc(k)}" aria-selected="${F.vista === k}" aria-controls="dpLista" tabindex="${F.vista === k ? 0 : -1}" data-campo="vista" data-valor="${esc(k)}">${esc(x.pestana)}<span class="dp-tab-n" data-conteo="${esc(k)}"></span></button>`).join('');
  lista.setAttribute('aria-labelledby', `dpTab-${F.vista}`);
  pintarConteos();
  document.title = `${v.titulo} · Revisión · OfficeLab`;
  document.getElementById('dpTitulo').textContent = v.titulo;
  document.getElementById('dpKpi').textContent = v.kpi;
  document.getElementById('dpNota').textContent = v.nota;
  // Atajos a la vista, no escondidos: en el teléfono no hay teclado y el CSS los oculta.
  document.getElementById('dpAtajos').innerHTML = 'Atajos: ' +
    v.atajos.map(([k, t]) => `<kbd>${k}</kbd> ${t}`).join(' &#183; ');
}

// Cuántos hay por revisar en cada pestaña. La activa lo sabe por su propia lista; la otra
// se pregunta una vez por carga con la misma API (una página de un renglón, sólo para su
// `total`). Mientras no se sepa, la pestaña no enseña número.
const conteos = { pares: null, outliers: null };
function pintarConteos() {
  for (const el of document.querySelectorAll('#dpVistas [data-conteo]')) {
    const n = conteos[el.dataset.conteo];
    el.textContent = n == null ? '' : ` (${mx(n)})`;
  }
}
function fijarConteo() {
  conteos[F.vista] = total;
  pintarConteos();
}
async function contarOtra() {
  const otra = F.vista === 'pares' ? 'outliers' : 'pares';
  const turno = vuelta;
  try {
    const r = await pedirPagina(otra, 1, 1);
    if (turno === vuelta) { conteos[otra] = r.total; pintarConteos(); }
  } catch (err) { console.error(err); }
}

// «Cargar más»: sólo si el servidor tiene más de lo que ya se ve.
function pintarMas() {
  const restan = total - lista.querySelectorAll('.dp-par:not(.saliendo)').length;
  const el = document.getElementById('dpMas');
  el.innerHTML = restan > 0 ? `<button class="pill-line" id="dpMasBtn" type="button">Cargar más <span class="pill-count">${mx(restan)}</span></button>` : '';
}

// Quien pide menos movimiento al sistema: la regla de hermes.css no alcanza a animate().
const ms = n => matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : n;
const llave = (a, b) => `${a}|${b}`;

function ponerTotal(n) {
  const baja = n < total;
  total = n;
  fijarConteo();
  pintarMas();
  const el = document.getElementById('dpTotal');
  el.textContent = mx(total);
  el.animate([{ opacity: .35, transform: `translateY(${baja ? 7 : -7}px)` }, { opacity: 1, transform: 'none' }],
    { duration: ms(200), easing: 'cubic-bezier(.2,0,0,1)' });
}

// Lo que separa a los dos anuncios, sólo si se puede comparar: el precio (en %) y la
// superficie. `marcas` dice qué resaltar en el par; `texto` lo dice con palabras, para que
// no dependa sólo de un color.
function diferencias(a, b) {
  const texto = [], marcas = [];
  if (a.precio && b.precio && a.precio !== b.precio) {
    marcas.push('precio');
    if (a.currency === b.currency && a.transaction_type === b.transaction_type) {
      // Dos precios distintos nunca son «100%», aunque el redondeo diga eso.
      const pct = Math.min(99, Math.max(1, Math.round(Math.abs(a.precio - b.precio) / Math.max(a.precio, b.precio) * 100)));
      texto.push(`Precio: ${pct}% de diferencia`);
    } else texto.push('Precio: moneda u operación distinta');
  }
  const ma = Math.round(a.property_size_m2 || 0), mb = Math.round(b.property_size_m2 || 0);
  if (ma && mb && ma !== mb) {
    marcas.push('m2');
    texto.push(`Superficie: ${m2Txt(ma)} y ${m2Txt(mb)}`);
  }
  return { texto: texto.join(' · '), marcas: marcas.join(' ') };
}

// Cada botón dice su tecla. Los dos pesan igual: con uno en sólido se leía como «lo
// normal» y se decidía sin mirar (en la cola de precios atípicos premiaba el dato
// imposible). `tabindex="-1"` deja que el foco caiga en el par, no en un botón.
// «Saltar» no decide: manda el par al final de la cola de esta sesión (pesa menos que los otros dos).
const botonesHtml = (si, no) => `<button class="fx-btn" data-decide="${si[0]}">${si[1]} <kbd>S</kbd></button>
      <button class="fx-btn" data-decide="${no[0]}">${no[1]} <kbd>N</kbd></button>
      <button class="fx-btn dp-saltar" data-saltar type="button" title="Dejarlo para el final de la cola sin decidir">Saltar <kbd>X</kbd></button>`;

const parHtml = s => {
  const dif = diferencias(s.a, s.b);
  return `<article class="dp-par" tabindex="-1" data-a="${esc(s.a.id)}" data-b="${esc(s.b.id)}" data-dif="${dif.marcas}">
    <div class="dp-par-head">
      <span class="dp-senal">${esc(Propiedad.senal(s.senal))}</span>
      <span class="dp-dif">${esc(dif.texto)}</span>
    </div>
    <div class="dp-lados">${Propiedad.fila(s.a)}${Propiedad.fila(s.b)}</div>
    <div class="dp-par-acc">
      ${botonesHtml(['igual', 'Son el mismo'], ['distinto', 'No son el mismo'])}
    </div>
  </article>`;
};

// Un outlier es un renglón y no un par: `b` vacío, para que la cola no distinga.
const outlierHtml = s => `<article class="dp-par dp-uno" tabindex="-1" data-a="${esc(s.a.id)}" data-b="">
    <div class="dp-par-head"><span class="dp-senal">${esc(MOTIVO_TXT[s.a.motivo] ?? s.a.motivo)}</span></div>
    <div class="dp-lados">${Propiedad.fila(s.a)}</div>
    <div class="dp-par-acc">
      ${botonesHtml(['real', 'Es real'], ['erroneo', 'Dato erróneo'])}
    </div>
  </article>`;
const itemHtml = s => F.vista === 'outliers' ? outlierHtml(s) : parHtml(s);

async function pedirPagina(vista, page, per_page) {
  const comun = { estado: F.estado, tipo: F.tipo, page, per_page };
  if (vista === 'pares') return API.get(`/duplicados/sugerencias${API.qs({ ...comun, senal: F.senal })}`);
  const r = await API.get(`/outliers${API.qs({ ...comun, motivo: F.motivo })}`);
  return { ...r, items: r.items.map(a => ({ a, b: { id: '' } })) };
}
// La cola siempre se pide desde el principio: lo decidido ya no está, así que lo que sigue
// ocupa su lugar. `adelante` son los que ya se ven (o esperan su envío) y que el servidor
// todavía devuelve primero; se piden además de un lote para que lo nuevo llegue detrás.
async function pedir(adelante = 0) {
  const querer = adelante + LOTE;
  const por = Math.min(TOPE, querer);
  let items = [], total = 0;
  for (let page = 1; page <= Math.ceil(querer / por); page++) {
    const r = await pedirPagina(F.vista, page, por);
    total = r.total;
    items = items.concat(r.items);
    if (r.items.length < por) break;
  }
  return { total, items };
}

// Lo que el servidor todavía no sabe: la decisión en espera y las que van en camino.
const decididos = new Set();
const nuevos = items => items.filter(s => !decididos.has(llave(s.a.id, s.b.id)));

function vacio() {
  const que = F.vista === 'outliers' ? 'anuncios' : 'pares';
  lista.innerHTML = `<p class="pg-empty">${decididos.size ? `Todo revisado. No quedan ${que} con estos filtros.` : `No hay ${que} por revisar con estos filtros.`}</p>`;
}

async function cargar() {
  const turno = ++vuelta;
  guardarURL();
  lista.classList.add('cargando');
  // Cambiar de filtro o de vista con el aviso de deshacer abierto confirma la decisión:
  // se cierra el aviso (ya no se puede deshacer) y se dice que se guardó.
  const habia = !!pendiente;
  if (await confirmar() && habia) UI.aviso('Se guardó la decisión anterior.');
  let r;
  try {
    r = await pedir();
  } catch (err) {
    if (turno !== vuelta) return;
    lista.classList.remove('cargando');
    // Un error no es «no hay pares»: se dice qué pasó y se deja reintentar.
    UI.errorCarga(lista, `No se pudo cargar la lista. ${err.message}`, () => {
      lista.innerHTML = '<p class="pg-empty">Cargando&#8230;</p>';
      cargar();
    });
    return;
  }
  if (turno !== vuelta) return;
  lista.classList.remove('cargando');
  total = r.total;
  document.getElementById('dpTotal').textContent = mx(total);
  fijarConteo();
  contarOtra();
  const pares = nuevos(r.items).slice(0, LOTE);
  if (!pares.length) { pintarMas(); return vacio(); }
  lista.innerHTML = pares.map(itemHtml).join('');
  pintarMas();
  lista.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms(160) });
}

// Los pares decididos ya salieron de la consulta, así que el siguiente lote es lo que viene
// detrás de lo que ya se ve: la lista nunca se acaba mientras queden pares y nada se mueve
// bajo el cursor. Con `forzar` (el botón «Cargar más») se pide aunque haya reserva.
async function rellenar(forzar = false) {
  if (rellenando || (!forzar && lista.querySelectorAll('.dp-par:not(.saliendo)').length >= RESERVA)) return;
  rellenando = true;
  const turno = vuelta;
  try {
    await guardando;
    // Lo que se ve, más la decisión en espera (que el servidor aún devuelve).
    const r = await pedir(lista.querySelectorAll('.dp-par:not(.saliendo)').length + (pendiente ? 1 : 0));
    if (turno !== vuelta) return;
    total = Math.max(0, r.total - (pendiente ? 1 : 0));
    document.getElementById('dpTotal').textContent = mx(total);
    fijarConteo();
    const hay = new Set([...lista.querySelectorAll('.dp-par')].map(p => llave(p.dataset.a, p.dataset.b)));
    const pares = nuevos(r.items).filter(s => !hay.has(llave(s.a.id, s.b.id))).slice(0, LOTE);
    if (pares.length) {
      lista.querySelector('.pg-empty')?.remove();
      lista.insertAdjacentHTML('beforeend', pares.map(itemHtml).join(''));
      [...lista.children].slice(-pares.length).forEach(par => par.animate(
        [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
        { duration: ms(240), easing: 'cubic-bezier(.2,0,0,1)' }));
    } else if (!lista.querySelector('.dp-par:not(.saliendo)')) {
      vacio();
    }
    pintarMas();
  } catch (err) {
    console.error(err);
  } finally {
    rellenando = false;
  }
}

// Salir: «Son el mismo» junta los dos anuncios y «No son el mismo» los aparta; luego el
// hueco se cierra y lo que sigue sube. `salida` se queda en el par para deshacerlo al revés.
function retirar(par, tipo) {
  const { height, marginBottom, paddingTop, paddingBottom } = getComputedStyle(par);
  const lleno = { height, marginBottom, paddingTop, paddingBottom, borderTopWidth: '1px', borderBottomWidth: '1px' };
  const nada = { height: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0, borderTopWidth: 0, borderBottomWidth: 0 };
  const opciones = { duration: ms(340), easing: 'cubic-bezier(.4,0,.2,1)', fill: 'both' };
  par.inert = true;
  par.classList.add('saliendo');
  const paso = tipo === 'igual' || tipo === 'real' ? 28 : -28;
  const lados = [...par.querySelectorAll('.dp-fila')].map((fila, i) => fila.animate(
    [{ transform: 'none' }, { transform: `translateX(${i ? -paso : paso}px)`, offset: .45 }, { transform: `translateX(${i ? -paso : paso}px)` }], opciones));
  const hueco = par.animate([{ ...lleno, opacity: 1 }, { ...lleno, opacity: 0, offset: .45 }, { ...nada, opacity: 0 }], opciones);
  hueco.onfinish = () => par.remove();
  par.salida = [hueco, ...lados];
}

// El par vuelve al lugar que dejó, o arriba si ese lugar ya no existe.
function devolver({ par, antes }) {
  lista.querySelector('.pg-empty')?.remove();
  if (!par.isConnected) lista.insertBefore(par, antes?.isConnected ? antes : lista.firstElementChild);
  const [hueco] = par.salida;
  hueco.onfinish = () => {
    par.salida.forEach(a => a.cancel());
    par.classList.remove('saliendo');
  };
  par.inert = false;
  par.salida.forEach(a => a.reverse());
  par.scrollIntoView({ block: 'nearest' });
  par.focus({ preventScroll: true });
  pintarMas();
}

// La decisión no se manda al tocar el botón sino cuando ya no se puede deshacer: fusionar
// junta los dos grupos enteros y no tiene inversa exacta en la API. Hay una sola en espera;
// la siguiente, cambiar de filtro o cerrar la página la vuelven definitiva.
let pendiente = null;
let guardando = Promise.resolve();
let cuenta = null;

function mostrarAviso(texto) {
  document.getElementById('dpAvisoTxt').textContent = texto;
  if (aviso.hidden) {
    aviso.hidden = false;
    aviso.animate([{ opacity: 0, transform: 'translate(-50%, 12px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }],
      { duration: ms(200), easing: 'cubic-bezier(.2,0,0,1)' });
  }
  cuenta?.cancel();
  cuenta = document.getElementById('dpCuenta').animate(
    [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: ESPERA });
  cuenta.onfinish = () => { confirmar(); };
}

function ocultarAviso() {
  cuenta?.cancel();
  aviso.hidden = true;
}

const enviar = ({ tipo, a, b }, opciones) => tipo === 'igual' ? Propiedad.fusionar([a, b], opciones)
  : tipo === 'distinto' ? Propiedad.descartar(a, b, opciones)
  : API.post('/outliers/decidir', { id: a, decision: tipo }, opciones);

function confirmar() {
  const p = pendiente;
  if (!p) return guardando;
  pendiente = null;
  ocultarAviso();
  guardando = enviar(p).then(() => true, err => {
    decididos.delete(llave(p.a, p.b));
    ponerTotal(total + 1);
    devolver(p);
    // «igual» y «distinto» deciden un par; en Precios atípicos se decide un anuncio.
    const que = p.tipo === 'igual' || p.tipo === 'distinto' ? 'El par' : 'El anuncio';
    UI.aviso(`No se pudo guardar: ${err.message}. ${que} volvió a la lista.`);
    return false;
  });
  return guardando;
}

function deshacer() {
  const p = pendiente;
  if (!p) return;
  pendiente = null;
  ocultarAviso();
  decididos.delete(llave(p.a, p.b));
  ponerTotal(total + 1);
  devolver(p);
}

function cambiarFiltro(e) {
  const b = e.target.closest('[data-campo]');
  if (!b) return;
  const { campo, valor } = b.dataset;
  const zona = b.closest('#dpFiltros, #dpVistas');
  if (campo === 'vista' && F.vista === valor) return;
  F[campo] = valor;
  pintarFiltros();
  // pintarFiltros reconstruye los botones: el foco vuelve al que se pulsó (mismo campo y valor).
  zona.querySelector(`[data-campo="${CSS.escape(campo)}"][data-valor="${CSS.escape(valor)}"]`)?.focus();
  cargar();
}

document.getElementById('dpFiltros').addEventListener('click', cambiarFiltro);
document.getElementById('dpVistas').addEventListener('click', cambiarFiltro);

document.getElementById('dpMas').addEventListener('click', e => {
  if (e.target.closest('#dpMasBtn')) rellenar(true);
});

// Teléfono: la nota y los filtros se pliegan tras un botón (el CSS lo esconde en pantallas anchas).
document.getElementById('dpFiltrosBtn').addEventListener('click', e => {
  const abierto = document.getElementById('dpPlegable').classList.toggle('abierto');
  e.currentTarget.setAttribute('aria-expanded', abierto);
});

// Flechas entre pestañas (patrón tablist): Izquierda/Derecha, Inicio y Fin.
document.getElementById('dpVistas').addEventListener('keydown', e => {
  const tabs = [...e.currentTarget.querySelectorAll('[role="tab"]')];
  const i = tabs.indexOf(document.activeElement);
  const j = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length
    : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
  if (i < 0 || j < 0) return;
  e.preventDefault();
  tabs[j].click();
});

// El par que se decide: el que tiene el foco y, si el foco anda fuera de la lista, el
// primero que se ve en pantalla. Nunca uno que quedó fuera de la vista.
function parActivo() {
  const pares = [...lista.querySelectorAll('.dp-par:not(.saliendo)')];
  const enfocado = document.activeElement?.closest?.('.dp-par:not(.saliendo)');
  if (enfocado && lista.contains(enfocado)) return enfocado;
  return pares.find(p => { const r = p.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
}

// El siguiente par que se puede decidir: el de abajo y, si no hay, el de arriba.
function vecino(par) {
  const libre = p => p && !p.classList.contains('saliendo');
  for (let p = par.nextElementSibling; p; p = p.nextElementSibling) if (libre(p) && p.matches('.dp-par')) return p;
  for (let p = par.previousElementSibling; p; p = p.previousElementSibling) if (libre(p) && p.matches('.dp-par')) return p;
  return null;
}

// El par se va en cuanto se decide y lo que sigue sube a su lugar: se revisa con el cursor
// quieto, sin scroll. El foco pasa al CONTENEDOR del par siguiente, no a uno de sus
// botones: así un Enter o un espacio de más no decide un par que no se ha leído.
function decidir(par, tipo) {
  if (performance.now() - ultimaDecision < PAUSA) return;
  ultimaDecision = performance.now();
  confirmar();
  const { a, b: otro } = par.dataset;
  const antes = par.nextElementSibling;
  const siguiente = vecino(par);
  pendiente = { tipo, a, b: otro, par, antes };
  decididos.add(llave(a, otro));
  retirar(par, tipo);
  siguiente?.focus({ preventScroll: true });
  ponerTotal(Math.max(0, total - 1));
  mostrarAviso(AVISOS[tipo]);
  rellenar();
}

// Saltar no decide ni se manda: el par pasa al final de la cola de esta sesión (si se
// recarga, vuelve a su lugar) y el siguiente sube. Comparte la PAUSA de `decidir` para que
// un doble clic no salte dos.
function saltar(par) {
  if (!par || performance.now() - ultimaDecision < PAUSA) return;
  if (lista.querySelectorAll('.dp-par:not(.saliendo)').length < 2) {
    UI.aviso('No hay otro a dónde saltar: es el último de la cola.');
    return;
  }
  ultimaDecision = performance.now();
  const siguiente = vecino(par);
  lista.append(par);
  par.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
    { duration: ms(240), easing: 'cubic-bezier(.2,0,0,1)' });
  siguiente?.focus({ preventScroll: true });
}

lista.addEventListener('click', e => {
  const b = e.target.closest('[data-decide]');
  if (b) return decidir(b.closest('.dp-par'), b.dataset.decide);
  const s = e.target.closest('[data-saltar]');
  if (s) saltar(s.closest('.dp-par'));
});

// S y N deciden, X salta, Z deshace. No se disparan con un modificador (Ctrl+Z es del navegador),
// escribiendo en un campo, con un diálogo abierto, ni con la tecla sostenida; la PAUSA
// de `decidir` cubre además el segundo toque seguido.
addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (e.target.closest?.('input, select, textarea, [contenteditable]') || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  if (k === 'z') {
    if (pendiente) { e.preventDefault(); deshacer(); }
    return;
  }
  if (k === 'x') {
    const par = parActivo();
    if (par) { e.preventDefault(); saltar(par); }
    return;
  }
  const i = k === 's' ? 0 : k === 'n' ? 1 : -1;
  const par = i < 0 ? null : parActivo();
  const boton = par?.querySelectorAll('[data-decide]')[i];
  if (!boton) return;
  e.preventDefault();
  decidir(par, boton.dataset.decide);
});

document.getElementById('dpDeshacer').addEventListener('click', deshacer);
// Quien va a tocar «Deshacer» no debe perderlo mientras llega.
for (const ev of ['mouseenter', 'focusin']) aviso.addEventListener(ev, () => cuenta?.pause());
for (const ev of ['mouseleave', 'focusout']) aviso.addEventListener(ev, () => cuenta?.play());

// Abrir una ficha o cerrar la pestaña no pierde la decisión en espera.
addEventListener('pagehide', () => {
  if (pendiente) enviar(pendiente, { keepalive: true }).catch(() => {});
  pendiente = null;
});

API.me().then(() => {
  document.getElementById('authBox').hidden = true;
  document.getElementById('userBox').hidden = false;
  pintarFiltros();
  cargar();
}).catch(err => {
  console.error(err);
  // Sin esto la página se quedaba en «Cargando…» para siempre.
  UI.errorCarga(lista, `No se pudo abrir la sesión. ${err.message}`, () => location.reload());
});

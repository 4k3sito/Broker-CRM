// Posibles duplicados: los pares que el agrupador encontró parecidos sin atreverse a
// fusionarlos (scrapers/v2/duplicados.py). El asesor ve los dos anuncios lado a lado y
// decide; la decisión es del equipo. Lo que ya se fusionó solo no pasa por aquí: se ve
// en el tablero como una tarjeta y se corrige desde la ficha.
//
// La página es una cola: cada par decidido sale de la lista, el siguiente sube a su
// lugar y durante unos segundos se puede deshacer.

const TIPOS = [['', 'Todos'], ['oficina', 'Oficinas'], ['local', 'Locales'], ['bodega', 'Bodegas'], ['terreno', 'Terrenos']];
const SENALES = [['', 'Cualquier señal'], ['foto', 'Misma foto'], ['ubicacion', 'Misma ubicación']];
const POR_PAGINA = 20;
const ESTADOS = [['Nuevo León', 'Nuevo León'], ['', 'Todo el país']];
// Se abre en Nuevo León, que es donde trabaja el equipo.
const F = { estado: 'Nuevo León', tipo: '', senal: '', page: 1 };
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
    `<button class="pill-line${F[campo] === v ? ' active' : ''}" data-campo="${campo}" data-valor="${v}" aria-pressed="${F[campo] === v}">${t}</button>`).join('');
  document.getElementById('dpFiltros').innerHTML = [pildoras(ESTADOS, 'estado'), pildoras(TIPOS, 'tipo'), pildoras(SENALES, 'senal')].join('<span class="dp-sep"></span>');
}

function pintarPaginas() {
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  document.getElementById('dpPaginas').innerHTML = paginas < 2 ? '' :
    `<button class="pill-line" data-pag="${F.page - 1}"${F.page <= 1 ? ' disabled' : ''}>&#8592; Anterior</button>
     <span class="dp-pag">Página ${F.page} de ${mx(paginas)}</span>
     <button class="pill-line" data-pag="${F.page + 1}"${F.page >= paginas ? ' disabled' : ''}>Siguiente &#8594;</button>`;
}

// Quien pide menos movimiento al sistema: la regla de hermes.css no alcanza a animate().
const ms = n => matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : n;
const llave = (a, b) => `${a}|${b}`;

function ponerTotal(n) {
  const baja = n < total;
  total = n;
  const el = document.getElementById('dpTotal');
  el.textContent = mx(total);
  el.animate([{ opacity: .35, transform: `translateY(${baja ? 7 : -7}px)` }, { opacity: 1, transform: 'none' }],
    { duration: ms(200), easing: 'cubic-bezier(.2,0,0,1)' });
}

// Cuánto se separan los dos precios, sólo si se pueden comparar.
function diferencia(a, b) {
  if (!a.precio || !b.precio || a.currency !== b.currency || a.transaction_type !== b.transaction_type) return '';
  if (a.precio === b.precio) return '';
  // Dos precios distintos nunca son «100%», aunque el redondeo diga eso.
  const pct = Math.min(99, Math.max(1, Math.round(Math.abs(a.precio - b.precio) / Math.max(a.precio, b.precio) * 100)));
  return `Precio: ${pct}% de diferencia`;
}

const parHtml = s => `<article class="dp-par" data-a="${esc(s.a.id)}" data-b="${esc(s.b.id)}">
    <div class="dp-par-head">
      <span class="dp-senal">${esc(Propiedad.senal(s.senal))}</span>
      <span class="dp-dif">${esc(diferencia(s.a, s.b))}</span>
    </div>
    <div class="dp-lados">${Propiedad.fila(s.a)}${Propiedad.fila(s.b)}</div>
    <div class="dp-par-acc">
      <button class="fx-btn solid" data-decide="igual">Son el mismo</button>
      <button class="fx-btn" data-decide="distinto">No son el mismo</button>
    </div>
  </article>`;

const pedir = () => API.get(`/duplicados/sugerencias${API.qs({ estado: F.estado, tipo: F.tipo, senal: F.senal, page: F.page, per_page: POR_PAGINA })}`);

// Lo que el servidor todavía no sabe: la decisión en espera y las que van en camino.
const decididos = new Set();
const nuevos = items => items.filter(s => !decididos.has(llave(s.a.id, s.b.id)));

function vacio() {
  lista.innerHTML = `<p class="pg-empty">${decididos.size ? 'Todo revisado. No quedan pares con estos filtros.' : 'No hay pares por revisar con estos filtros.'}</p>`;
}

async function cargar() {
  const turno = ++vuelta;
  lista.classList.add('cargando');
  await confirmar();
  let r;
  try {
    r = await pedir();
  } catch (err) {
    if (turno !== vuelta) return;
    lista.classList.remove('cargando');
    lista.innerHTML = `<p class="pg-empty">No se pudieron cargar las sugerencias.<br>${esc(err.message)}</p>`;
    return;
  }
  if (turno !== vuelta) return;
  lista.classList.remove('cargando');
  total = r.total;
  document.getElementById('dpTotal').textContent = mx(total);
  pintarPaginas();
  const pares = nuevos(r.items);
  if (!pares.length) return vacio();
  lista.innerHTML = pares.map(parHtml).join('');
  lista.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms(160) });
}

// Los pares decididos ya salieron de la consulta, así que la misma página trae los que
// seguían: la lista nunca se acaba mientras queden pares y nada se mueve bajo el cursor.
async function rellenar() {
  if (rellenando || lista.querySelectorAll('.dp-par:not(.saliendo)').length >= RESERVA) return;
  rellenando = true;
  const turno = vuelta;
  try {
    await guardando;
    const r = await pedir();
    if (turno !== vuelta) return;
    total = Math.max(0, r.total - (pendiente ? 1 : 0));
    document.getElementById('dpTotal').textContent = mx(total);
    pintarPaginas();
    const hay = new Set([...lista.querySelectorAll('.dp-par')].map(p => llave(p.dataset.a, p.dataset.b)));
    const pares = nuevos(r.items).filter(s => !hay.has(llave(s.a.id, s.b.id)));
    if (pares.length) {
      lista.querySelector('.pg-empty')?.remove();
      lista.insertAdjacentHTML('beforeend', pares.map(parHtml).join(''));
      [...lista.children].slice(-pares.length).forEach(par => par.animate(
        [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
        { duration: ms(240), easing: 'cubic-bezier(.2,0,0,1)' }));
    } else if (!lista.querySelector('.dp-par:not(.saliendo)')) {
      // Se terminó la página y detrás de ella no venía nada: queda la anterior.
      if (F.page > 1) { F.page = Math.max(1, Math.ceil(total / POR_PAGINA)); return cargar(); }
      vacio();
    }
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
  const paso = tipo === 'igual' ? 28 : -28;
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
  par.querySelector('[data-decide]').focus({ preventScroll: true });
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

const enviar = ({ tipo, a, b }, opciones) => tipo === 'igual'
  ? Propiedad.fusionar([a, b], opciones) : Propiedad.descartar(a, b, opciones);

function confirmar() {
  const p = pendiente;
  if (!p) return guardando;
  pendiente = null;
  ocultarAviso();
  guardando = enviar(p).catch(err => {
    decididos.delete(llave(p.a, p.b));
    ponerTotal(total + 1);
    devolver(p);
    UI.aviso(`No se pudo guardar: ${err.message}. El par volvió a la lista.`);
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

document.getElementById('dpFiltros').addEventListener('click', e => {
  const b = e.target.closest('[data-campo]');
  if (!b) return;
  F[b.dataset.campo] = b.dataset.valor;
  F.page = 1;
  pintarFiltros();
  cargar();
});

document.getElementById('dpPaginas').addEventListener('click', e => {
  const b = e.target.closest('[data-pag]');
  if (!b || b.disabled) return;
  F.page = Number(b.dataset.pag);
  cargar().then(() => window.scrollTo({ top: 0 }));
});

// El par se va en cuanto se decide y lo que sigue sube a su lugar: se revisa con el cursor
// quieto, sin scroll. El foco pasa al par siguiente para seguir con el teclado.
lista.addEventListener('click', e => {
  const b = e.target.closest('[data-decide]');
  if (!b || performance.now() - ultimaDecision < PAUSA) return;
  ultimaDecision = performance.now();
  confirmar();
  const par = b.closest('.dp-par'), { a, b: otro } = par.dataset, tipo = b.dataset.decide;
  const antes = par.nextElementSibling;
  pendiente = { tipo, a, b: otro, par, antes };
  decididos.add(llave(a, otro));
  retirar(par, tipo);
  (antes ?? par.previousElementSibling)?.querySelector('[data-decide]')?.focus({ preventScroll: true });
  ponerTotal(Math.max(0, total - 1));
  mostrarAviso(tipo === 'igual' ? 'Fusionados en una tarjeta' : 'Marcados como distintos');
  rellenar();
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

document.getElementById('logout-btn').addEventListener('click', async () => {
  await API.logout().catch(() => {});
  location.replace('login.html');
});

API.me().then(() => {
  document.getElementById('authBox').hidden = true;
  document.getElementById('userBox').hidden = false;
  pintarFiltros();
  cargar();
}).catch(err => console.error(err));

// Posibles duplicados: los pares que el agrupador encontró parecidos sin atreverse a
// fusionarlos (scrapers/v2/duplicados.py). El asesor ve los dos anuncios lado a lado y
// decide; la decisión es del equipo. Lo que ya se fusionó solo no pasa por aquí: se ve
// en el tablero como una tarjeta y se corrige desde la ficha.

const TIPOS = [['', 'Todos'], ['oficina', 'Oficinas'], ['local', 'Locales'], ['bodega', 'Bodegas'], ['terreno', 'Terrenos']];
const SENALES = [['', 'Cualquier señal'], ['foto', 'Misma foto'], ['ubicacion', 'Misma ubicación']];
const POR_PAGINA = 20;
const ESTADOS = [['Nuevo León', 'Nuevo León'], ['', 'Todo el país']];
// Se abre en Nuevo León, que es donde trabaja el equipo.
const F = { estado: 'Nuevo León', tipo: '', senal: '', page: 1 };
let total = 0;

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

async function cargar() {
  const lista = document.getElementById('dpLista');
  let r;
  try {
    r = await API.get(`/duplicados/sugerencias${API.qs({ estado: F.estado, tipo: F.tipo, senal: F.senal, page: F.page, per_page: POR_PAGINA })}`);
  } catch (err) {
    lista.innerHTML = `<p class="pg-empty">No se pudieron cargar las sugerencias.<br>${esc(err.message)}</p>`;
    return;
  }
  total = r.total;
  document.getElementById('dpTotal').textContent = mx(total);
  pintarPaginas();
  if (!r.items.length) {
    lista.innerHTML = '<p class="pg-empty">No hay pares por revisar con estos filtros.</p>';
    return;
  }
  lista.innerHTML = r.items.map(s => `<article class="dp-par" data-a="${esc(s.a.id)}" data-b="${esc(s.b.id)}">
      <div class="dp-par-head">
        <span class="dp-senal">${esc(Propiedad.senal(s.senal))}</span>
        <span class="dp-par-acc">
          <button class="fx-btn solid" data-decide="igual">Son el mismo</button>
          <button class="fx-btn" data-decide="distinto">No son el mismo</button>
        </span>
      </div>
      ${Propiedad.fila(s.a)}${Propiedad.fila(s.b)}
    </article>`).join('');
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

// La decisión se manda y el par se quita de la lista sin recargarla: el asesor va
// revisando de arriba abajo y una recarga le movería todo bajo el cursor.
document.getElementById('dpLista').addEventListener('click', async e => {
  const b = e.target.closest('[data-decide]');
  if (!b) return;
  const par = b.closest('.dp-par'), { a, b: otro } = par.dataset;
  par.querySelectorAll('[data-decide]').forEach(x => { x.disabled = true; });
  try {
    if (b.dataset.decide === 'igual') await Propiedad.fusionar([a, otro]);
    else await Propiedad.descartar(a, otro);
  } catch (err) {
    par.querySelectorAll('[data-decide]').forEach(x => { x.disabled = false; });
    par.querySelector('.dp-senal').textContent = `No se pudo guardar: ${err.message}`;
    return;
  }
  par.classList.add('hecho');
  par.querySelector('.dp-par-head').innerHTML =
    `<span class="dp-senal">${b.dataset.decide === 'igual' ? 'Fusionados en una tarjeta' : 'Marcados como distintos'}</span>`;
  total = Math.max(0, total - 1);
  document.getElementById('dpTotal').textContent = mx(total);
  if (!document.querySelector('.dp-par:not(.hecho)')) cargar();
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

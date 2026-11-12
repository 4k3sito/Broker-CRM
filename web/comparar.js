// Comparación lado a lado de 2–4 inmuebles. Los ids llegan en la URL
// (?ids=a,b,c) desde la bandeja del tablero; quitar una columna reescribe la URL
// para que recargar o compartir el enlace muestre lo mismo. La lista también se guarda
// en sessionStorage (`ol-comparar`): si se vuelve al tablero y se regresa, o se abre
// comparar.html sin ?ids, no se pierde lo que se había elegido.

// "Volver" y «+ Agregar» regresan a la búsqueda de la que se vino, con sus filtros: el
// tablero la guarda en `ol-tablero` (misma regla que `TABLERO` en listing.js).
const TABLERO = (() => {
  try {
    const t = sessionStorage.getItem('ol-tablero');
    if (t?.startsWith('index.html')) return t;
    return sessionStorage.getItem('ol-tab') === 'inmobiliaria' ? 'index.html?tab=inmobiliaria' : 'index.html';
  } catch { return 'index.html'; }
})();

// El anuncio viene de anuncio.js; aquí sólo se le agrega lo que esta tabla compara.
function adapt(fila) {
  const l = Anuncio.de(fila);
  const [terreno, construccion] = ['Terreno', 'Construcción'].map(k => superficies(l.terreno, l.construccion, l.size).find(x => x[0] === k)?.[1] ?? null);
  return { ...l, titulo: l.titulo ?? 'Sin título', terreno, construccion };
}

// Moneda y «/mes» pegados al monto: sin ellos, $5,000,034 USD y $46,500,000 MXN se leen
// como pesos los dos, y esta tabla se imprime para el cliente.
const monTxt = (l, mes) => `<small class="cmp-mon">${esc(Anuncio.moneda(l))}${mes && l.transaccion === 'Renta' ? '/mes' : ''}</small>`;

// Filas: etiqueta, valor, formato y cuál gana (min/max). Sin `gana` no se resalta. Sólo el
// precio y el $/m² lo traen: «más superficie» o «más fotos» es opinión, no un mejor valor.
// `dinero` marca las filas cuyo número depende de la moneda y de la operación.
const FILAS = [
  { k: 'Precio',      v: Anuncio.total, f: (v, l) => v != null ? `$${mx(Math.round(v))} ${monTxt(l, true)}` : '—', cls: 'precio', gana: 'min', dinero: true },
  { k: '$ / m²',      v: Anuncio.porMetro,    f: (v, l) => v != null ? `$${mx(Math.round(v))} ${monTxt(l, true)}` : '—', cls: 'mono', gana: 'min', dinero: true },
  { k: 'Superficie',  v: l => l.size,   f: v => v != null ? `${mx(Math.round(v))} m²` : '—', cls: 'mono' },
  { k: 'Terreno',      v: l => l.terreno,      f: v => v != null ? m2Txt(v) : '—', cls: 'mono' },
  { k: 'Construcción', v: l => l.construccion, f: v => v != null ? m2Txt(v) : '—', cls: 'mono' },
  { k: 'Tipo',        v: l => l.tipo,   f: v => v ? v[0].toUpperCase() + v.slice(1) : '—' },
  { k: 'Operación',   v: l => l.transaccion, f: v => v ?? '—' },
  { k: 'Ubicación',   v: Anuncio.ubicacion, f: v => esc(v ?? '—') },
  { k: 'Fotos',       v: l => l.fotos.length,  f: v => String(v), cls: 'mono' },
  { k: 'Estado',      v: l => l.status, f: v => `<span style="color:var(--s-${v.toLowerCase()});font-weight:700">${v}</span>` },
  { k: 'Fuente',      v: l => Anuncio.fuente(l.fuente), f: v => esc(v), cls: 'mono' },
];

let items = [];
let fallos = 0;       // cuántos de los pedidos no se pudieron cargar
const guardados = () => { try { return JSON.parse(sessionStorage.getItem('ol-comparar') ?? '[]'); } catch { return []; } };
const ids = (() => {
  const url = (new URLSearchParams(location.search).get('ids') ?? '').split(',').map(decodeURIComponent).filter(Boolean);
  // Sin ?ids (se llegó con un enlace pelado o desde el menú) se usa lo último que se comparó.
  return (url.length ? url : guardados().map(String)).slice(0, 4);
})();
// Lo que se está comparando, para que el tablero (o esta misma página) lo recupere.
const recordar = () => { try { sessionStorage.setItem('ol-comparar', JSON.stringify(items.map(l => String(l.id)))); } catch { /* sin persistencia */ } };

function render() {
  const body = document.getElementById('cmpBody');
  document.getElementById('cmpTitle').textContent = items.length < 2 ? 'Comparar' : `Comparar ${items.length} inmuebles`;
  document.getElementById('cmpBack').href = TABLERO;
  // Lo que no se pudo traer no es «no hay nada»: se dice cuántos faltan.
  const aviso = fallos ? `<p class="cmp-aviso" role="status">${fallos} de ${ids.length} no se pudieron cargar. Recarga la página para intentarlo de nuevo.</p>` : '';
  if (items.length < 2) {
    body.innerHTML = `${aviso}<div class="pg-empty">Selecciona al menos dos inmuebles en el tablero para compararlos.
      <br><br><a class="btn-solid" href="${esc(TABLERO)}">Ir al tablero</a></div>`;
    return;
  }
  const mejor = document.getElementById('optMejor').checked;
  const ocultar = document.getElementById('optIguales').checked;
  const faltan = 4 - items.length;
  // Un precio sólo se compara contra otro de la misma moneda y la misma operación: USD
  // contra MXN, o renta contra venta, no son números del mismo tamaño.
  const mezcla = new Set(items.map(l => `${Anuncio.moneda(l)}|${l.transaccion}`)).size > 1;
  let ocultas = 0;

  const filas = FILAS.map(fila => {
    const vals = items.map(fila.v);
    // En las filas de dinero, el mismo número en otra moneda u operación no es igual.
    const llaves = fila.dinero ? vals.map((v, i) => `${v}|${Anuncio.moneda(items[i])}|${items[i].transaccion}`) : vals.map(String);
    const iguales = llaves.every(k => k === llaves[0]);
    if (iguales && ocultar) ocultas++;
    const nums = vals.filter(v => typeof v === 'number');
    const win = fila.gana && !(fila.dinero && mezcla) && nums.length > 1 && !iguales
      ? (fila.gana === 'min' ? Math.min(...nums) : Math.max(...nums)) : null;
    return `<tr class="${iguales ? 'igual' : ''}${iguales && ocultar ? ' ocultar' : ''}">
      <th class="cmp-k" scope="row">${fila.k}</th>
      ${items.map((l, i) => `<td class="cmp-v ${fila.cls ?? ''}${mejor && win != null && vals[i] === win ? ' mejor' : ''}">${fila.f(vals[i], l)}</td>`).join('')}
      ${faltan ? '<td class="cmp-add-cell"></td>' : ''}
    </tr>`;
  }).join('');

  body.innerHTML = `${aviso}${mezcla ? '<p class="cmp-aviso" role="status">Monedas u operaciones distintas: no se compara el precio.</p>' : ''}
  <table class="cmp-table">
    <colgroup><col class="cmp-col-k">${items.map(() => '<col class="cmp-col-v">').join('')}${faltan ? '<col class="cmp-col-add">' : ''}</colgroup>
    <thead><tr><td></td>
      ${items.map(l => `<td>
        <div class="cmp-foto">
          ${l.fotos[0] ? `<img src="${esc(l.fotos[0])}" alt="">` : '<div class="card-img-blueprint"></div>'}
          <span class="badge badge-src">${esc(Anuncio.fuente(l.fuente).toUpperCase())}</span>
          <button class="cmp-quitar" data-id="${esc(l.id)}" title="Quitar de la comparación">&times;</button>
        </div>
        <div class="cmp-nombre">${esc(l.titulo)}</div>
      </td>`).join('')}
      ${faltan ? `<td class="cmp-add"><a href="${esc(TABLERO)}" id="cmpAgregar">+ Agregar desde el tablero</a></td>` : ''}
    </tr></thead>
    <tbody>${filas}
      <tr><td></td>${items.map(l => `<td><div class="cmp-acc">
        <a class="btn-outline" href="listing.html?id=${encodeURIComponent(l.id)}">Abrir ficha</a>
      </div></td>`).join('')}${faltan ? '<td></td>' : ''}</tr>
    </tbody>
  </table>${ocultas ? `<p class="cmp-nota">${ocultas} ${ocultas === 1 ? 'fila igual oculta' : 'filas iguales ocultas'} (iguales en todos). Quita «Ocultar iguales» para verlas.</p>` : ''}`;
}

document.getElementById('cmpBody').addEventListener('click', e => {
  // El tablero ve esta marca al cargar y devuelve a la bandeja lo que se comparaba.
  if (e.target.closest('#cmpAgregar')) { try { recordar(); sessionStorage.setItem('ol-comparar-agregar', '1'); } catch { /* sin persistencia */ } return; }
  const q = e.target.closest('.cmp-quitar');
  if (!q) return;
  items = items.filter(l => String(l.id) !== q.dataset.id);
  history.replaceState(null, '', `comparar.html?ids=${items.map(l => encodeURIComponent(l.id)).join(',')}`);
  recordar();
  render();
});
document.getElementById('optMejor').addEventListener('change', render);
document.getElementById('optIguales').addEventListener('change', render);
document.getElementById('btnImprimir').addEventListener('click', () => window.print());
document.getElementById('logout-btn').addEventListener('click', async () => {
  await API.logout().catch(() => {});
  location.replace('login.html');
});

// Pide los inmuebles; un fallo de red o de sesión se enseña con «Reintentar», no como
// «selecciona al menos dos».
async function cargar() {
  const body = document.getElementById('cmpBody');
  body.innerHTML = '<p class="pg-empty">Cargando&#8230;</p>';
  try {
    await API.me();
    document.getElementById('authBox').hidden = true;
    document.getElementById('userBox').hidden = false;
    const res = await Promise.allSettled(ids.map(id => API.get(`/listings/${encodeURIComponent(id)}`)));
    items = res.filter(r => r.status === 'fulfilled').map(r => adapt(r.value));
    fallos = res.length - items.length;
    // Todos fallaron: no hay nada que enseñar salvo el error.
    if (ids.length && !items.length) {
      const e = res.find(r => r.status === 'rejected')?.reason;
      UI.errorCarga(body, `No se pudieron cargar los inmuebles${e?.message ? `: ${e.message}` : ''}`, cargar);
      return;
    }
    // Si algunos ya no existen, la URL y la lista guardada dejan de nombrarlos.
    if (fallos) history.replaceState(null, '', `comparar.html?ids=${items.map(l => encodeURIComponent(l.id)).join(',')}`);
    recordar();
    render();
  } catch (err) {
    UI.errorCarga(body, `No se pudo cargar: ${err.message}`, cargar);
  }
}
cargar();

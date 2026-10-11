// Comparación lado a lado de 2–4 inmuebles. Los ids llegan en la URL
// (?ids=a,b,c) desde la bandeja del tablero; quitar una columna reescribe la URL
// para que recargar o compartir el enlace muestre lo mismo.

// El anuncio viene de anuncio.js; aquí sólo se le agrega lo que esta tabla compara.
function adapt(fila) {
  const l = Anuncio.de(fila);
  const [terreno, construccion] = ['Terreno', 'Construcción'].map(k => superficies(l.terreno, l.construccion, l.size).find(x => x[0] === k)?.[1] ?? null);
  return { ...l, titulo: l.titulo ?? 'Sin título', terreno, construccion };
}

// Filas: etiqueta, valor, formato y cuál gana (min/max). Sin `gana` no se resalta.
const FILAS = [
  { k: 'Precio',      v: Anuncio.total, f: (v, l) => v != null ? `$${mx(Math.round(v))}${l.transaccion === 'Renta' ? '/mes' : ''}` : '—', cls: 'precio', gana: 'min' },
  { k: '$ / m²',      v: Anuncio.porMetro,    f: v => v != null ? `$${mx(Math.round(v))}` : '—', cls: 'mono', gana: 'min' },
  { k: 'Superficie',  v: l => l.size,   f: v => v != null ? `${mx(Math.round(v))} m²` : '—', cls: 'mono', gana: 'max' },
  { k: 'Terreno',      v: l => l.terreno,      f: v => v != null ? m2Txt(v) : '—', cls: 'mono', gana: 'max' },
  { k: 'Construcción', v: l => l.construccion, f: v => v != null ? m2Txt(v) : '—', cls: 'mono', gana: 'max' },
  { k: 'Tipo',        v: l => l.tipo,   f: v => v ? v[0].toUpperCase() + v.slice(1) : '—' },
  { k: 'Operación',   v: l => l.transaccion, f: v => v ?? '—' },
  { k: 'Ubicación',   v: Anuncio.ubicacion, f: v => esc(v ?? '—') },
  { k: 'Fotos',       v: l => l.fotos.length,  f: v => String(v), cls: 'mono', gana: 'max' },
  { k: 'Estado',      v: l => l.status, f: v => `<span style="color:var(--s-${v.toLowerCase()});font-weight:700">${v}</span>` },
  { k: 'Fuente',      v: l => Anuncio.fuente(l.fuente), f: v => esc(v), cls: 'mono' },
];

let items = [];
const ids = (new URLSearchParams(location.search).get('ids') ?? '').split(',').map(decodeURIComponent).filter(Boolean).slice(0, 4);

function render() {
  const body = document.getElementById('cmpBody');
  document.getElementById('cmpTitle').textContent = `Comparar ${items.length} inmuebles`;
  if (items.length < 2) {
    body.innerHTML = `<div class="pg-empty">Selecciona al menos dos inmuebles en el tablero para compararlos.
      <br><br><a class="btn-solid" href="index.html">Ir al tablero</a></div>`;
    return;
  }
  const mejor = document.getElementById('optMejor').checked;
  const ocultar = document.getElementById('optIguales').checked;
  const faltan = 4 - items.length;

  const filas = FILAS.map(fila => {
    const vals = items.map(fila.v);
    const iguales = vals.every(v => String(v) === String(vals[0]));
    const nums = vals.filter(v => typeof v === 'number');
    const win = fila.gana && nums.length > 1 && !iguales
      ? (fila.gana === 'min' ? Math.min(...nums) : Math.max(...nums)) : null;
    return `<tr class="${iguales ? 'igual' : ''}${iguales && ocultar ? ' ocultar' : ''}">
      <th class="cmp-k" scope="row">${fila.k}</th>
      ${items.map((l, i) => `<td class="cmp-v ${fila.cls ?? ''}${mejor && win != null && vals[i] === win ? ' mejor' : ''}">${fila.f(vals[i], l)}</td>`).join('')}
      ${faltan ? '<td class="cmp-add-cell"></td>' : ''}
    </tr>`;
  }).join('');

  body.innerHTML = `<table class="cmp-table">
    <colgroup><col style="width:170px">${items.map(() => '<col>').join('')}${faltan ? '<col style="width:150px">' : ''}</colgroup>
    <thead><tr><td></td>
      ${items.map(l => `<td>
        <div class="cmp-foto">
          ${l.fotos[0] ? `<img src="${esc(l.fotos[0])}" alt="">` : '<div class="card-img-blueprint"></div>'}
          <span class="badge badge-src">${esc(Anuncio.fuente(l.fuente).toUpperCase())}</span>
          <button class="cmp-quitar" data-id="${esc(l.id)}" title="Quitar de la comparación">&times;</button>
        </div>
        <div class="cmp-nombre">${esc(l.titulo)}</div>
      </td>`).join('')}
      ${faltan ? `<td class="cmp-add"><a href="index.html">+ Agregar desde el tablero</a></td>` : ''}
    </tr></thead>
    <tbody>${filas}
      <tr><td></td>${items.map(l => `<td><div class="cmp-acc">
        <a class="btn-outline" href="listing.html?id=${encodeURIComponent(l.id)}">Abrir ficha</a>
      </div></td>`).join('')}${faltan ? '<td></td>' : ''}</tr>
    </tbody>
  </table>`;
}

document.getElementById('cmpBody').addEventListener('click', e => {
  const q = e.target.closest('.cmp-quitar');
  if (!q) return;
  items = items.filter(l => String(l.id) !== q.dataset.id);
  history.replaceState(null, '', `comparar.html?ids=${items.map(l => encodeURIComponent(l.id)).join(',')}`);
  render();
});
document.getElementById('optMejor').addEventListener('change', render);
document.getElementById('optIguales').addEventListener('change', render);
document.getElementById('btnImprimir').addEventListener('click', () => window.print());
document.getElementById('logout-btn').addEventListener('click', async () => {
  await API.logout().catch(() => {});
  location.replace('login.html');
});

API.me().then(async () => {
  document.getElementById('authBox').hidden = true;
  document.getElementById('userBox').hidden = false;
  const res = await Promise.allSettled(ids.map(id => API.get(`/listings/${encodeURIComponent(id)}`)));
  items = res.filter(r => r.status === 'fulfilled').map(r => adapt(r.value));
  render();
}).catch(err => {
  document.getElementById('cmpBody').innerHTML = `<div class="pg-empty">No se pudo cargar: ${esc(err.message)}</div>`;
});

// Comparación lado a lado de 2–4 inmuebles. Los ids llegan en la URL
// (?ids=a,b,c) desde la bandeja del tablero; quitar una columna reescribe la URL
// para que recargar o compartir el enlace muestre lo mismo.

const STATUS_FROM_API = { new: 'Nuevo', reviewed: 'Revisado', contacted: 'Contactado', rented: 'Rentado', discarded: 'Descartado' };
const TXN_FROM_API = { rent: 'Renta', rental: 'Renta', sale: 'Venta' };
const FUENTES = { inmuebles24: 'Inmuebles24', lamudi: 'Lamudi', vivanuncios: 'Vivanuncios', mercadolibre: 'MercadoLibre',
  pincali: 'Pincali', propiedadesmx: 'PropiedadesMX', propiedadesmexico: 'PropiedadesMX', easybroker: 'EasyBroker', metroscubicos: 'Metros²' };

const mx = n => Number(n).toLocaleString('es-MX');

function parseLocation(loc) {
  if (loc == null) return null;
  let v = loc;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s.startsWith('{')) return s;
    try { v = JSON.parse(s); } catch { return s; }
  }
  return (v && typeof v === 'object') ? (v.name ?? null) : null;
}

function adapt(l) {
  // Precio total real: si el portal publicó $/m², se usa el total calculado.
  const total = l.price_is_per_m2 ? (l.precio_total ?? null) : (l.price_numeric ?? null);
  const size = l.property_size_m2 ?? null;
  return {
    id: l.id,
    titulo: l.title ?? l.broker_name ?? 'Sin título',
    direccion: parseLocation(l.location) ?? l.neighborhood ?? l.zona ?? null,
    zona: l.zona ?? null,
    fuente: FUENTES[l.source] ?? l.source ?? '—',
    foto: l.images?.[0] ?? l.image ?? null,
    precio: total,
    ppm: total && size ? total / size : (l.price_is_per_m2 ? l.price_numeric : null),
    size,
    tipo: l.property_type ?? null,
    txn: TXN_FROM_API[l.transaction_type] ?? 'Renta',
    status: STATUS_FROM_API[l.status] ?? 'Nuevo',
    starred: !!l.starred,
    fotos: l.images?.length ?? (l.image ? 1 : 0),
  };
}

// Filas: etiqueta, valor, formato y cuál gana (min/max). Sin `gana` no se resalta.
const FILAS = [
  { k: 'Precio',      v: l => l.precio, f: (v, l) => v != null ? `$${mx(Math.round(v))}${l.txn === 'Renta' ? '/mes' : ''}` : '—', cls: 'precio', gana: 'min' },
  { k: '$ / m²',      v: l => l.ppm,    f: v => v != null ? `$${mx(Math.round(v))}` : '—', cls: 'mono', gana: 'min' },
  { k: 'Superficie',  v: l => l.size,   f: v => v != null ? `${mx(Math.round(v))} m²` : '—', cls: 'mono', gana: 'max' },
  { k: 'Tipo',        v: l => l.tipo,   f: v => v ? v[0].toUpperCase() + v.slice(1) : '—' },
  { k: 'Operación',   v: l => l.txn,    f: v => v },
  { k: 'Ubicación',   v: l => l.direccion, f: v => esc(v ?? '—') },
  { k: 'Fotos',       v: l => l.fotos,  f: v => String(v), cls: 'mono', gana: 'max' },
  { k: 'Estado',      v: l => l.status, f: v => `<span style="color:var(--s-${v.toLowerCase()});font-weight:700">${v}</span>` },
  { k: 'Fuente',      v: l => l.fuente, f: v => esc(v), cls: 'mono' },
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
          ${l.foto ? `<img src="${esc(l.foto)}" alt="">` : '<div class="card-img-blueprint"></div>'}
          <span class="badge badge-src">${esc(l.fuente.toUpperCase())}</span>
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

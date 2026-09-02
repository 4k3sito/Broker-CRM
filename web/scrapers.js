// Salud del inventario por fuente. Deliberadamente NO es un panel de control de
// corridas: los scrapers viven en la máquina del asesor porque necesitan IP
// residencial, y el VPS no puede lanzarlos ni verlos. Lo que sí sabe la base es
// el resultado — qué trajo cada fuente, cuándo, y qué tan completo vino.
// Una corrida en vuelo se vigila con `<scraper>.py --status` en la terminal.

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                                .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = n => Number(n ?? 0).toLocaleString('es-MX');
const DIA = 86_400_000;
const plural = (n, sing, pl) => `${num(n)} ${n === 1 ? sing : pl}`;

// Una fuente "fresca" es la que se recargó esta semana. Diez días ya es sospechoso
// y un mes es inventario muerto: los portales rotan anuncios en semanas.
const FRESCURA = [
  { dias: 7,        estado: 'rentado',     label: 'Al día' },
  { dias: 21,       estado: 'contactado',  label: 'Envejeciendo' },
  { dias: Infinity, estado: 'descartado',  label: 'Rezagada' },
];

const diasDesde = iso => (Date.now() - new Date(iso).getTime()) / DIA;

function frescura(f) {
  if (f.huerfana) return { estado: 'descartado', label: 'Sin scraper' };
  const d = diasDesde(f.ultima_carga);
  return { ...FRESCURA.find(x => d < x.dias), dias: d };
}

const haceCuanto = iso => {
  const d = Math.floor(diasDesde(iso));
  if (d <= 0) return 'hoy';
  if (d === 1) return 'ayer';
  return `hace ${d} d`;
};

const FMT_FECHA = { day: '2-digit', month: 'short', year: 'numeric' };
const fecha = iso => new Date(iso).toLocaleDateString('es-MX', FMT_FECHA);
// `dia` viene como 'AAAA-MM-DD' y Date lo parsea a medianoche UTC: en México eso
// cae en el día anterior. Hay que construirlo en hora local, componente a componente.
const fechaDia = d => {
  const [a, m, dd] = d.split('-').map(Number);
  return new Date(a, m - 1, dd).toLocaleDateString('es-MX', FMT_FECHA);
};

// ── Marcado ──────────────────────────────────────────────────────────────────

// Filas etiqueta/valor de la tarjeta, como el mock. Cada una es un dato que se
// puede leer de un vistazo sin comparar barras entre tarjetas.
function fila(k, v, alerta = false) {
  return `<div class="sc-row${alerta ? ' alerta' : ''}"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
}

function tarjeta(f) {
  const fr = frescura(f);
  const pct = k => f.total ? (f[k] / f.total) * 100 : 0;
  const pc = k => `${pct(k).toFixed(pct(k) < 99.95 ? 1 : 0)} %`;
  return `
    <article class="sc-card e-${fr.estado}">
      <header class="sc-card-head">
        <span class="sc-card-dot"></span>
        <h3 class="sc-card-title">${esc(f.label)}</h3>
        <span class="sc-state">${esc(fr.label)}</span>
      </header>
      <p class="sc-card-key">${esc(f.source)}</p>

      <div class="sc-figs">
        <div class="sc-fig"><b>${num(f.total)}</b><small>anuncios</small></div>
        <div class="sc-fig"><b>${num(f.activos)}</b><small>vigentes</small></div>
        <div class="sc-fig"><b>${num(f.caidos)}</b><small>caídos</small></div>
      </div>

      <div class="sc-rows">
        ${fila('Última carga', `${fecha(f.ultima_carga)} · ${haceCuanto(f.ultima_carga)}`)}
        ${fila('Con precio', pc('con_precio'), pct('con_precio') < 90)}
        ${fila('Con superficie', pc('con_area'), pct('con_area') < 90)}
        ${fila('Geocodificados', pc('con_geo'), pct('con_geo') < 90)}
        ${fila('Con municipio', pc('con_zona'), pct('con_zona') < 90)}
        ${fila('Con foto', pc('con_foto'), pct('con_foto') < 90)}
        ${f.dual ? fila('Precio dual', num(f.dual)) : ''}
      </div>

      <footer class="sc-card-foot">
        <span>${num(f.sin_revisar)} sin revisar por liveness.py</span>
      </footer>
    </article>`;
}

// El histórico: una fila por día de carga, la fuente y cuántas filas entraron.
// Es lo más cerca de un "historial de corridas" que la base puede reconstruir —
// propdb.py no deja bitácora, sólo el observed_at que estampa en cada fila.
function historial(cargas) {
  const dias = [...new Set(cargas.map(c => c.dia))];
  return `
    <table class="sc-hist">
      <thead><tr><th>Día</th><th>Fuente</th><th>Filas cargadas</th></tr></thead>
      <tbody>${dias.map(d => cargas.filter(c => c.dia === d).map((c, i) => `
        <tr class="${i === 0 ? 'sc-hist-nuevo' : ''}">
          <td>${i === 0 ? esc(fechaDia(d)) : ''}</td>
          <td>${esc(c.source)}</td>
          <td class="sc-hist-n">${num(c.n)}</td>
        </tr>`).join('')).join('')}
      </tbody>
    </table>`;
}

function render(datos) {
  const { fuentes, cargas } = datos;
  const vivas = fuentes.filter(f => !f.huerfana);
  const huerfanas = fuentes.filter(f => f.huerfana);
  const total = fuentes.reduce((s, f) => s + f.total, 0);
  const ultima = fuentes.reduce((a, f) => f.ultima_carga > a ? f.ultima_carga : a, '');

  document.getElementById('headSummary').textContent =
    `${num(total)} anuncios · ${plural(vivas.length, 'fuente', 'fuentes')}`;

  document.getElementById('vista').innerHTML = `
    <div class="sc-head">
      <div>
        <h1 class="pg-title versal">Scrapers</h1>
        <p class="sc-sub">
          ${plural(vivas.length, 'fuente con scraper', 'fuentes con scraper')} &#183; ${num(total)} anuncios
          &#183; última carga ${esc(haceCuanto(ultima))}
        </p>
      </div>
      <p class="sc-nota">
        Las corridas se lanzan desde la terminal del asesor —necesitan IP residencial—
        y se cargan con <code>propdb.py</code>. Esta página lee el resultado en la base;
        para una corrida en vuelo, <code>&lt;scraper&gt;.py --status</code>.
      </p>
    </div>

    <section class="sc-sec">
      <h2 class="sc-h2">Fuentes activas</h2>
      <div class="sc-grid">${vivas.map(tarjeta).join('')}</div>
    </section>

    ${huerfanas.length ? `
    <section class="sc-sec">
      <h2 class="sc-h2">Sin scraper</h2>
      <p class="sc-h2-nota">Entraron alguna vez y ya nadie las refresca. El tablero
        las sigue mostrando: o se les escribe un scraper o se borran de la tabla.</p>
      <div class="sc-grid">${huerfanas.map(tarjeta).join('')}</div>
    </section>` : ''}

    <section class="sc-sec">
      <h2 class="sc-h2">Historial de cargas</h2>
      <p class="sc-h2-nota">Reconstruido del <code>observed_at</code> de cada fila:
        propdb.py no deja bitácora propia.</p>
      ${historial(cargas)}
    </section>`;
}

document.getElementById('logout-btn').addEventListener('click', async () => {
  await API.logout().catch(() => {});
  location.replace('login.html');
});

API.me().then(async user => {
  document.getElementById('authBox').hidden = true;
  document.getElementById('userBox').hidden = false;
  render(await API.get('/scrapers'));
}).catch(err => {
  console.error('No se pudo cargar el estado de los scrapers:', err);
  document.getElementById('vista').innerHTML =
    `<p class="sc-error">No se pudo leer el estado: ${esc(err.message)}</p>`;
});

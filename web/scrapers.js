// Salud del inventario por fuente. Deliberadamente NO es un panel de control de
// corridas: los scrapers viven en la máquina del asesor porque necesitan IP
// residencial, y el VPS no puede lanzarlos ni verlos. Lo que sí sabe la base es
// el resultado — qué trajo cada fuente, cuándo, y qué tan completo vino.
// Una corrida en vuelo se vigila con `<scraper>.py --status` en la terminal.

const num = n => Number(n ?? 0).toLocaleString('es-MX');
const DIA = 86_400_000;
const plural = (n, sing, pl) => `${num(n)} ${n === 1 ? sing : pl}`;

// Una fuente "fresca" es la que se recargó hace FRESCURA_DIAS días o menos. El cron carga
// una fuente por noche de lunes a viernes, así que cada una se refresca una vez por
// semana: pasado ese margen algo se rompió, y un mes es inventario muerto.
// FRESCURA_DIAS es el MISMO umbral que `avisarFrescura` de app.js (9 días): hasta la
// revisión del 2026-11-12 esta página usaba 7 y el tablero 9, y una fuente con 8 días
// salía «Envejeciendo» aquí sin aviso allá. Si uno cambia, que cambie el otro.
const FRESCURA_DIAS = 9;
const FRESCURA = [
  { hasta: FRESCURA_DIAS, estado: 'rentado',     label: 'Al día' },
  { hasta: 21,            estado: 'contactado',  label: 'Envejeciendo' },
  { hasta: Infinity,      estado: 'descartado',  label: 'Rezagada' },
];

const diasDesde = iso => (Date.now() - new Date(iso).getTime()) / DIA;

// Días completos, como los cuenta app.js: el día 9 todavía está al día.
function frescura(f) {
  if (f.huerfana) return { estado: 'descartado', label: 'Sin scraper' };
  // Una fuente nueva, sin ninguna carga, no está «rezagada»: todavía no empieza.
  if (!f.ultima_carga) return { estado: 'vacio', label: 'Sin cargas todavía' };
  const d = Math.floor(diasDesde(f.ultima_carga));
  return { ...FRESCURA.find(x => d <= x.hasta), dias: d };
}

// El nombre que se lee: el que da la API para una fuente con scraper y el de
// Anuncio.fuente() para las huérfanas, que sólo traen la clave.
const nombre = f => f.huerfana ? Anuncio.fuente(f.source) : f.label;
const tieneCargas = f => !!f.ultima_carga;

// Una cobertura nunca se redondea hacia arriba: 89.6 % pasaba por «90 %» y aun así
// salía en ámbar, que era una contradicción a la vista.
const pctTxt = (p, dec = 0) => {
  if (p >= 100) return '100';
  const k = 10 ** dec;
  return (Math.floor(p * k) / k).toFixed(dec);
};

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

// Cómo se llega al tablero con una sola fuente: `filtros-url.js` acepta `fuente`.
const verFuente = f => `index.html?fuente=${encodeURIComponent(f.source)}`;

// Filas etiqueta/valor de la tarjeta, como el mock. Cada una es un dato que se
// puede leer de un vistazo sin comparar barras entre tarjetas.
function fila(k, v, alerta = false) {
  return `<div class="sc-row${alerta ? ' alerta' : ''}"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
}

// La tarjeta es la vista del teléfono (≤700 px): la tabla comparativa necesita 980 px de
// ancho y allí no cabe. Dice lo mismo que la tabla, una fuente por tarjeta.
function tarjeta(f) {
  const fr = frescura(f);
  const pct = k => f.total ? (f[k] / f.total) * 100 : 0;
  const pc = k => `${pctTxt(pct(k), 1)} %`;
  const cuerpo = tieneCargas(f) ? `
      <div class="sc-figs">
        <div class="sc-fig"><b>${num(f.total)}</b><small>anuncios</small></div>
        <div class="sc-fig"><b>${num(f.activos)}</b><small>vigentes</small></div>
        <div class="sc-fig"><b>${num(f.caidos)}</b><small>de baja</small></div>
      </div>

      <div class="sc-rows">
        ${fila('Última carga', `${fecha(f.ultima_carga)} · ${haceCuanto(f.ultima_carga)}`)}
        ${COBERTURA.map(([k, l]) => fila(`Con ${l.toLowerCase()}`, pc(k), pct(k) < 90)).join('')}
        ${f.dual ? fila('Con dos precios', num(f.dual)) : ''}
      </div>

      <footer class="sc-card-foot">
        <span>${num(f.sin_revisar)} sin verificar si siguen publicados</span>
        <a href="${verFuente(f)}">Ver en el tablero</a>
      </footer>` : `
      <p class="sc-card-vacio">Todavía no se ha cargado ningún anuncio de esta fuente.</p>`;
  return `
    <article class="sc-card e-${fr.estado}">
      <header class="sc-card-head">
        <span class="sc-card-dot"></span>
        <h3 class="sc-card-title">${esc(nombre(f))}</h3>
        <span class="sc-state">${esc(fr.label)}</span>
      </header>
      ${cuerpo}
    </article>`;
}

// El histórico: una fila por día de carga, la fuente y cuántos anuncios entraron.
// Es lo más cerca de un "historial de corridas" que la base puede reconstruir: la
// carga no deja bitácora propia (detalle en «Detalles técnicos»). Sólo se pintan los
// últimos `hist` días: con meses de cargas la tabla era una pared.
const HIST_PASO = 14;
let hist = HIST_PASO;

function historial(cargas) {
  const todos = [...new Set(cargas.map(c => c.dia))];
  const dias = todos.slice(0, hist);
  return `
    <table class="sc-hist">
      <thead><tr><th>Día</th><th>Fuente</th><th class="sc-hist-n">Anuncios cargados</th></tr></thead>
      <tbody>${dias.map(d => cargas.filter(c => c.dia === d).map((c, i) => `
        <tr class="${i === 0 ? 'sc-hist-nuevo' : ''}">
          <td>${i === 0 ? esc(fechaDia(d)) : ''}</td>
          <td>${esc(Anuncio.fuente(c.source))}</td>
          <td class="sc-hist-n">${num(c.n)}</td>
        </tr>`).join('')).join('')}
      </tbody>
    </table>
    ${todos.length > hist ? `<button type="button" class="btn-clear sc-mas" data-mas>Ver más días (${num(todos.length - hist)} restantes)</button>` : ''}`;
}

// ── Tabla comparativa (diseño 1a) ─────────────────────────────────────────────────
// Una fila por fuente, una columna por métrica: se comparan fuentes de un
// vistazo. Bajo 90 % de cobertura la celda va en ámbar. Cada % enlaza al tablero
// filtrado por esa fuente.
const COBERTURA = [['con_precio', 'Precio'], ['con_area', 'm²'], ['con_geo', 'Ubicación'], ['con_zona', 'Municipio'], ['con_foto', 'Foto']];

function tablaFuentes(fuentes) {
  return `<div class="sc-tab">
    <div class="sc-tr sc-th"><span>Fuente</span><span>Última carga</span><span>Anuncios</span><span>Vigentes</span><span>De baja</span>
      ${COBERTURA.map(([, l]) => `<span>${l}</span>`).join('')}</div>
    ${fuentes.map(f => {
      const fr = frescura(f);
      const vacia = !tieneCargas(f);
      return `<div class="sc-tr e-${fr.estado}">
        <span class="sc-src"><i></i><span><b>${esc(nombre(f))}</b><small>${esc(fr.label)}</small></span></span>
        <span class="sc-ago">${vacia ? '—' : esc(haceCuanto(f.ultima_carga))}</span>
        <span class="sc-big">${num(f.total)}</span>
        <span class="sc-mono">${num(f.activos)}</span>
        <span class="sc-mono dim">${num(f.caidos)}</span>
        ${COBERTURA.map(([k, l]) => {
          if (vacia) return '<span class="sc-cov sin">—</span>';
          const p = f.total ? (f[k] / f.total) * 100 : 0;
          return `<a class="sc-cov${p < 90 ? ' bajo' : ''}" href="${verFuente(f)}" title="${num(f.total - (f[k] ?? 0))} sin ${esc(l.toLowerCase())}: ver ${esc(nombre(f))} en el tablero">
            <b>${pctTxt(p)}%</b><i><em style="width:${p.toFixed(1)}%"></em></i></a>`;
        }).join('')}
      </div>`;
    }).join('')}
  </div>`;
}

function alertas(fuentes) {
  const items = [];
  for (const f of fuentes) {
    const fr = frescura(f);
    if (f.huerfana) items.push(['off', `${nombre(f)}: ${num(f.total)} anuncios de una fuente que ya nadie actualiza. Hay que programarle un scraper o borrarlos.`]);
    else if (!tieneCargas(f)) continue;    // una fuente nueva no es una falla: su fila ya lo dice
    else if (fr.estado !== 'rentado') items.push(['warn', `${nombre(f)}: última carga ${haceCuanto(f.ultima_carga)}.`]);
    for (const [k, l] of COBERTURA) {
      const p = f.total ? (f[k] / f.total) * 100 : 100;
      if (!f.huerfana && p < 70) items.push(['warn', `${nombre(f)}: ${Math.round(100 - p)} % de sus anuncios sin ${l.toLowerCase()}.`]);
    }
  }
  if (!items.length) return '';
  return `<section class="sc-sec"><h2 class="sc-h2">Requieren atención</h2>
    <ul class="sc-alert">${items.map(([t, m]) => `<li class="${t}">${esc(m)}</li>`).join('')}</ul></section>`;
}

let datosActuales = null;

// /api/scrapers sólo trae las fuentes que ya tienen filas: una recién agregada (Spot2)
// no sale. /api/frescura sí lista todas las que tienen scraper, con `ultima_carga: null`
// si nunca cargaron; de ahí se completan las que faltan.
function conSinCargas(datos, fr) {
  const hay = new Set(datos.fuentes.map(f => f.source));
  const nuevas = (fr?.fuentes ?? []).filter(f => !hay.has(f.source)).map(f => ({
    source: f.source, label: f.label, huerfana: false, ultima_carga: f.ultima_carga ?? null,
    total: 0, activos: 0, caidos: 0, sin_revisar: 0, con_precio: 0, con_area: 0, con_geo: 0,
    con_zona: 0, con_foto: 0, dual: 0,
  }));
  if (!nuevas.length) return datos;
  const vivas = datos.fuentes.filter(f => !f.huerfana), huerfanas = datos.fuentes.filter(f => f.huerfana);
  return { ...datos, fuentes: [...vivas, ...nuevas, ...huerfanas] };
}

function render(datos) {
  datosActuales = datos;
  const { fuentes, cargas } = datos;
  const vivas = fuentes.filter(f => !f.huerfana);
  const huerfanas = fuentes.filter(f => f.huerfana);
  const total = fuentes.reduce((s, f) => s + f.total, 0);
  const ultima = fuentes.reduce((a, f) => (f.ultima_carga ?? '') > a ? f.ultima_carga : a, '');
  const atrasadas = vivas.filter(f => tieneCargas(f) && frescura(f).estado !== 'rentado').length;
  const sinCargas = vivas.filter(f => !tieneCargas(f));

  document.getElementById('headSummary').textContent =
    `${num(total)} anuncios · ${plural(vivas.length, 'fuente', 'fuentes')}`;

  document.getElementById('vista').innerHTML = `
    <div class="sc-head">
      <div>
        <h1 class="pg-title versal">Scrapers</h1>
        <p class="sc-sub">
          ${plural(vivas.length, 'fuente con scraper', 'fuentes con scraper')} &#183; ${num(total)} anuncios
          ${ultima ? `&#183; última carga ${esc(haceCuanto(ultima))}` : ''}
        </p>
      </div>
      <div class="sc-nota">
        <p>Los anuncios se cargan desde la computadora del asesor, porque los portales piden una conexión
          residencial. Esta página muestra lo que llegó a la base de datos: cuándo cargó cada fuente
          y qué tan completos vinieron sus anuncios.</p>
        <details class="sc-tec">
          <summary>Detalles técnicos</summary>
          <ul>
            <li>La carga la hace <code>propdb.py</code>; una corrida en marcha se sigue con <code>&lt;scraper&gt;.py --status</code>.</li>
            <li><code>liveness.py</code> revisa si un anuncio sigue publicado; los que aún no pasan por esa revisión cuentan como «sin verificar».</li>
            <li>El historial se reconstruye con <code>observed_at</code>, la fecha que la carga estampa en cada anuncio: no existe una bitácora de corridas.</li>
            <li>Una fuente está «al día» hasta ${FRESCURA_DIAS} días sin carga, el mismo umbral del aviso del tablero.</li>
          </ul>
        </details>
      </div>
    </div>

    <section class="sc-sec">
      <div class="sc-kpis">
        <div><b>${num(total)}</b><span>anuncios</span></div>
        <div><b>${num(fuentes.reduce((s, f) => s + (f.activos ?? 0), 0))}</b><span>vigentes</span></div>
        <div><b class="${atrasadas ? 'warn' : ''}">${atrasadas}</b><span>${atrasadas === 1 ? 'fuente atrasada' : 'fuentes atrasadas'}</span></div>
        <div><b>${num(fuentes.reduce((s, f) => s + (f.sin_revisar ?? 0), 0))}</b><span>sin verificar si siguen publicados</span></div>
      </div>
      ${sinCargas.length ? `<p class="sc-h2-nota">Sin cargas todavía: ${sinCargas.map(f => esc(nombre(f))).join(', ')}.</p>` : ''}
      ${tablaFuentes([...vivas, ...huerfanas])}
      <div class="sc-cards">${[...vivas, ...huerfanas].map(tarjeta).join('')}</div>
    </section>

    ${alertas(fuentes)}

    <section class="sc-sec">
      <h2 class="sc-h2">Historial de cargas</h2>
      <p class="sc-h2-nota">Un renglón por día y fuente, con cuántos anuncios entraron ese día.</p>
      <div id="scHist">${historial(cargas)}</div>
    </section>`;
}

document.getElementById('vista').addEventListener('click', e => {
  if (!e.target.closest('[data-mas]') || !datosActuales) return;
  hist += HIST_PASO;
  document.getElementById('scHist').innerHTML = historial(datosActuales.cargas);
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await API.logout().catch(() => {});
  location.replace('login.html');
});

async function cargar() {
  const vista = document.getElementById('vista');
  try {
    // /frescura es sólo para completar las fuentes sin cargas: si falla, la página sigue.
    const [datos, fr] = await Promise.all([API.get('/scrapers'), API.get('/frescura').catch(() => null)]);
    render(conSinCargas(datos, fr));
  } catch (err) {
    console.error('No se pudo cargar el estado de los scrapers:', err);
    UI.errorCarga(vista, `No se pudo leer el estado de las fuentes. ${err.message}`, () => {
      vista.innerHTML = '<p class="pg-empty">Cargando…</p>';
      cargar();
    });
  }
}

API.me().then(user => {
  // La API responde 403 de todos modos; esto sólo evita pintar el error a quien
  // llegó por una liga vieja.
  if (!user.scrapers) { location.replace('index.html'); return; }
  document.getElementById('authBox').hidden = true;
  document.getElementById('userBox').hidden = false;
  return cargar();
}).catch(err => {
  console.error(err);
  UI.errorCarga(document.getElementById('vista'), `No se pudo abrir la sesión. ${err.message}`,
    () => location.reload());
});

// Tablero de propiedades. El filtro es una "sentencia editable": cada criterio es
// un token que se quita con la ×, y `+ filtro` (⌘K) abre la paleta para agregar
// otro. Sustituye a las filas de píldoras — con diez filtros posibles, una fila
// por filtro no cabía en la barra y el asesor no veía qué tenía aplicado.
// Todo el filtrado ocurre en SQL: antes se bajaba la tabla entera (~25 MB).

// El anuncio —su forma, sus precios y sus etiquetas— viene de anuncio.js.

// Dos pestañas, la misma página: Bolsa Inmobiliaria (anuncios sin ficha) y
// Catálogo (lo que ya tiene ficha o se presentó a un cliente). Sólo cambia `ficha=`
// en la API; Catálogo suma los filtros de cliente y etapa. En el código y en la URL
// la pestaña sigue siendo `inmobiliaria`: así se llamó en pantalla hasta el 2026-10-06.
const TAB = new URLSearchParams(location.search).get('tab') === 'inmobiliaria' ? 'inmobiliaria' : 'bolsa';
const INMO = TAB === 'inmobiliaria';
document.getElementById('pageTitle').textContent = INMO ? 'Catálogo' : 'Bolsa Inmobiliaria';
// Cómo se llama la vista con que abre el mapa (config.js).
const CENTRO_NOMBRE = window.OL_CONFIG?.centroNombre ?? 'Monterrey';
try { sessionStorage.setItem('ol-tab', TAB); } catch { /* sin persistencia */ }
document.title = `${INMO ? 'Catálogo' : 'Bolsa Inmobiliaria'} · OfficeLab`;

const TIPOS  = ['oficina', 'local', 'bodega', 'terreno', 'edificio'];
const ORDENES = { recientes: 'Recientes', precio_asc: 'Precio: menor a mayor', precio_desc: 'Precio: mayor a menor', m2_desc: 'Superficie: mayor a menor' };

// Qué es cada pestaña y de dónde sale «todo»: Bolsa y Catálogo son la misma página con
// otra consulta, y nada en pantalla lo decía (R1-05).
const AYUDA_TAB = INMO ? 'Propiedades con ficha o propuestas a clientes.' : 'Anuncios de portales sin seguimiento comercial.';
const DONDE = INMO ? 'todo el Catálogo' : 'toda la Bolsa';
document.getElementById('tabAyuda').textContent = AYUDA_TAB;


const ICON_PIN = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
const ICON_BUILDING_LG = `<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M3 21V7l9-4 9 4v14"/><polyline points="9 22 9 12 15 12 15 22"/><path d="M3 7h18"/></svg>`;

// ── Estado ───────────────────────────────────────────────────────────────────

// Un solo objeto con lo que la API entiende. Los tokens son una vista de esto,
// no una estructura paralela: así no hay dos verdades que sincronizar.
const F = {
  q: '', operacion: '', fuente: '',
  precio_min: '', precio_max: '', m2_min: '', m2_max: '', m2_de: '', ppm_min: '', ppm_max: '',
  near: '', radio: 2000, orden: 'recientes',
  cliente: null,   // { id, nombre } cuando se llegó con ?cliente=<id>: sus criterios son los filtros
  // Sólo Inmobiliaria: a qué cliente se presentó y en qué etapa va el proceso.
  pcliente: '', etapas: [], asesor: '',
  // Los tres de la barra fija. `lugares` guarda el objeto completo y no sólo el id
  // porque el chip tiene que poder decir "Monterrey" sin volver a preguntarle a la API.
  lugares: [],     // [{ valor:'m40', nombre:'Monterrey', estado:'Nuevo León' }]
  tipos: [],       // ['local','bodega']
  usos: [],        // uso de los terrenos: ['comercial','industrial'] o 'sin' (ver USOS_TERRENO en la API)
  carac: {},       // características: { altura_min: 8, elevador: 1 } (ver CARACS)
};

// Los cuatro tipos que ofrece el filtro. `oficina` se queda con cero anuncios por
// decisión de producto —van a llegar— y `edificio` se fue porque nunca pudo devolver
// nada: no es un valor que produzca tipo_norm(). Misma lista que TIPOS_COM en la API.
const TIPOS_COM = ['oficina', 'local', 'bodega', 'terreno'];
const MAX_LUGARES = 20;          // igual que en la API
let filterStatus  = 'Todos';
let filterStarred = false;
let searchStreet  = '';
let page = 1;
const PAGE_SIZE = 70;

let listings = [], listingsMap = {}, totalFiltrado = 0;
let facetas = { total: 0, destacados: 0, por_estado: {}, por_fuente: {} };
// Selección múltiple: sobrevive a cambios de página y de filtro. Guarda el
// inmueble completo para que la bandeja no dependa de la página visible.
const seleccion = new Map();
const MAX_COMPARAR = 4;
const MAX_FUSION = 30;      // el tope de la API (duplicados.MAX_FUSION)

// ── Filtros fuera de la barra ────────────────────────────────────────────────

// Todo filtro vive en la barra fija (`fb-`), con borrador y «Aplicar». Aquí sólo queda lo
// que no se elige ahí: el cliente al que se llegó con ?cliente=<id>, cuyos criterios son
// los filtros. Antes había además una paleta (⌘K) y un editor por token que filtraban con
// cada tecla: tres mecanismos para lo mismo (R1-30).
// De qué superficie habla el filtro de m². Vacío: la del anuncio, sea cual sea.
const M2_DE = { terreno: 'terreno', construccion: 'construcción' };

function rango(min, max, fmt) {
  if (min && max) return `${fmt(min)} — ${fmt(max)}`;
  if (max) return `hasta ${fmt(max)}`;
  return `desde ${fmt(min)}`;
}

// ── Datos ────────────────────────────────────────────────────────────────────

// `G` es de dónde se leen los filtros: F, o un borrador del popover para contar cuántos
// resultados daría antes de aplicarlo.
const paramsBase = (G = F) => ({
  q: searchStreet || G.q,
  lugar: G.lugares.map(l => l.valor), tipo: G.tipos,
  uso: G.tipos.includes('terreno') ? G.usos : [],
  ...caracPuesta(G),
  operacion: G.operacion, fuente: G.fuente,
  precio_min: G.precio_min, precio_max: G.precio_max,
  m2_min: G.m2_min, m2_max: G.m2_max, m2_de: (G.m2_min || G.m2_max) ? G.m2_de : '',
  ppm_min: G.ppm_min, ppm_max: G.ppm_max,
  near: G.near, radio: G.near ? G.radio : '',
  favoritos: filterStarred,
  ficha: INMO ? 'con' : 'sin',
  // 'sin' no es un cliente: es "lo que no se le ha presentado a nadie".
  pcliente: INMO && G.pcliente !== 'sin' ? G.pcliente : '', sin_cliente: INMO && G.pcliente === 'sin',
  etapa: INMO ? G.etapas : [],
  asesor: INMO ? G.asesor : '',
});

async function cargarPagina() {
  const [lista, f] = await Promise.all([
    API.get(`/listings${API.qs({ ...paramsBase(), orden: F.orden,
      estado: filterStatus !== 'Todos' ? Anuncio.estadoApi(filterStatus) : '',
      page, per_page: PAGE_SIZE })}`),
    // Las facetas ignoran el filtro de estado a propósito: alimentan las píldoras.
    API.get(`/listings/facets${API.qs(paramsBase())}`),
  ]);
  listings = lista.items.map(Anuncio.de);
  listingsMap = Object.fromEntries(listings.map(l => [l.id, l]));
  totalFiltrado = lista.total ?? listings.length;
  // Los valores por defecto evitan que una respuesta incompleta tumbe el render:
  // peor un contador en cero que una página en blanco.
  facetas = { total: 0, destacados: 0, por_estado: {}, por_fuente: {}, ...(f ?? {}) };
}

// ── Estado y destacado de un anuncio ─────────────────────────────────────────

// Cambiar el estado o la ☆ ya no repinta el tablero: la tarjeta y los contadores se
// actualizan en su sitio. Antes se llamaba a `render()` justo después del PUT sin esperarlo;
// la lectura podía llegar antes que la escritura y la tarjeta volvía sola a su estado
// anterior, además de perder el scroll y el foco (R1-12).
const cuentaEstado = (clave, d) => { facetas.por_estado[clave] = Math.max(0, (facetas.por_estado[clave] ?? 0) + d); };
function moverCuentas(antes, despues) {
  if (antes.status !== despues.status) {
    cuentaEstado(Anuncio.estadoApi(antes.status), -1);
    cuentaEstado(Anuncio.estadoApi(despues.status), +1);
  }
  if (!!antes.starred !== !!despues.starred) facetas.destacados = Math.max(0, facetas.destacados + (despues.starred ? 1 : -1));
  renderStatusPills();
}

// Lo que dice la tarjeta del anuncio `id`, desde su objeto, sin tocar el resto de la página.
function pintarEstado(id) {
  const l = listingsMap[id];
  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (!l || !card) return;
  card.classList.toggle('starred', !!l.starred);
  [...card.classList].filter(c => c.startsWith('status-')).forEach(c => card.classList.remove(c));
  card.classList.add(`status-${l.status.toLowerCase()}`);
  // Si el filtro activo ya no la incluiría, se atenúa hasta el siguiente filtro en vez de
  // desaparecer bajo el dedo.
  card.classList.toggle('fuera', (filterStatus !== 'Todos' && l.status !== filterStatus) || (filterStarred && !l.starred));
  const star = card.querySelector('.btn-star');
  star.innerHTML = l.starred ? '&#9733;' : '&#9734;';
  star.title = l.starred ? 'Quitar destacado' : 'Destacar';
  star.setAttribute('aria-label', star.title);
  star.setAttribute('aria-pressed', !!l.starred);
  const sel = card.querySelector('.status-select');
  sel.value = l.status;
  sel.className = `status-select s-${l.status}`;
  card.querySelector('.status-dot').style.background = `var(--s-${l.status.toLowerCase()})`;
}

// Aplica un cambio a la copia local (la de la página y la de la selección) y devuelve
// cómo estaba, para poder deshacerlo.
function poner(id, patch) {
  const objs = [listingsMap[id], seleccion.get(id)].filter((o, i, a) => o && a.indexOf(o) === i);
  if (!objs.length) return {};
  const previo = Object.fromEntries(Object.keys(patch).map(k => [k, objs[0][k]]));
  const antes = { status: objs[0].status, starred: objs[0].starred };
  objs.forEach(o => Object.assign(o, patch));
  moverCuentas(antes, objs[0]);
  pintarEstado(id);
  return previo;
}

// El PUT lleva sólo lo que cambió. La API aplica COALESCE campo por campo, y mandar los
// tres (estado, ☆ y nota) desde una copia vieja pisaba la nota que se acababa de escribir
// en la ficha, que abre en otra pestaña (R1-02).
const cuerpoEstado = patch => {
  const c = {};
  if ('status' in patch) c.status = Anuncio.estadoApi(patch.status);
  if ('starred' in patch) c.starred = patch.starred;
  return c;
};

async function setState(id, patch, sinAviso = false) {
  if (!listingsMap[id]) return;
  const previo = poner(id, patch);
  try {
    await UI.guardar(API.put(`/listings/${encodeURIComponent(id)}/estado`, cuerpoEstado(patch)),
      { que: 'status' in patch ? 'el estado' : 'el destacado', revertir: () => poner(id, previo) });
  } catch { return; }      // UI.guardar ya avisó y revirtió
  if (sinAviso) return;
  const msg = 'status' in patch ? `Marcado como ${patch.status}`
    : patch.starred ? 'Agregado a destacados' : 'Quitado de destacados';
  toast(msg, () => setState(id, previo, true));
}

// El mismo cambio para varias a la vez. Cada PUT va aparte (`allSettled`): si uno falla,
// los demás se quedan y la cuenta de los que no se guardaron se dice (R1-04, R1-12).
async function estadoEnLote(pares) {
  const antes = new Map(pares.map(([id]) => [id, (listingsMap[id] ?? seleccion.get(id))?.status]));
  pares.forEach(([id, st]) => poner(id, { status: st }));
  const res = await Promise.allSettled(pares.map(([id, st]) =>
    API.put(`/listings/${encodeURIComponent(id)}/estado`, { status: Anuncio.estadoApi(st) })));
  const ok = [], fallidos = [];
  res.forEach((r, i) => {
    const id = pares[i][0];
    if (r.status === 'fulfilled') ok.push(id);
    else { fallidos.push(id); poner(id, { status: antes.get(id) }); }
  });
  return { ok, fallidos, antes };
}

// ── Precio ───────────────────────────────────────────────────────────────────

// Las reglas son de anuncio.js; aquí sólo se escriben. Un total calculado se redondea;
// el precio publicado se enseña tal cual.
function fmtPrice(l) {
  const v = Anuncio.precioVisible(l);
  if (!v) return null;
  if (v.parcial) return { n: mx(v.monto), nota: 'por m²', parcial: true };
  return v.unitario != null ? { n: mx(Math.round(v.monto)), nota: `$${mx(v.unitario)}/m²` } : { n: mx(v.monto) };
}

// Una moneda que no es pesos se distingue a la vista: con borde y en tinta (R1-18). Un
// «$5,000,000» en dólares no puede leerse como pesos.
const claseMoneda = mon => mon === 'MXN' ? 'currency' : 'currency usd';

// La operación pegada a su precio («$2,650,000 MXN en venta»), con la misma marca que
// los dos precios de un inmueble en renta y venta.
const opTxt = op => op ? `<span class="price-op">en ${esc(op.toLowerCase())}</span>` : '';
// Un inmueble en renta Y en venta lleva los dos precios con el mismo peso, cada uno con
// su operación, como en EasyBroker. La que pide el filtro de operación va arriba.
function preciosDualHtml(l, ofs, rg) {
  const mon = Anuncio.moneda(l);
  return `<div class="card-precios">${ofs.map(o => {
    const op = `<span class="price-op">en ${esc((o.op ?? '').toLowerCase())}</span>`;
    const unidad = `${mon}${o.parcial ? ' / m²' : ''}${o.op === 'Renta' ? ' / mes' : ''}`;
    const cur = `<span class="${claseMoneda(mon)}">${unidad}</span>`;
    if (o.principal && rg)
      return `<div class="card-price dos rango"><strong>${dineroCorto(rg.min)}</strong><span class="card-a">a</span><strong>${dineroCorto(rg.max)}</strong>${cur}${op}</div>`;
    if (o.monto == null) return `<div class="card-price dos"><strong class="no-price">Precio por confirmar</strong>${op}</div>`;
    return `<div class="card-price dos"><strong>$${mx(Math.round(o.monto))}</strong>${cur}${op}</div>`;
  }).join('')}</div>`;
}

// Los datos de la tarjeta, en dos renglones. Las superficies llevan su etiqueta escrita:
// el `title` no existe en el teléfono, y terreno y construcción hay que poder distinguirlos
// de un vistazo. Abajo, lo que importa de ese tipo de inmueble (POR_TIPO en
// api/atributos.py). Lo que no se sabe no sale.
const CORTA_M2 = { Terreno: 'Terreno', Construcción: 'Constr.', Superficie: 'Sup.' };
// En el teléfono no hay `title`: un icono con «2» no dice si son cajones o baños. La
// etiqueta corta sólo se ve en pantallas táctiles (CSS); el lector de pantalla la lee siempre.
const CORTA_DATO = { cajones: 'Caj.', banos: 'Baños', altura: 'Alt.', andenes: 'And.', frente: 'Frente', elevador: 'Elev.' };
function hechosHtml(l) {
  const m2 = Anuncio.superficiesDe(l);
  const datos = Anuncio.datos(l);
  return (m2.length ? `<div class="card-hechos card-m2">${m2.map(s =>
      `<span title="${esc(s.detalle)}">${Iconos.de(s.clave)}<small>${CORTA_M2[s.clave]}</small>${esc(s.texto)}</span>`).join('')}</div>` : '') +
    (datos.length ? `<div class="card-hechos">${datos.map(d =>
      `<span title="${esc(d.detalle)}">${Iconos.de(d.clave)}<small class="hecho-et" aria-hidden="true">${esc(CORTA_DATO[d.clave] ?? d.etiqueta)}</small><span class="sr-only">${esc(d.etiqueta)}: </span>${esc(d.texto)}</span>`).join('')}</div>` : '');
}

// ── Tarjeta ──────────────────────────────────────────────────────────────────


function renderCard(l) {
  const blabel = Anuncio.fuente(l.fuente).toUpperCase();
  const p = fmtPrice(l);
  const foto = l.fotos?.[0] ?? null;
  // Si el precio ya es por m², repetirlo aquí sería decir dos veces lo mismo.
  const ofs = Anuncio.ofertas(l, F.operacion), dual = ofs.length > 1;
  // Con dos precios, el $/m² es el de la oferta que va arriba.
  const pm = dual ? (ofs[0].unitario ?? (ofs[0].monto && l.size ? ofs[0].monto / l.size : null))
    : l.porM2 ? null : Anuncio.porMetro(l);
  const ppm = pm ? `$${mx(Math.round(pm))} / m²` : '';
  const sufijo = l.transaccion === 'Renta' ? `${Anuncio.moneda(l)} / mes` : Anuncio.moneda(l);
  const cur = `<span class="${claseMoneda(Anuncio.moneda(l))}">${sufijo}</span>`;

  const imgHtml = foto
    ? `<img src="${esc(foto)}" alt="" loading="lazy">`
    : `<div class="card-img-blueprint"></div><div class="card-img-icon">${ICON_BUILDING_LG}</div>`;

  // Varios anuncios del mismo inmueble: la tarjeta enseña entre qué precios se ofrece.
  const rg = Anuncio.rango(l), dup = Anuncio.resumen(l);
  const priceHtml = dual
    ? preciosDualHtml(l, ofs, rg)
    : rg
    ? `<div class="card-price rango"><strong>${dineroCorto(rg.min)}</strong><span class="card-a">a</span><strong>${dineroCorto(rg.max)}</strong>${cur}${opTxt(l.transaccion)}</div>`
    : p
    ? `<div class="card-price"><strong>$${p.n}</strong>${cur}${opTxt(l.transaccion)}</div>` +
      (p.nota ? `<span class="price-note">${p.nota}${p.parcial ? '' : ' × ' + mx(l.size) + ' m²'}</span>` : '')
    : `<div class="card-price"><strong class="no-price">Sin precio</strong>${opTxt(l.transaccion)}</div>`;

  const sel = seleccion.has(l.id);
  const ins = Anuncio.insignia(l), mercado = Anuncio.tiempoEnMercado(l);
  // El título es el enlace de la tarjeta, extendido a toda ella con ::after (CSS): clic medio,
  // Ctrl+clic, «copiar dirección del enlace» y Tab funcionan. La ficha abre en otra pestaña a
  // propósito, para que «Volver» la cierre y la búsqueda siga en ésta.
  return `<article class="card ${l.starred ? 'starred' : ''}${sel ? ' sel' : ''} status-${l.status.toLowerCase()}" data-id="${esc(l.id)}">
    <div class="card-img">
      ${imgHtml}
      <span class="badge badge-src">${esc(l.fuentes.length > 1 ? `${l.fuentes.length} PORTALES` : blabel)}</span>
      ${l.fotos?.length ? `<span class="badge badge-foto">FOTO 1/${l.fotos.length}</span>` : ''}
      ${ins ? `<span class="badge badge-mercado" title="${esc(ins.detalle)}">${esc(ins.texto)}</span>` : ''}
      <button type="button" class="card-chk" title="Seleccionar para comparar" aria-label="Seleccionar para comparar" aria-pressed="${sel}">${sel ? '&#10003;' : ''}</button>
      <button type="button" class="btn-star" title="${l.starred ? 'Quitar destacado' : 'Destacar'}" aria-label="${l.starred ? 'Quitar destacado' : 'Destacar'}" aria-pressed="${!!l.starred}">${l.starred ? '&#9733;' : '&#9734;'}</button>
    </div>
    <div class="card-body">
      <div class="card-top">
        <div style="min-width:0">
          ${priceHtml}
          ${ppm ? `<div class="card-ppm">${ppm}</div>` : ''}
          ${dup ? `<div class="card-dup" title="Anuncios del mismo inmueble, fusionados en esta tarjeta">${dup}</div>` : ''}
        </div>
      </div>
      <div class="card-title"><a class="card-link" href="listing.html?id=${encodeURIComponent(l.id)}" target="_blank" rel="opener" title="${esc(l.titulo ?? '')}">${esc(l.titulo || 'Ver el inmueble')}</a></div>
      ${Anuncio.ubicacion(l) ? `<div class="card-dir" title="${esc(Anuncio.ubicacion(l))}">${ICON_PIN}<span class="card-dir-t">${esc(Anuncio.ubicacion(l))}</span></div>` : ''}
      ${hechosHtml(l)}
      <div class="card-tags">
        ${l.tipo ? `<span class="tag-tipo">${esc(l.tipo)}</span>` : ''}
        ${Anuncio.operacion(l) ? `<span class="tag-txn">${esc(Anuncio.operacion(l))}</span>` : ''}
        ${l.codigo ? `<span class="tag-cod">${esc(l.codigo)}</span>` : ''}
      </div>
      <div class="card-sep"></div>
      <div class="card-pie">
        <div class="card-status">
          <span class="status-dot" style="background:var(--s-${l.status.toLowerCase()})"></span>
          <select class="status-select s-${l.status}" aria-label="Estado">
            ${Anuncio.ESTADOS.map(st => `<option${st === l.status ? ' selected' : ''}>${st}</option>`).join('')}
          </select>
        </div>
        ${mercado ? `<span class="card-mercado" title="En el mercado desde al menos el ${esc(Anuncio.fecha(l.desde))}">${esc(mercado)} en mercado</span>` : ''}
      </div>
    </div>
  </article>`;
}

// ── Lo puesto, lo de fábrica y el vacío ──────────────────────────────────────

// La Bolsa abre buscando en el área de partida (`near`, con el nombre de `config.js`): esa
// ubicación es «de fábrica» y no cuenta como un filtro que el asesor puso. «Restablecer» sólo
// aparece cuando algo difiere de ahí (R1-10); antes «Limpiar» estaba activo desde la carga.
const ubicacionDeFabrica = () => !F.lugares.length && (!F.near || (F.nearTxt === CENTRO_NOMBRE && Number(F.radio) === areaInicial().radio));
function deFabrica() {
  return ubicacionDeFabrica() && !F.cliente && FB_CLAVES.every(k => k === 'ubicacion' || !fbPuesto[k]())
    && !F.q && !searchStreet && filterStatus === 'Todos' && !filterStarred && F.orden === 'recientes';
}
// Cuántos filtros hay puestos, para el botón «Filtros (n)» del teléfono. Cuenta también la
// ubicación de fábrica («Monterrey · 10 km»): restringe los resultados aunque no la pusiera
// la persona, y el chip de escritorio la muestra.
const fbCuenta = () => FB_CLAVES.filter(k => fbPuesto[k]()).length
  + (F.orden !== 'recientes' ? 1 : 0);

function renderTokens() {
  // Sólo queda el token del cliente: los demás filtros son chips de la barra fija.
  document.getElementById('tokens').innerHTML = F.cliente ? `
    <span class="tok">
      <button class="tok-edit" data-campo="cliente">
        <span class="tok-kind">Cliente</span>${esc(F.cliente.nombre)}
      </button>
      <button class="tok-del" data-campo="cliente" title="Quitar" aria-label="Quitar el filtro del cliente ${esc(F.cliente.nombre)}">&times;</button>
    </span>` : '';
  document.getElementById('qbar-clear').hidden = deFabrica();
  const n = fbCuenta();
  document.getElementById('fbTodosN').textContent = n ? ` (${n})` : '';
}

// Lo que hay puesto y puede estorbar, cada cosa con su forma de quitarla: el vacío del
// tablero le dice a la persona cuál es el filtro, en vez de pedirle que «quite un token».
function filtrosPuestos() {
  const l = FB_CLAVES.filter(k => fbPuesto[k]()).map(k => ({ texto: `${FB_TITULO[k]}: ${fbResumen[k]()}`, quitar: () => fbQuitar(k) }));
  if (F.q || searchStreet) l.push({ texto: `Búsqueda: «${searchStreet || F.q}»`, quitar: () => {
    clearTimeout(busquedaEspera); F.q = ''; searchStreet = ''; searchInput.value = '';
    document.getElementById('searchChip').hidden = true; page = 1; render(); } });
  if (filterStatus !== 'Todos') l.push({ texto: `Estado: ${filterStatus}`, quitar: () => { filterStatus = 'Todos'; page = 1; render(); } });
  if (filterStarred) l.push({ texto: 'Sólo destacados', quitar: () => { filterStarred = false; page = 1; render(); } });
  return l;
}

function pintarVacio(grid) {
  const puestos = filtrosPuestos();
  grid.innerHTML = `<div class="empty">
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35M8 11h6"/></svg>
      <h2>Ning&#250;n inmueble cumple estos filtros</h2>
      <p>${puestos.length ? `Quita uno de los de abajo o pulsa Restablecer para volver a ${DONDE}.`
          : `Todav&#237;a no hay inmuebles en ${INMO ? 'el Cat&#225;logo' : 'la Bolsa'}.`}</p>
      ${puestos.length ? `<div class="empty-quitar">${puestos.map((f, i) =>
        `<button type="button" class="btn-clear" data-quitar="${i}">Quitar ${esc(f.texto)} &times;</button>`).join('')}</div>
      <button class="btn-solid" id="empty-clear">Restablecer</button>` : ''}
    </div>`;
  grid.querySelector('.empty-quitar')?.addEventListener('click', e => {
    const b = e.target.closest('[data-quitar]');
    if (b) puestos[Number(b.dataset.quitar)].quitar();
  });
  document.getElementById('empty-clear')?.addEventListener('click', limpiarTodo);
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderStats() {
  const n = e => facetas.por_estado[Anuncio.estadoApi(e)] ?? 0;
  const celda = (num, label, color) =>
    `<div class="stat"><span class="stat-num" style="color:${color}">${mx(num)}</span>` +
    `<span class="stat-label">${label}</span></div>`;
  document.getElementById('statsBar').innerHTML =
    `<div class="stat stat-main"><span class="stat-num">${mx(totalFiltrado)}</span>` +
    `<span class="stat-label">listados visibles</span></div>` +
    celda(n('Nuevo'), 'nuevos', 'var(--s-nuevo)') +
    celda(n('Revisado'), 'revisados', 'var(--s-revisado)') +
    celda(n('Contactado'), 'contactados', 'var(--s-contactado)') +
    celda(n('Rentado'), 'rentados', 'var(--s-rentado)') +
    celda(facetas.destacados, '★ destacados', 'var(--accent)');
}

function renderStatusPills() {
  const n = v => v === 'Todos' ? facetas.total : (facetas.por_estado[Anuncio.estadoApi(v)] ?? 0);
  const todos = ['Todos', ...Anuncio.ESTADOS];
  // Una píldora en cero pesaba lo mismo que las que tienen datos: se atenúa (R1-44).
  document.getElementById('statusPills').innerHTML = todos.map(v =>
    `<button class="pill${filterStatus === v ? ' active' : ''}${n(v) === 0 && filterStatus !== v ? ' cero' : ''}" data-group="status" data-val="${v}">` +
    `${v}<span class="pill-count">${mx(n(v))}</span></button>`).join('');
  // En el teléfono las siete píldoras no caben y se cortaban («Todos 11,09»): ahí el estado
  // es un <select> en su propia fila, con el total completo (R1-09).
  document.getElementById('estadoSel').innerHTML = todos.map(v =>
    `<option value="${v}"${filterStatus === v ? ' selected' : ''}>Estado: ${v} (${mx(n(v))})</option>`).join('');
  document.getElementById('pill-starred').classList.toggle('active', filterStarred);
  document.getElementById('pill-starred').classList.toggle('cero', !facetas.destacados && !filterStarred);
  document.getElementById('starredCount').textContent = mx(facetas.destacados);
}

function renderPagination(totalPages) {
  const box = document.getElementById('pagination');
  if (totalPages <= 1) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <button class="btn-clear" id="page-prev" ${page <= 1 ? 'disabled' : ''}>&larr; Anterior</button>
    <span>P&#225;gina ${mx(page)} de ${mx(totalPages)}</span>
    <button class="btn-clear" id="page-next" ${page >= totalPages ? 'disabled' : ''}>Siguiente &rarr;</button>`;
  // Volver al inicio de la lista lo hace `_render` al ver que cambió la consulta (el scroll
  // vive en `.inm-list`, no en la ventana).
  const ir = d => { page += d; render(); };
  document.getElementById('page-prev')?.addEventListener('click', () => ir(-1));
  document.getElementById('page-next')?.addEventListener('click', () => ir(1));
}

let renderEnCurso = null;
let renderEnEspera = false;   // hay una carga encolada que todavía no arranca

function render() {
  // Un clic rápido en varios filtros dispararía peticiones que llegan desordenadas;
  // encadenarlas garantiza que la última en salir es la que se pinta. Y las que llegan
  // mientras una corre se juntan en una sola: como lee los filtros al arrancar, las
  // intermedias sobraban (teclear "monterrey" encadenaba nueve cargas completas).
  if (renderEnEspera) return renderEnCurso;
  renderEnEspera = true;
  cargando(true);
  renderEnCurso = (renderEnCurso ?? Promise.resolve()).then(() => {
    renderEnEspera = false;
    return _render();
  }).catch(err => {
    console.error(err);
    UI.errorCarga(document.getElementById('grid'), `No se pudo cargar el inventario: ${err.message}`, render);
  }).finally(() => { if (!renderEnEspera) cargando(false); });
  return renderEnCurso;
}

// Filtrar no daba señal: la rejilla conservaba las tarjetas viejas hasta que llegaba la
// respuesta. Se atenúa y la fila de estado dice «Actualizando…»; sólo si tarda más de
// 150 ms, para que una respuesta rápida no parpadee.
let cargandoReloj = 0;
function cargando(si) {
  clearTimeout(cargandoReloj);
  const aplicar = v => {
    document.getElementById('grid').classList.toggle('cargando', v);
    document.getElementById('grid').setAttribute('aria-busy', v);
    document.getElementById('cargandoTxt').hidden = !v;
  };
  if (si) cargandoReloj = setTimeout(() => aplicar(true), 150); else aplicar(false);
}
const ordenSel = document.getElementById('ordenSel');
ordenSel.innerHTML = Object.entries(ORDENES).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
ordenSel.addEventListener('change', () => { F.orden = ordenSel.value; page = 1; render(); });

// La consulta que se pintó la última vez. Si cambia —otro filtro, otro orden, otra página—
// la lista vuelve a su inicio; si sólo cambió el estado o la ☆ de una tarjeta, no (R1-07).
let firmaPintada = null;

async function _render() {
  await cargarPagina();

  document.getElementById('ordenSel').value = F.orden;
  renderTokens();
  renderFB();
  renderStatusPills();
  renderTray();
  sincronizarURL();
  // El total viaja en el botón: «CSV» a secas no decía de cuántos inmuebles era.
  const csv = `Exportar CSV (${mx(totalFiltrado)})`;
  document.getElementById('export-btn').textContent = csv;
  document.getElementById('masCsv').textContent = csv;

  const firma = JSON.stringify([paramsBase(), F.orden, filterStatus, page]);
  const alInicio = () => {
    if (firmaPintada !== null && firma !== firmaPintada) {
      document.getElementById('inmList').scrollTop = 0;
      window.scrollTo(0, 0);
    }
    firmaPintada = firma;
  };

  const grid = document.getElementById('grid');
  if (!listings.length) {
    pintarVacio(grid);
    alInicio();
    document.getElementById('pagination').innerHTML = '';
    Mapa.pintar([], { total: 0, pagina: page });
    return;
  }

  const totalPages = Math.max(1, Math.ceil(totalFiltrado / PAGE_SIZE));
  if (page > totalPages) { page = totalPages; return _render(); }
  renderPagination(totalPages);
  grid.innerHTML = listings.map(renderCard).join('');
  alInicio();
  // La ficha usa esto para anterior/siguiente sin volver al tablero.
  try { sessionStorage.setItem('ol-nav', JSON.stringify(listings.map(l => String(l.id)))); } catch { /* sin contexto */ }
  Mapa.pintar(listings, { total: totalFiltrado, pagina: page });
}

// ── La URL ───────────────────────────────────────────────────────────────────

// Cada render deja los filtros en la URL (filtros-url.js), para que recargar no los
// pierda y la búsqueda se pueda mandar por liga. replaceState y no pushState: teclear
// una búsqueda no debe llenar el historial de "atrás".
// Cuando el mapa va siguiendo, la cercanía es lo que el mapa enseña: se guarda la
// cámara y no el punto, y al volver el mapa sigue siguiendo desde ahí.
const MAPA_TXT = 'el centro del mapa';
const nearEsMapa = () => !!F.near && [MAPA_TXT, CENTRO_NOMBRE].includes(F.nearTxt);

function sincronizarURL() {
  const sigue = !INMO && mapFollow.checked && inm.classList.contains('split') && nearEsMapa();
  const qs = FiltrosURL.escribir({
    tab: TAB, cliente: F.cliente?.id ?? '',
    q: searchStreet ? '' : F.q, calle: searchStreet,
    operacion: F.operacion, fuente: F.fuente,
    precio_min: F.precio_min, precio_max: F.precio_max,
    m2_min: F.m2_min, m2_max: F.m2_max, m2_de: F.m2_de, ppm_min: F.ppm_min, ppm_max: F.ppm_max,
    near: sigue ? '' : F.near, near_txt: F.nearTxt, radio: F.radio, mapa: sigue ? Mapa.vista() : null,
    orden: F.orden, lugares: F.lugares, tipos: F.tipos, usos: F.usos, carac: caracPuesta(),
    pcliente: INMO ? F.pcliente : '', asesor: INMO ? F.asesor : '', etapas: INMO ? F.etapas : [],
    estado: filterStatus, destacados: filterStarred, pagina: page,
  });
  const url = location.pathname + (qs ? `?${qs}` : '') + location.hash;
  if (url !== location.pathname + location.search + location.hash) history.replaceState(null, '', url);
  // "Volver al tablero" de la ficha regresa a esta misma búsqueda, no a la de fábrica.
  try { sessionStorage.setItem('ol-tablero', 'index.html' + (qs ? `?${qs}` : '')); } catch { /* sin persistencia */ }
}

// Volver de la ficha al mismo punto de la lista. El scroll vive en `.inm-list` y no en
// la ventana, y la rejilla se pinta cuando llega la API: el navegador no sabe
// restaurarlo solo y siempre regresaba arriba. Se guarda al salir, atado a la URL de
// la búsqueda, y se aplica después del primer render si la búsqueda es la misma.
const SCROLL_KEY = 'ol-scroll';
addEventListener('pagehide', () => {
  try {
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify({
      busqueda: location.search, lista: document.getElementById('inmList').scrollTop, ventana: scrollY,
    }));
  } catch { /* sin persistencia */ }
});
function restaurarScroll() {
  let s = null;
  try { s = JSON.parse(sessionStorage.getItem(SCROLL_KEY) ?? 'null'); } catch { /* sin contexto */ }
  if (!s || s.busqueda !== location.search) return;
  document.getElementById('inmList').scrollTop = s.lista;
  scrollTo(0, s.ventana);
}

// Lo que trae la URL al abrir. Lo que no viene o no es válido se queda de fábrica.
function aplicarURL() {
  const u = FiltrosURL.leer(location.search, {
    tipos: TIPOS_COM, ordenes: Object.keys(ORDENES), estados: ['Todos', ...Anuncio.ESTADOS], maxLugares: MAX_LUGARES, usos: Object.keys(USOS),
  });
  for (const k of ['q', 'operacion', 'fuente', 'precio_min', 'precio_max', 'm2_min', 'm2_max', 'm2_de', 'ppm_min', 'ppm_max', 'orden'])
    if (u[k] != null) F[k] = u[k];
  if (u.lugares) F.lugares = u.lugares;
  if (u.tipos) F.tipos = u.tipos;
  if (u.usos) F.usos = u.usos;
  if (u.carac) F.carac = u.carac;
  if (INMO) {
    if (u.pcliente) F.pcliente = u.pcliente;
    if (u.asesor) F.asesor = u.asesor;
    if (u.etapas) F.etapas = u.etapas;
  }
  if (u.calle) {
    searchStreet = u.calle;
    document.getElementById('searchChipText').textContent = searchStreet;
    document.getElementById('searchChip').hidden = false;
  } else if (u.q) searchInput.value = u.q;
  if (u.estado) filterStatus = u.estado;
  if (u.destacados) filterStarred = true;
  if (u.pagina) page = u.pagina;
  if (u.mapa) Mapa.ir(u.mapa);
  // Un punto puesto a mano manda sobre el mapa: si siguiera, lo pisaría al abrir.
  if (u.near) { F.near = u.near; F.nearTxt = u.near_txt ?? ''; if (u.radio) F.radio = u.radio; seguirMapa(false); }
  return u;
}

function limpiarTodo() {
  if (F.cliente) quitarCriterios();
  Object.assign(F, { m2_min: '', m2_max: '', m2_de: '', ppm_min: '', ppm_max: '', fuente: '', orden: 'recientes', near: '', nearTxt: '' });
  F.lugares = []; F.tipos = []; F.usos = []; F.carac = {}; F.operacion = ''; F.precio_min = ''; F.precio_max = '';
  F.pcliente = ''; F.etapas = []; F.asesor = '';
  fbCerrar();
  clearTimeout(busquedaEspera);
  F.q = ''; searchStreet = ''; filterStatus = 'Todos'; filterStarred = false;
  document.getElementById('searchInput').value = '';
  document.getElementById('searchChip').hidden = true;
  cerrarSug();
  // «Restablecer» vuelve a lo de fábrica, no a todo México: la Bolsa abre buscando en el
  // área de partida, y el mapa regresa a ella.
  if (seguirPreferido()) {
    seguirMapa(true);
    const a = areaInicial();
    Mapa.ir({ lat: a.lat, lng: a.lng, zoom: window.OL_CONFIG?.zoom ?? 11 });
    buscarEnElMapa(a, CENTRO_NOMBRE);
  }
  page = 1; render();
}

// ── Autocompletado de la búsqueda ────────────────────────────────────────────

// El cuadro de búsqueda es un combobox: las sugerencias son un listbox y se recorren con
// las flechas (R1-08). Antes eran `<div>` que sólo respondían al ratón.
let sugerenciaPeticion = 0, sugActiva = -1;
const sugBox = () => document.getElementById('searchSuggestions');

function cerrarSug() {
  sugBox().classList.remove('open');
  sugActiva = -1;
  const inp = document.getElementById('searchInput');
  inp.setAttribute('aria-expanded', 'false');
  inp.removeAttribute('aria-activedescendant');
}

async function renderSuggestions(q) {
  const box = sugBox();
  if (q.length < 2 || searchStreet) return cerrarSug();
  // Cada tecla dispara una petición; sólo la última puede pintar.
  const mia = ++sugerenciaPeticion;
  const matches = await API.get(`/ubicaciones?q=${encodeURIComponent(q)}`).catch(() => []);
  if (mia !== sugerenciaPeticion || !matches.length) return cerrarSug();
  box.innerHTML = '<div class="suggestions-header" role="presentation"><span>Ubicaciones</span></div>' +
    matches.map((s, i) => `<div class="suggestion-row" role="option" id="sug-${i}" aria-selected="false" data-text="${esc(s.text)}">
        <svg class="suggestion-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
        <span class="suggestion-text">${esc(s.text)}</span>
        <span class="suggestion-count">${mx(s.count)}</span>
      </div>`).join('');
  sugActiva = -1;
  box.classList.add('open');
  document.getElementById('searchInput').setAttribute('aria-expanded', 'true');
}

function sugMarcar(i) {
  const filas = [...sugBox().querySelectorAll('.suggestion-row')];
  if (!filas.length) return;
  sugActiva = (i + filas.length) % filas.length;
  filas.forEach((f, k) => f.setAttribute('aria-selected', k === sugActiva));
  document.getElementById('searchInput').setAttribute('aria-activedescendant', filas[sugActiva].id);
  filas[sugActiva].scrollIntoView({ block: 'nearest' });
}

function elegirSugerencia(texto) {
  clearTimeout(busquedaEspera);
  searchStreet = texto;
  F.q = '';
  document.getElementById('searchInput').value = '';
  document.getElementById('searchChipText').textContent = searchStreet;
  document.getElementById('searchChip').hidden = false;
  cerrarSug();
  page = 1; render();
}

// ── Export ───────────────────────────────────────────────────────────────────

function exportCSV() {
  // Lo arma el servidor con los filtros puestos. Hasta hoy salían las 70 de la página
  // visible —el botón decía «CSV» y no lo aclaraba— y el asesor lo mandaba al cliente
  // creyendo que iba el inventario filtrado. `API.descargar` ya sabe de 401 y de
  // errores con motivo, así que un fallo se dice en la página y no en un JSON.
  const qs = API.qs({ ...paramsBase(), orden: F.orden,
    estado: filterStatus !== 'Todos' ? Anuncio.estadoApi(filterStatus) : '' });
  toast(`Preparando el CSV de ${mx(totalFiltrado)} inmuebles…`);
  API.descargar(`/listings.csv${qs}`)
     .then(n => toast(`CSV listo: ${mx(n ?? totalFiltrado)} inmuebles`))
     .catch(err => toast('No se pudo exportar: ' + err.message));
}

// ── Barra fija de filtros ────────────────────────────────────────────────────
//
// Todos los filtros viven aquí, visibles sin abrir nada (R1-30; antes eran tres mecanismos:
// esta barra, una paleta ⌘K y un editor por token que filtraba con cada tecla). Lo que los
// define es el BORRADOR: lo que se toca dentro del popover no filtra hasta pulsar
// "Aplicar". Sin eso, marcar cuatro tipos dispara cuatro consultas contra 467k filas
// y la lista brinca bajo el dedo mientras se elige. Esc, un clic fuera o la ✕ del
// popover descartan el borrador; la ✕ del chip sí limpia de inmediato, porque quitar
// un filtro no necesita confirmarse. Mientras se edita, «Aplicar» dice cuántos
// resultados daría («Ver 1,204»).
//
// En el teléfono (≤900 px) los chips se esconden y un solo botón «Filtros (n)» abre la
// misma hoja inferior con todos juntos: la cabecera fija media el 44 % de la pantalla.

// «Ctrl K» en Windows y Linux, «⌘K» en Mac: el atajo que abre «Más filtros» se dice como se teclea.
const ATAJO = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? '') ? '⌘K' : 'Ctrl K';
document.getElementById('fbMasBtn').title = `Más filtros (${ATAJO})`;
const FB_CLAVES = ['ubicacion', 'operacion', 'precio', 'm2', 'tipo', 'carac', 'mas', ...(INMO ? ['cliente', 'asesor', 'etapa'] : [])];
if (INMO) document.querySelectorAll('.fb-chip[data-f="cliente"], .fb-chip[data-f="asesor"], .fb-chip[data-f="etapa"]').forEach(c => { c.hidden = false; });
const FB_TITULO = { ubicacion: 'Ubicación', operacion: 'Operación', precio: 'Precio', m2: 'Superficie', tipo: 'Tipo de inmueble',
                    carac: 'Características', mas: 'Más filtros', cliente: 'Presentada a', asesor: 'Presentó', etapa: 'Etapa',
                    todos: 'Filtros' };
const cap = s => String(s ?? '').charAt(0).toUpperCase() + String(s ?? '').slice(1);

let fbAbierto = null;     // cuál popover está abierto ('todos' es la hoja del teléfono), o null
let fbDraft = null;       // el borrador; se tira si no se aplica
let fbOrigen = null;      // lo que lo abrió: el foco vuelve ahí al cerrar
let fbPeticion = 0;       // descarta respuestas del autocompletado que llegan tarde
let fbEspera = 0;         // el temporizador de esa búsqueda: se lanza al dejar de teclear

// Sólo dígitos: el campo se escribe con separadores de miles en vivo.
const fbNum = v => {
  const n = Number(String(v ?? '').replace(/\D/g, ''));
  return Number.isFinite(n) && n > 0 ? n : '';
};

// Formatea para el campo sin confiar en lo que traiga el borrador: acepta número, el
// texto ya formateado, vacío o basura, y nunca devuelve "NaN".
const fbImporte = v => { const n = fbNum(v); return n ? mx(n) : ''; };
const kmTxt = m => `${(m / 1000).toFixed(1).replace(/\.0$/, '')} km`;

const fbResumen = {
  // Un solo chip para las dos formas de decir dónde: lugares elegidos, o un radio alrededor
  // de un punto («Monterrey · 10 km»). Elegir una quita la otra (R1-10).
  ubicacion: () => {
    if (F.lugares.length) return F.lugares.length === 1 ? F.lugares[0].nombre : `${F.lugares[0].nombre} +${F.lugares.length - 1}`;
    if (!F.near) return 'Todo México';
    const donde = F.nearTxt === CENTRO_NOMBRE ? CENTRO_NOMBRE : F.nearTxt ? 'Zona del mapa' : 'Un punto';
    return `${donde} · ${kmTxt(F.radio)}`;
  },
  operacion: () => ({ rent: 'Renta', sale: 'Venta' }[F.operacion] ?? 'Todas'),
  precio: () => (F.precio_min || F.precio_max) ? rango(F.precio_min, F.precio_max, v => `$${mx(v)}`) : 'Cualquiera',
  m2: () => (F.m2_min || F.m2_max)
    ? rango(F.m2_min, F.m2_max, v => `${mx(v)} m²`) + (M2_DE[F.m2_de] ? ` de ${M2_DE[F.m2_de]}` : '') : 'Cualquiera',
  tipo: () => !F.tipos.length ? 'Todos'
    : F.tipos.length === 1 ? cap(F.tipos[0]) + (F.tipos[0] === 'terreno' && F.usos.length
      ? ' ' + F.usos.map(u => USOS[u].toLowerCase()).join(' o ') : '')
    : `${F.tipos.length} tipos`,
  carac: () => {
    const f = caracDe().filter(([k]) => F.carac[k]).map(([k, nombre, ops]) => {
      const op = ops.find(([v]) => String(v) === String(F.carac[k]))?.[1] ?? F.carac[k];
      return op === 'Sí' ? nombre : `${nombre} ${op}`;
    });
    return !f.length ? 'Todas' : f.length === 1 ? f[0] : `${f[0]} +${f.length - 1}`;
  },
  mas: () => [F.fuente && Anuncio.fuente(F.fuente),
              (F.ppm_min || F.ppm_max) && rango(F.ppm_min, F.ppm_max, v => `$${mx(v)}/m²`)].filter(Boolean).join(' · ') || 'Ninguno',
  cliente: () => F.pcliente === 'sin' ? 'Sin cliente' : F.pcliente ? (clientesCache?.find(c => String(c.id) === F.pcliente)?.nombre ?? '1 cliente') : 'Todos',
  asesor: () => F.asesor ? (equipoCache?.find(u => String(u.id) === F.asesor)?.nombre ?? '1 persona') : 'Todos',
  etapa: () => !F.etapas.length ? 'Todas'
    : F.etapas.length === 1 ? etapaLabel(F.etapas[0]) : `${F.etapas.length} etapas`,
};

const fbPuesto = {
  ubicacion: () => F.lugares.length > 0 || !!F.near,
  operacion: () => !!F.operacion,
  precio: () => !!(F.precio_min || F.precio_max),
  m2: () => !!(F.m2_min || F.m2_max),
  tipo: () => F.tipos.length > 0,
  carac: () => Object.keys(caracPuesta()).length > 0,
  mas: () => !!(F.fuente || F.ppm_min || F.ppm_max),
  cliente: () => !!F.pcliente,
  asesor: () => !!F.asesor,
  etapa: () => F.etapas.length > 0,
};

function renderFB() {
  for (const k of FB_CLAVES) {
    document.getElementById(`fbv-${k}`).textContent = fbResumen[k]();
    const chip = document.querySelector(`.fb-chip[data-f="${k}"]`);
    // La ubicación de fábrica se ve, pero no se pinta como un filtro puesto por la persona.
    chip.classList.toggle('on', k === 'ubicacion' ? !ubicacionDeFabrica() : fbPuesto[k]());
    chip.querySelector('.fb-x').hidden = !fbPuesto[k]();
  }
  document.querySelector('.fb-chip[data-f="carac"]').hidden = !caracDe().length;
}

function fbCerrar(restaurar = false) {
  const origen = fbOrigen;
  fbAbierto = null; fbDraft = null; fbOrigen = null;
  clearTimeout(fbContarEspera); fbContarPeticion++;
  document.getElementById('fbPop').hidden = true;
  document.getElementById('fbScrim').hidden = true;
  document.querySelectorAll('.fb-open, #fbTodos').forEach(b => b.setAttribute('aria-expanded', 'false'));
  // Al cerrar con Esc, «Aplicar» o la ✕, el foco vuelve al botón que lo abrió; con un clic
  // fuera no se le quita a lo que la persona acaba de tocar.
  if (restaurar) origen?.focus();
}

const fbBorrador = () => ({
  lugares: F.lugares.slice(), tipos: F.tipos.slice(), usos: F.usos.slice(), carac: { ...F.carac },
  operacion: F.operacion, min: F.precio_min, max: F.precio_max,
  m2min: F.m2_min, m2max: F.m2_max, m2de: F.m2_de, ppmmin: F.ppm_min, ppmmax: F.ppm_max, fuente: F.fuente,
  pcliente: F.pcliente, etapas: F.etapas.slice(), asesor: F.asesor, orden: F.orden,
  // Ubicación: dos modos excluyentes. «Cerca de…» es el punto y radio que ya hay.
  modo: F.near && !F.lugares.length ? 'cerca' : 'lugares', near: F.near, nearTxt: F.nearTxt ?? '', radio: F.radio,
  sug: [],
});

function fbAbrir(k, origen) {
  if (fbAbierto === k) return fbCerrar(true);
  fbOrigen = origen ?? document.querySelector(`.fb-open[data-f="${k}"]`);
  fbAbierto = k;
  // Copia, no referencia: `lugares` y `tipos` se editan dentro del popover y tienen
  // que poder tirarse enteros al cancelar.
  fbDraft = fbBorrador();
  const pop = document.getElementById('fbPop');
  pop.dataset.f = k;
  pop.hidden = false;
  document.getElementById('fbScrim').hidden = false;
  document.querySelectorAll('.fb-open, #fbTodos').forEach(b => b.setAttribute('aria-expanded', 'false'));
  fbOrigen?.setAttribute('aria-expanded', 'true');
  fbPintarPop();
  // La hoja del teléfono no enfoca un campo: abriría el teclado antes de que se vea.
  (k === 'todos' ? pop.querySelector('.fb-close') : pop.querySelector('input:not([type=checkbox]):not([type=radio]):not([type=range]), select'))?.focus();
}

function fbCuerpoDe(k) {
  return { ubicacion: fbCuerpoUbicacion, operacion: fbCuerpoOperacion, precio: fbCuerpoPrecio, m2: fbCuerpoM2,
           tipo: fbCuerpoTipo, carac: fbCuerpoCarac, mas: fbCuerpoMas,
           cliente: fbCuerpoCliente, asesor: fbCuerpoAsesor, etapa: fbCuerpoEtapa }[k]();
}

// La hoja del teléfono: todos los filtros, uno bajo otro, más el orden y la vista.
function fbCuerpoTodos() {
  const sec = (titulo, html) => `<section class="fb-sec"><p class="fb-sub">${esc(titulo)}</p>${html}</section>`;
  const ks = FB_CLAVES.filter(k => k !== 'carac' || caracDe(fbDraft).length);
  const vista = inm.classList.contains('split') ? 'split' : 'grid';
  return ks.map(k => sec(FB_TITULO[k], fbCuerpoDe(k))).join('') +
    sec('Orden', `<select class="fb-in" data-d="orden" aria-label="Orden">${Object.entries(ORDENES).map(([v, l]) =>
      `<option value="${v}"${fbDraft.orden === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`) +
    sec('Vista', `<div class="fb-segs">${[['grid', 'Rejilla'], ['split', 'Rejilla + mapa']].map(([v, l]) =>
      `<button type="button" class="fb-seg${vista === v ? ' on' : ''}" data-vista="${v}" aria-pressed="${vista === v}">${l}</button>`).join('')}</div>`);
}

function fbPintarPop() {
  const k = fbAbierto;
  document.getElementById('fbPop').innerHTML = `
    <div class="fb-head">
      <span class="fb-title">${esc(FB_TITULO[k])}</span>
      <button class="fb-close" data-fb="cerrar" title="Cerrar" aria-label="Cerrar">&times;</button>
    </div>
    <div class="fb-cuerpo">${k === 'todos' ? fbCuerpoTodos() : fbCuerpoDe(k)}</div>
    <div class="fb-foot">
      <button class="fb-limpia" data-fb="limpia">Limpiar</button>
      <button class="fb-aplica" data-fb="aplica" id="fbAplica">Aplicar</button>
    </div>`;
  if (fbVeUbicacion() && fbDraft.modo === 'lugares') { fbPintarSeleccion(); fbPintarSugerencias(); }
  fbContar();
}
const fbVeUbicacion = () => fbAbierto === 'ubicacion' || fbAbierto === 'todos';

// Los filtros como quedarían si se aplicara el borrador: para contar antes de aplicar.
function fbComoF() {
  const d = fbDraft, n = k => fbNum(d[k]) || '';
  const cerca = d.modo === 'cerca' && d.near;
  return { ...F, lugares: cerca ? [] : d.lugares, tipos: d.tipos, usos: d.usos, carac: d.carac, operacion: d.operacion,
    precio_min: n('min'), precio_max: n('max'), m2_min: n('m2min'), m2_max: n('m2max'), m2_de: d.m2de,
    ppm_min: n('ppmmin'), ppm_max: n('ppmmax'), fuente: d.fuente,
    pcliente: d.pcliente, etapas: d.etapas, asesor: d.asesor,
    near: cerca ? d.near : '', radio: d.radio };
}

// «Aplicar» → «Ver 1,204». Se pregunta a /listings/facets cuando se deja de tocar (350 ms);
// si el borrador no cambió nada, no hay nada que contar.
let fbContarEspera = 0, fbContarPeticion = 0;
function fbContar() {
  clearTimeout(fbContarEspera);
  const mio = ++fbContarPeticion;
  const boton = () => document.getElementById('fbAplica');
  if (boton()) boton().textContent = 'Aplicar';
  if (!fbDraft) return;
  const params = paramsBase(fbComoF());
  if (JSON.stringify(params) === JSON.stringify(paramsBase())) return;
  fbContarEspera = setTimeout(async () => {
    let f = null;
    try { f = await API.get(`/listings/facets${API.qs(params)}`); } catch { return; }
    if (mio !== fbContarPeticion || !fbAbierto || !boton()) return;
    const n = filterStatus === 'Todos' ? f?.total : f?.por_estado?.[Anuncio.estadoApi(filterStatus)];
    if (Number.isFinite(n)) boton().textContent = `Ver ${mx(n)}`;
  }, 350);
}

// El input vive fuera de lo que se repinta: si se redibujara con cada tecla, el
// cursor se perdería a media palabra.
function fbCuerpoUbicacion() {
  const d = fbDraft;
  const modos = `<div class="fb-segs fb-modos" role="group" aria-label="Cómo buscar la ubicación">${[['lugares', 'Municipios y colonias'], ['cerca', 'Cerca de…']].map(([v, l]) =>
    `<button type="button" class="fb-seg${d.modo === v ? ' on' : ''}" data-modo="${v}" aria-pressed="${d.modo === v}">${l}</button>`).join('')}</div>`;
  if (d.modo === 'lugares') return modos + `
    <input class="fb-in" id="fbBuscaLugar" type="search" autocomplete="off" aria-label="Buscar municipio o colonia"
           placeholder="Municipio o colonia: Monterrey, Contry&#8230;">
    <div class="fb-sels" id="fbSels"></div>
    <div class="fb-sugs" id="fbSugs"></div>
    <p class="fb-nota" id="fbNota">Municipios y colonias.</p>`;
  const de = d.nearTxt === CENTRO_NOMBRE ? CENTRO_NOMBRE : d.nearTxt ? 'la zona que muestra el mapa' : 'el punto elegido';
  return modos + `
    <p class="fb-nota">Anuncios a menos de <b id="fbRadioTxt">${kmTxt(d.radio)}</b> de ${esc(de)}.</p>
    <input class="fb-rango-km" id="fbRadio" type="range" min="500" max="12000" step="500" value="${esc(d.radio)}" aria-label="Radio en kilómetros">
    <button type="button" class="fb-seg" data-centro="mapa">Usar el centro del mapa ahora</button>
    <p class="fb-nota">Para buscar cerca de otro lugar, mueve el mapa y pulsa el bot&#243;n.</p>`;
}

function fbPintarSeleccion() {
  const sels = document.getElementById('fbSels');
  if (!sels) return;
  sels.innerHTML = fbDraft.lugares.map((l, i) => `
    <span class="fb-sel">${esc(l.nombre)}<span class="fb-sel-e">${esc(l.contexto ?? '')}</span>
      <button class="fb-sel-x" data-quita="${i}" title="Quitar" aria-label="Quitar ${esc(l.nombre)}">&times;</button></span>`).join('');
  const tope = fbDraft.lugares.length >= MAX_LUGARES;
  document.getElementById('fbBuscaLugar').disabled = tope;
  document.getElementById('fbNota').textContent = tope
    ? `Máximo ${MAX_LUGARES} municipios a la vez.`
    : 'Municipios y colonias. Las colonias vienen de INEGI y no cubren todo el país.';
}

function fbPintarSugerencias() {
  const sugs = document.getElementById('fbSugs');
  if (!sugs) return;
  sugs.innerHTML = fbDraft.sug.map(s => `
    <button class="fb-sug" data-add="${esc(s.valor)}">${esc(s.nombre)}<span class="fb-sug-e">${esc(s.contexto ?? '')}</span>
      <span class="fb-sug-n">${mx(s.anuncios)}</span></button>`).join('');
}

async function fbBuscarLugares(q) {
  const mio = ++fbPeticion;
  if (q.length < 2) { fbDraft.sug = []; return fbPintarSugerencias(); }
  let r = [];
  try { r = await API.get(`/lugares${API.qs({ q })}`); } catch { r = []; }
  // Una respuesta vieja que llega tarde no puede pisar a una nueva.
  if (mio !== fbPeticion || !fbAbierto || !fbVeUbicacion()) return;
  const ya = new Set(fbDraft.lugares.map(l => l.valor));
  fbDraft.sug = r.filter(s => !ya.has(s.valor));
  fbPintarSugerencias();
}

// El punto y radio de lo que el mapa enseña ahora, o el área de fábrica si no hay mapa.
function fbPuntoDelMapa() {
  const real = Mapa.area(), a = real ?? areaInicial();
  return { near: `${a.lat.toFixed(5)}, ${a.lng.toFixed(5)}`, nearTxt: real ? MAPA_TXT : CENTRO_NOMBRE, radio: a.radio };
}

// Dos campos de número con miles en vivo; `dMin` y `dMax` son las llaves del borrador.
const fbRango = (dMin, dMax, etMin, etMax, phMin, phMax) => `
    <div class="fb-rango">
      <input class="fb-in fb-num" data-d="${dMin}" inputmode="numeric" placeholder="${phMin}" aria-label="${etMin}"
             value="${esc(fbImporte(fbDraft[dMin]))}">
      <span class="fb-guion">&mdash;</span>
      <input class="fb-in fb-num" data-d="${dMax}" inputmode="numeric" placeholder="${phMax}" aria-label="${etMax}"
             value="${esc(fbImporte(fbDraft[dMax]))}">
    </div>`;

function fbCuerpoOperacion() {
  const seg = [['rent', 'Renta'], ['sale', 'Venta']].map(([v, l]) =>
    `<button type="button" class="fb-seg${fbDraft.operacion === v ? ' on' : ''}" data-op="${esc(v)}" aria-pressed="${fbDraft.operacion === v}">${esc(l)}</button>`).join('');
  return `<div class="fb-segs">${seg}</div>
    <p class="fb-nota">Un inmueble en renta y venta aparece en las dos. Tocar la operaci&#243;n activa la quita.</p>`;
}

function fbCuerpoPrecio() {
  return fbRango('min', 'max', 'Precio mínimo', 'Precio máximo', 'M&#237;nimo', 'M&#225;ximo') + `
    <p class="fb-nota">Pesos, total del inmueble. Lo que el portal publica por m&#178; ya sale
      multiplicado por su superficie.</p>`;
}

function fbCuerpoM2() {
  return fbRango('m2min', 'm2max', 'Superficie mínima', 'Superficie máxima', 'M&#237;n m&#178;', 'M&#225;x m&#178;') + `
    <select class="fb-in" data-d="m2de" aria-label="De qué superficie">
      <option value="">Cualquier superficie</option>
      <option value="terreno"${fbDraft.m2de === 'terreno' ? ' selected' : ''}>S&#243;lo terreno</option>
      <option value="construccion"${fbDraft.m2de === 'construccion' ? ' selected' : ''}>S&#243;lo construcci&#243;n</option>
    </select>`;
}

// Lo que se usa poco: el portal de origen y el precio por m².
function fbCuerpoMas() {
  const fuentes = [...new Set([...Object.keys(facetas.por_fuente), fbDraft.fuente].filter(Boolean))].sort();
  return `<p class="fb-sub">Fuente</p><div class="fb-fila-ops">` + (fuentes.length ? fuentes.map(f => {
      const on = fbDraft.fuente === f;
      return `<button type="button" class="pill-line${on ? ' active' : ''}" data-fuente="${esc(f)}" aria-pressed="${on}">${esc(Anuncio.fuente(f))}` +
        (facetas.por_fuente[f] != null ? ` <span class="pill-n">${mx(facetas.por_fuente[f])}</span>` : '') + `</button>`;
    }).join('') : '<span class="fb-nota">Sin fuentes con estos filtros.</span>') + `</div>
    <p class="fb-sub">Precio por m&#178;</p>` +
    fbRango('ppmmin', 'ppmmax', 'Precio por m² mínimo', 'Precio por m² máximo', 'M&#237;n $/m&#178;', 'M&#225;x $/m&#178;');
}

// Uso de un terreno: lo deduce la API del título o del tipo del portal, así que no
// todos lo tienen («Sin clasificar»). Sólo se ofrece con Terreno marcado.
const USOS = { habitacional: 'Habitacional', comercial: 'Comercial', industrial: 'Industrial', sin: 'Sin clasificar' };
// Lo que importa de cada tipo, con los mismos datos que enseña su tarjeta (POR_TIPO en
// api/atributos.py). Sale de `anuncio_atributo`: el portal o la descripción.
const CAJONES = ['cajones_min', 'Cajones', [[2, '2+'], [5, '5+'], [10, '10+']]];
// Estos dos los lee una IA en la descripción (`anuncio_ia`, sólo Nuevo León por ahora). La
// esquina no se ofrece en oficinas: ahí casi siempre es la esquina de un piso, no de la calle.
// Drive-thru espera: la primera pasada no encontró ninguno que lo fuera.
const ESQUINA = ['esquina', 'Esquina', [[1, 'Sí']]];
const AVENIDA = ['sobre_avenida', 'Sobre avenida', [[1, 'Sí']]];
const CARACS = {
  bodega: [['altura_min', 'Altura', [[6, '6 m+'], [8, '8 m+'], [10, '10 m+'], [12, '12 m+']]],
           ['andenes_min', 'Andenes', [[1, 'Con andén'], [2, '2+'], [4, '4+']]], CAJONES, ESQUINA, AVENIDA],
  local: [CAJONES, ['banos_min', 'Baños', [[1, '1+'], [2, '2+'], [3, '3+']]],
          ['frente_min', 'Frente', [[10, '10 m+'], [20, '20 m+']]], ESQUINA, AVENIDA],
  oficina: [CAJONES, ['banos_min', 'Baños', [[2, '2+'], [3, '3+']]], ['elevador', 'Elevador', [[1, 'Sí']]], AVENIDA],
  terreno: [['frente_min', 'Frente', [[10, '10 m+'], [20, '20 m+'], [30, '30 m+']]], ESQUINA, AVENIDA],
};
// `G` es F o un borrador: los dos traen `tipos` y `carac`.
const caracDe = (G = F) => G.tipos.length === 1 ? CARACS[G.tipos[0]] ?? [] : [];
// Sólo lo que aplica al tipo elegido: al cambiar de tipo, lo del anterior deja de contar.
const caracPuesta = (G = F) => Object.fromEntries(caracDe(G).filter(([k]) => G.carac[k]).map(([k]) => [k, G.carac[k]]));

function fbCuerpoCarac() {
  return caracDe(fbDraft).map(([k, nombre, ops]) => `
    <div class="fb-fila"><span class="fb-fila-k">${nombre}</span><div class="fb-fila-ops">` + ops.map(([v, t]) => {
      const on = String(fbDraft.carac[k] ?? '') === String(v);
      return `<button type="button" class="pill-line${on ? ' active' : ''}" data-carac="${k}" data-valor="${v}" aria-pressed="${on}">${t}</button>`;
    }).join('') + `</div></div>`).join('') + `
    <p class="fb-nota">Sale de lo que publica el portal y de la descripción. Esquina y sobre avenida los lee una IA en la descripción, por ahora sólo en Nuevo León. Un anuncio que no dice el dato queda fuera.</p>`;
}

function fbCuerpoTipo() {
  const cajas = '<div class="fb-cajas">' + TIPOS_COM.map(v => `
    <label class="fb-caja">
      <input type="checkbox" data-tipo="${esc(v)}"${fbDraft.tipos.includes(v) ? ' checked' : ''}>
      <span>${esc(cap(v))}</span>
    </label>`).join('') + '</div>';
  if (!fbDraft.tipos.includes('terreno')) return cajas;
  return cajas + `<p class="fb-sub">Uso del terreno</p><div class="fb-cajas">` + Object.entries(USOS).map(([v, t]) => `
    <label class="fb-caja">
      <input type="checkbox" data-uso="${v}"${fbDraft.usos.includes(v) ? ' checked' : ''}>
      <span>${t}</span>
    </label>`).join('') + `</div>
    <p class="fb-nota">Sale del título del anuncio: el que no lo dice queda sin clasificar. Sin marcar ninguno, todos los terrenos.</p>`;
}

// Catálogo: un cliente a la vez (la pregunta es "¿qué le hemos presentado a X?")
// y varias etapas, con las mismas casillas que Tipo.
function fbCuerpoCliente() {
  const cs = clientesCache ?? [];
  if (!clientesCache) return '<p class="fb-nota">Cargando clientes&#8230;</p>';
  const fijos = [{ id: '', nombre: 'Todos los clientes' }, { id: 'sin', nombre: 'Sin cliente asignado' }];
  return '<div class="fb-cajas fb-cajas-lista">' + [...fijos, ...cs].map(c => `
    <label class="fb-caja">
      <input type="radio" name="fbCliente" data-pcliente="${esc(c.id)}"${String(fbDraft.pcliente) === String(c.id) ? ' checked' : ''}>
      <span>${esc(c.nombre)}</span>
    </label>`).join('') + '</div>';
}
// Las propiedades que presentó una persona, con el cliente que sea (`proceso.trae_id`: la
// columna «Presentó» de la tabla de cada cliente). Se combina con Cliente y Etapa.
let equipoCache = null;
async function cargarEquipo() {
  if (!equipoCache) equipoCache = await API.get('/equipo').catch(() => []);
  return equipoCache;
}
function fbCuerpoAsesor() {
  if (!equipoCache) return '<p class="fb-nota">Cargando&#8230;</p>';
  return '<div class="fb-cajas fb-cajas-lista">' + [{ id: '', nombre: 'Cualquiera' }, ...equipoCache].map(u => `
    <label class="fb-caja">
      <input type="radio" name="fbAsesor" data-asesor="${esc(u.id)}"${String(fbDraft.asesor) === String(u.id) ? ' checked' : ''}>
      <span>${esc(u.nombre || u.email)}</span>
    </label>`).join('') + '</div>';
}
function fbCuerpoEtapa() {
  return '<div class="fb-cajas">' + ETAPAS.map(e => `
    <label class="fb-caja">
      <input type="checkbox" data-etapa="${esc(e.key)}"${fbDraft.etapas.includes(e.key) ? ' checked' : ''}>
      <span>${esc(e.label)}</span>
    </label>`).join('') + '</div>';
}

// Los filtros que toca el popover abierto: uno, o todos en la hoja del teléfono.
const fbAfectados = () => fbAbierto === 'todos' ? FB_CLAVES : [fbAbierto];

function fbLimpiarBorrador() {
  const d = fbDraft;
  for (const k of fbAfectados()) {
    if (k === 'cliente') d.pcliente = '';
    if (k === 'asesor') d.asesor = '';
    if (k === 'etapa') d.etapas = [];
    if (k === 'ubicacion') { d.lugares = []; d.sug = []; d.near = ''; d.nearTxt = ''; d.modo = 'lugares'; }
    if (k === 'tipo') { d.tipos = []; d.usos = []; }
    if (k === 'carac') d.carac = {};
    if (k === 'operacion') d.operacion = '';
    if (k === 'precio') { d.min = ''; d.max = ''; }
    if (k === 'm2') { d.m2min = ''; d.m2max = ''; d.m2de = ''; }
    if (k === 'mas') { d.fuente = ''; d.ppmmin = ''; d.ppmmax = ''; }
  }
  if (fbAbierto === 'todos') d.orden = 'recientes';
  fbPintarPop();
}

// Un mínimo mayor que el máximo no devuelve nada nunca. Voltearlos es lo que
// la persona quiso decir, y decírselo con una pantalla vacía sería peor.
function fbMinMax(a, b) {
  let min = fbNum(a), max = fbNum(b);
  if (min && max && min > max) [min, max] = [max, min];
  return [min || '', max || ''];
}

function fbAplicar() {
  const ks = fbAfectados(), d = fbDraft;
  if (ks.includes('cliente')) {
    F.pcliente = d.pcliente;
    // Sin cliente no hay proceso, y sin proceso no hay etapa: las dos juntas no
    // devolverían nada nunca.
    if (F.pcliente === 'sin') { F.etapas = []; F.asesor = ''; }
  }
  if (ks.includes('etapa') && d.etapas.length && F.pcliente === 'sin') F.pcliente = '';
  if (ks.includes('etapa')) F.etapas = d.etapas.slice();
  if (ks.includes('asesor')) {
    F.asesor = d.asesor;
    // Sin cliente no hay proceso, y sin proceso nadie la presentó.
    if (F.asesor && F.pcliente === 'sin') F.pcliente = '';
  }
  if (ks.includes('ubicacion')) {
    if (d.modo === 'cerca' && d.near) {
      const cambio = d.near !== F.near || Number(d.radio) !== Number(F.radio);
      F.lugares = []; F.near = d.near; F.nearTxt = d.nearTxt; F.radio = Number(d.radio);
      // Un punto o un radio elegidos aquí son fijos: si el mapa siguiera, su próximo
      // movimiento los pisaría.
      if (cambio) seguirMapa(false);
    } else {
      F.lugares = d.lugares.slice(0, MAX_LUGARES); F.near = ''; F.nearTxt = '';
      seguirMapa(false);      // con lugares elegidos, el mapa ya no decide dónde se busca
    }
  }
  if (ks.includes('tipo')) { F.tipos = d.tipos.slice(); F.usos = F.tipos.includes('terreno') ? d.usos.slice() : []; }
  if (ks.includes('carac')) F.carac = { ...d.carac };
  if (ks.includes('operacion')) F.operacion = d.operacion;
  if (ks.includes('precio')) [F.precio_min, F.precio_max] = fbMinMax(d.min, d.max);
  if (ks.includes('m2')) { [F.m2_min, F.m2_max] = fbMinMax(d.m2min, d.m2max); F.m2_de = d.m2de; }
  if (ks.includes('mas')) { F.fuente = d.fuente; [F.ppm_min, F.ppm_max] = fbMinMax(d.ppmmin, d.ppmmax); }
  if (fbAbierto === 'todos') F.orden = d.orden;
  fbCerrar(true); page = 1; render();
}

function fbQuitar(k) {
  // Un solo chip de ubicación: la ✕ quita lo que diga, sean lugares o el radio.
  if (k === 'ubicacion') { F.lugares = []; F.near = ''; F.nearTxt = ''; seguirMapa(false); }
  if (k === 'tipo') { F.tipos = []; F.usos = []; F.carac = {}; }
  if (k === 'carac') F.carac = {};
  if (k === 'cliente') F.pcliente = '';
  if (k === 'etapa') F.etapas = [];
  if (k === 'asesor') F.asesor = '';
  if (k === 'operacion') F.operacion = '';
  if (k === 'precio') { F.precio_min = ''; F.precio_max = ''; }
  if (k === 'm2') { F.m2_min = ''; F.m2_max = ''; F.m2_de = ''; }
  if (k === 'mas') { F.fuente = ''; F.ppm_min = ''; F.ppm_max = ''; }
  if (fbAbierto === k || fbAbierto === 'todos') fbCerrar();
  // El botón ✕ se esconde al quitar: el foco pasa al chip, no se pierde.
  document.querySelector(`.fb-open[data-f="${k}"]`)?.focus();
  page = 1; render();
}

document.getElementById('fb').addEventListener('click', e => {
  const x = e.target.closest('.fb-x');
  if (x) return fbQuitar(x.dataset.x);
  const abre = e.target.closest('.fb-open');
  if (abre) return fbAbrir(abre.dataset.f, abre);
});
document.getElementById('fbTodos').addEventListener('click', e => fbAbrir('todos', e.currentTarget));

document.getElementById('fbPop').addEventListener('click', e => {
  const acc = e.target.closest('[data-fb]')?.dataset.fb;
  if (acc === 'cerrar') return fbCerrar(true);
  if (acc === 'limpia') return fbLimpiarBorrador();
  if (acc === 'aplica') return fbAplicar();

  const car = e.target.closest('[data-carac]');
  if (car) {
    // Tocar la opción activa la quita, como la operación.
    const { carac: k, valor } = car.dataset;
    if (fbDraft.carac[k] === valor) delete fbDraft.carac[k]; else fbDraft.carac[k] = valor;
    return fbPintarPop();
  }
  const add = e.target.closest('.fb-sug');
  if (add) {
    const s = fbDraft.sug.find(x => x.valor === add.dataset.add);
    if (s && fbDraft.lugares.length < MAX_LUGARES) {
      fbDraft.lugares.push({ valor: s.valor, nombre: s.nombre, contexto: s.contexto });
      fbDraft.sug = fbDraft.sug.filter(x => x.valor !== s.valor);
      document.getElementById('fbBuscaLugar').value = '';
      fbPintarSeleccion(); fbPintarSugerencias(); fbContar();
    }
    return;
  }
  const quita = e.target.closest('.fb-sel-x');
  if (quita) {
    fbDraft.lugares.splice(Number(quita.dataset.quita), 1);
    fbPintarSeleccion(); return fbContar();
  }
  const modo = e.target.closest('[data-modo]');
  if (modo) {
    // Elegir un modo quita el otro al aplicar: «Cerca de…» parte de lo que el mapa enseña.
    fbDraft.modo = modo.dataset.modo;
    if (fbDraft.modo === 'cerca' && !fbDraft.near) Object.assign(fbDraft, fbPuntoDelMapa());
    return fbPintarPop();
  }
  if (e.target.closest('[data-centro]')) {
    Object.assign(fbDraft, fbPuntoDelMapa());
    return fbPintarPop();
  }
  const op = e.target.closest('[data-op]');
  if (op) {
    // Tocar la operación activa la quita: es la forma más corta de volver a "las dos".
    fbDraft.operacion = fbDraft.operacion === op.dataset.op ? '' : op.dataset.op;
    return fbPintarPop();
  }
  const fu = e.target.closest('[data-fuente]');
  if (fu) {
    fbDraft.fuente = fbDraft.fuente === fu.dataset.fuente ? '' : fu.dataset.fuente;
    return fbPintarPop();
  }
  const vista = e.target.closest('[data-vista]');
  if (vista) { ponerVista(vista.dataset.vista); return fbPintarPop(); }   // la vista no es un filtro: se aplica ya
});

document.getElementById('fbPop').addEventListener('input', e => {
  // Se pregunta cuando se deja de teclear, no en cada letra: "monterrey" eran nueve
  // consultas y las respuestas viejas, que se descartan, igual ocupaban la base.
  if (e.target.id === 'fbBuscaLugar') {
    clearTimeout(fbEspera);
    const q = e.target.value.trim();
    fbEspera = setTimeout(() => fbBuscarLugares(q), 200);
    return;
  }
  if (e.target.id === 'fbRadio') {
    fbDraft.radio = Number(e.target.value);
    document.getElementById('fbRadioTxt').textContent = kmTxt(fbDraft.radio);
    return fbContar();
  }
  if (e.target.matches('input.fb-num[data-d]')) {
    // Miles en vivo. El cursor va al final a propósito: reponerlo donde estaba
    // exige contar separadores y aquí se escribe de izquierda a derecha.
    const n = fbNum(e.target.value);
    e.target.value = n ? mx(n) : '';
    fbDraft[e.target.dataset.d] = n;
    fbContar();
  }
});

document.getElementById('fbPop').addEventListener('change', e => {
  if (e.target.matches('select[data-d]')) { fbDraft[e.target.dataset.d] = e.target.value; return fbContar(); }
  if (e.target.matches('[data-pcliente]')) { fbDraft.pcliente = e.target.dataset.pcliente; return fbContar(); }
  if (e.target.matches('[data-asesor]')) { fbDraft.asesor = e.target.dataset.asesor; return fbContar(); }
  if (e.target.matches('[data-etapa]')) {
    const v = e.target.dataset.etapa;
    fbDraft.etapas = e.target.checked ? [...new Set([...fbDraft.etapas, v])] : fbDraft.etapas.filter(x => x !== v);
    return fbContar();
  }
  const u = e.target.closest('input[type=checkbox][data-uso]');
  if (u) {
    fbDraft.usos = u.checked ? [...new Set([...fbDraft.usos, u.dataset.uso])] : fbDraft.usos.filter(x => x !== u.dataset.uso);
    return fbContar();
  }
  const c = e.target.closest('input[type=checkbox][data-tipo]');
  if (!c) return;
  const v = c.dataset.tipo;
  fbDraft.tipos = c.checked ? [...new Set([...fbDraft.tipos, v])] : fbDraft.tipos.filter(x => x !== v);
  // Aparece o se va «Uso del terreno», y en la hoja del teléfono también las características.
  if (v === 'terreno' || fbAbierto === 'todos') {
    fbPintarPop();
    document.querySelector(`#fbPop [data-tipo="${v}"]`)?.focus();
  } else fbContar();
});

// Enter aplica, Esc descarta: el popover se maneja sin ratón. Enter sobre un botón o un
// select hace lo suyo (alternar, abrir): sólo aplica desde un campo o una casilla.
document.getElementById('fbPop').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id !== 'fbBuscaLugar' && !e.target.closest('button, select, textarea')) {
    e.preventDefault(); fbAplicar();
  }
});
document.getElementById('fbScrim').addEventListener('click', () => fbCerrar(true));
// `pointerdown` y no `click`, y no es un detalle: elegir una sugerencia repinta la
// lista, así que para cuando el `click` llega a `document` el elemento clicado ya no
// está en el árbol y `closest('#fbPop')` devuelve null. El popover se cerraba solo al
// elegir un municipio. Al bajar el dedo el elemento todavía está donde debe.
document.addEventListener('pointerdown', e => {
  if (fbAbierto && !e.target.closest('#fbPop, #fb, #fbTodos')) fbCerrar();
});

// ── Eventos ──────────────────────────────────────────────────────────────────

document.getElementById('qbar').addEventListener('click', e => {
  if (e.target.closest('.tok-del')) { quitarCriterios(); fbCerrar(); page = 1; return render(); }
  if (e.target.closest('.tok-edit') && F.cliente) { location.href = `clientes.html#${encodeURIComponent(F.cliente.id)}`; return; }
  if (e.target.closest('#qbar-clear')) return limpiarTodo();
});

document.getElementById('statebar').addEventListener('click', e => {
  if (e.target.closest('#export-btn')) return exportCSV();
  const pill = e.target.closest('.pill');
  if (!pill) return;
  if (pill.dataset.group === 'starred') filterStarred = !filterStarred;
  else if (pill.dataset.group === 'status') filterStatus = pill.dataset.val;
  page = 1; render();
});
document.getElementById('estadoSel').addEventListener('change', e => { filterStatus = e.target.value; page = 1; render(); });

// «⋯» (sólo en el teléfono): CSV y «Nueva propiedad» no caben en la fila de estado.
const masBtn = document.getElementById('masBtn'), masMenu = document.getElementById('masMenu');
document.getElementById('masNueva').hidden = !INMO;
function masAbrir(v, restaurar = false) {
  masMenu.hidden = !v;
  masBtn.setAttribute('aria-expanded', String(v));
  if (v) masMenu.querySelector('button:not([hidden])')?.focus();
  else if (restaurar) masBtn.focus();
}
masBtn.addEventListener('click', () => masAbrir(masMenu.hidden));
masMenu.addEventListener('click', e => {
  const it = e.target.closest('button');
  if (!it) return;
  masAbrir(false, true);
  if (it.id === 'masCsv') exportCSV();
  if (it.id === 'masNueva') document.getElementById('nueva-prop').click();
});
document.addEventListener('pointerdown', e => { if (!masMenu.hidden && !e.target.closest('#masMenu, #masBtn')) masAbrir(false); });

document.getElementById('grid').addEventListener('click', e => {
  const card = e.target.closest('.card');
  if (!card) return;
  const id = card.dataset.id;
  if (e.target.closest('.btn-star')) return setState(id, { starred: !listingsMap[id].starred });
  if (e.target.closest('.card-chk')) return toggleSeleccion(id);
  // Los enlaces (el título extendido a toda la tarjeta) y los controles hacen lo suyo.
  if (e.target.closest('select, a, button, label')) return;
  // Arrastrar para copiar una dirección o un precio no debe abrir la ficha al soltar.
  if (String(getSelection()).trim()) return;
  // La ficha abre en otra pestaña: la búsqueda se queda donde estaba en ésta.
  window.open(`listing.html?id=${encodeURIComponent(id)}`, '_blank');
});

// Hover tarjeta → pin. mouseover burbujea; se ignoran los movimientos internos. El foco del
// teclado resalta igual que el ratón.
let hoverId = null;
const grid = document.getElementById('grid');
grid.addEventListener('mouseover', e => {
  const id = e.target.closest('.card')?.dataset.id ?? null;
  if (id !== hoverId) { hoverId = id; Mapa.resaltar(id); }
});
grid.addEventListener('mouseleave', () => { hoverId = null; Mapa.resaltar(null); });
grid.addEventListener('focusin', e => Mapa.resaltar(e.target.closest('.card')?.dataset.id ?? null));
grid.addEventListener('focusout', () => Mapa.resaltar(hoverId));

grid.addEventListener('change', e => {
  const sel = e.target.closest('.status-select');
  if (!sel) return;
  setState(sel.closest('.card').dataset.id, { status: sel.value });
});

const searchInput = document.getElementById('searchInput');
// La tecla «/» no existe en el teléfono: ahí el placeholder no la anuncia.
if (matchMedia('(pointer: coarse)').matches) searchInput.placeholder = 'Dirección, título o código…';
// Se busca cuando se deja de teclear: cada búsqueda son tres consultas a la base.
let busquedaEspera = 0;
searchInput.addEventListener('input', e => {
  clearTimeout(busquedaEspera);
  const q = e.target.value.trim();
  busquedaEspera = setTimeout(() => { F.q = q; page = 1; renderSuggestions(F.q); render(); }, 250);
});
searchInput.addEventListener('blur', () => { setTimeout(cerrarSug, 150); });
searchInput.addEventListener('keydown', e => {
  const abierta = sugBox().classList.contains('open');
  if (e.key === 'ArrowDown' && abierta) { e.preventDefault(); sugMarcar(sugActiva + 1); }
  else if (e.key === 'ArrowUp' && abierta) { e.preventDefault(); sugMarcar(sugActiva - 1); }
  else if (e.key === 'Enter' && abierta && sugActiva >= 0) {
    e.preventDefault();
    elegirSugerencia(sugBox().querySelectorAll('.suggestion-row')[sugActiva].dataset.text);
  } else if (e.key === 'Escape' && abierta) { e.preventDefault(); cerrarSug(); }
});
sugBox().addEventListener('mousedown', e => {
  const row = e.target.closest('.suggestion-row');
  if (!row) return;
  e.preventDefault();
  elegirSugerencia(row.dataset.text);
});
document.getElementById('searchChipClose').addEventListener('click', () => {
  searchStreet = '';
  document.getElementById('searchChip').hidden = true;
  page = 1; render();
  searchInput.focus();
});

// Un solo manejador de Esc, en orden: lo que está más arriba se cierra primero, y vaciar la
// selección es lo último. Antes un Esc que cerraba un popover vaciaba también la selección,
// y uno que cerraba un diálogo también (R1-12).
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); fbAbrir('mas'); return; }
  if (e.key === '/' && !e.target.closest('input, textarea, select') && !document.querySelector('dialog[open]')) { e.preventDefault(); searchInput.focus(); return; }
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (document.querySelector('dialog[open]')) return;
  if (fbAbierto) return fbCerrar(true);
  if (!masMenu.hidden) return masAbrir(false, true);
  if (sugBox().classList.contains('open')) return cerrarSug();
  if (seleccion.size && !e.target.closest('input, textarea, select')) limpiarSeleccion();
});

// ── Vista: rejilla sola o rejilla + mapa ─────────────────────────────────────

const inm = document.getElementById('inm');
// En el teléfono el mapa se dibujaba primero y empujaba la primera tarjeta a y=587 de
// 780, y a 1280 dejaba tarjetas de 219 px: hasta 1366 se abre en rejilla y el mapa
// queda detrás de «+ mapa». La preferencia se guarda aparte por tamaño, para que la
// de un monitor grande no decida la de la laptop.
const CHICO = matchMedia('(max-width: 1366px)').matches;
const VISTA_KEY = matchMedia('(max-width: 900px)').matches ? 'ol-vista-movil' : CHICO ? 'ol-vista-media' : 'ol-vista';
function ponerVista(v) {
  inm.classList.toggle('split', v === 'split');
  inm.classList.toggle('grid-only', v !== 'split');
  document.querySelectorAll('.seg [data-vista]').forEach(b => b.classList.toggle('on', b.dataset.vista === v));
  try { localStorage.setItem(VISTA_KEY, v); } catch { /* sin persistencia */ }
  requestAnimationFrame(() => Mapa.resize());
}
document.querySelector('.seg').addEventListener('click', e => {
  const b = e.target.closest('[data-vista]');
  if (b) ponerVista(b.dataset.vista);
});
// El mapa ya no depende de una llave (mapa.js): en un monitor grande la vista por
// defecto es rejilla + mapa; hasta 1366 px, rejilla.
ponerVista((() => { try { return localStorage.getItem(VISTA_KEY); } catch { return null; } })() ?? (CHICO ? 'grid' : 'split'));

Mapa.init(document.getElementById('map'), {
  operacion: () => F.operacion,
  onPin: id => {
    const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    const list = document.getElementById('inmList');
    list.scrollTo({ top: card.offsetTop - 12, behavior: 'smooth' });
    card.classList.add('on');
    setTimeout(() => card.classList.remove('on'), 1600);
  },
  onPinHover: id => document.querySelectorAll('.card').forEach(c => c.classList.toggle('on', c.dataset.id === id)),
  // Mover el mapa es buscar «lo que se ve»: reemplaza a los lugares elegidos (los dos
  // modos de ubicación son excluyentes).
  onMove: a => { F.lugares = []; buscarEnElMapa(a); page = 1; render(); },
});
// El área de fábrica: el centro de `config.js` y un radio fijo en metros. Existe para que
// la Bolsa de partida no dependa del tamaño de la ventana.
function areaInicial() {
  const cfg = window.OL_CONFIG ?? {};
  const [lng, lat] = cfg.centro ?? [-100.36, 25.66];
  return { lat, lng, radio: cfg.radioInicial ?? 10000 };
}
// Lo que el mapa enseña se vuelve el filtro de cercanía. `de` es cómo se le dice a ese
// punto: al abrir es la vista de fábrica y tiene nombre; después de moverlo, ya no.
function buscarEnElMapa({ lat, lng, radio }, de = MAPA_TXT) {
  F.near = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  F.nearTxt = de;
  F.radio = radio;
}
// "Buscar al mover el mapa" viene marcado, y el mapa abre en Monterrey
// (OL_CONFIG.centro): la Bolsa arranca con lo que hay ahí y no con el inventario
// nacional. Quien lo apague lo encuentra apagado la próxima vez. Sólo en la Bolsa: las
// propiedades del Catálogo casi nunca traen coordenada y buscar por cercanía las
// escondería.
const mapFollow = document.getElementById('mapFollow');
function seguirMapa(v) { mapFollow.checked = v; Mapa.seguir(v); }
const seguirPreferido = () => !INMO && (() => { try { return localStorage.getItem('ol-mapa-seguir'); } catch { return null; } })() !== 'no';
seguirMapa(seguirPreferido());
mapFollow.addEventListener('change', e => {
  Mapa.seguir(e.target.checked);
  if (!INMO) try { localStorage.setItem('ol-mapa-seguir', e.target.checked ? 'si' : 'no'); } catch { /* sin persistencia */ }
  // Marcarlo es buscar lo que el mapa enseña ya, y quita los lugares elegidos: municipios y
  // «lo que se ve» son dos modos excluyentes. Antes los dos viajaban en la misma consulta y
  // «García» con el radio de Monterrey daba cero resultados.
  if (e.target.checked) {
    const a = Mapa.area();
    if (a) { F.lugares = []; buscarEnElMapa(a); page = 1; render(); }
  }
});

// ── Selección, bandeja y acciones en lote ────────────────────────────────────

// La casilla y el borde de una tarjeta, según esté o no en la selección.
function pintarSel(id) {
  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  const on = seleccion.has(id);
  card.classList.toggle('sel', on);
  const chk = card.querySelector('.card-chk');
  chk.innerHTML = on ? '&#10003;' : '';
  chk.setAttribute('aria-pressed', on);
}

// «+ Agregar desde el tablero» en Comparar: los que ya se comparaban vuelven a la bandeja,
// para sumar uno más sin volver a marcarlos. Comparar deja la lista en `ol-comparar` y la
// marca `ol-comparar-agregar`; sin la marca no se toca la selección (volver de Comparar
// con «Volver» no tiene por qué reabrir la bandeja).
async function recuperarComparacion() {
  let ids = [];
  try {
    if (sessionStorage.getItem('ol-comparar-agregar') !== '1') return;
    sessionStorage.removeItem('ol-comparar-agregar');
    ids = JSON.parse(sessionStorage.getItem('ol-comparar') ?? '[]');
  } catch { return; }
  if (!Array.isArray(ids) || !ids.length) return;
  const res = await Promise.allSettled(ids.map(id =>
    listingsMap[id] ? Promise.resolve(listingsMap[id])
      : API.get(`/listings/${encodeURIComponent(id)}`).then(Anuncio.de)));
  res.forEach((r, i) => { if (r.status === 'fulfilled' && r.value) seleccion.set(String(ids[i]), r.value); });
  ids.forEach(id => pintarSel(String(id)));
  renderTray();
}

function toggleSeleccion(id) {
  if (seleccion.has(id)) seleccion.delete(id);
  else if (listingsMap[id]) seleccion.set(id, listingsMap[id]);
  pintarSel(id);
  renderTray();
}

// Vaciar la selección no vuelve a pedir la lista: sólo repinta las casillas.
function limpiarSeleccion() {
  const ids = [...seleccion.keys()];
  seleccion.clear();
  ids.forEach(pintarSel);
  renderTray();
}

function renderTray() {
  const tray = document.getElementById('tray');
  const n = seleccion.size;
  tray.hidden = !n;
  document.body.classList.toggle('has-tray', n > 0);
  inm.classList.toggle('selecting', n > 0);
  if (!n) return;
  document.getElementById('trayCount').textContent = n === 1 ? '1 seleccionada' : `${n} seleccionadas`;
  const items = [...seleccion.values()];
  document.getElementById('trayItems').innerHTML = items.slice(0, MAX_COMPARAR).map(l => {
    const p = fmtPrice(l);
    return `<span class="tray-item" data-id="${esc(l.id)}">
      ${l.fotos?.[0] ? `<img src="${esc(l.fotos[0])}" alt="">` : '<span class="tray-thumb"></span>'}
      <span class="tray-txt"><b>${p ? '$' + p.n : 'Sin precio'}</b><small>${l.size ? mx(Math.round(l.size)) + ' m² · ' : ''}${esc(Anuncio.ubicacion(l) ?? '')}</small></span>
      <button class="tray-x" title="Quitar de la selección" aria-label="Quitar de la selección">&times;</button>
    </span>`;
  }).join('') + (n > MAX_COMPARAR ? `<span class="tray-more">+${n - MAX_COMPARAR}</span>` : '');
  const fus = document.getElementById('trayFusionar');
  fus.disabled = n < 2 || n > MAX_FUSION;
  fus.title = n < 2 ? 'Selecciona al menos 2 tarjetas del mismo inmueble' : n > MAX_FUSION ? `Máximo ${MAX_FUSION}` : 'Son el mismo inmueble: dejar una sola tarjeta';
  const cmp = document.getElementById('trayComparar');
  cmp.disabled = n < 2 || n > MAX_COMPARAR;
  cmp.title = n < 2 ? 'Selecciona al menos 2' : n > MAX_COMPARAR ? `Máximo ${MAX_COMPARAR}` : '';
  // El motivo de un botón apagado tiene que verse: en `title` no existe en el teléfono ni
  // para quien no pasa el ratón por encima. Y «Fusionar» se explica en una línea (R1-22).
  document.getElementById('trayAyuda').textContent =
    n < 2 ? `Elige de 2 a ${MAX_COMPARAR} inmuebles para compararlos${INMO ? '' : ', o 2 o más del mismo inmueble para fusionarlos'}.`
    : n > MAX_COMPARAR ? `Para comparar, deja máximo ${MAX_COMPARAR}: quita ${n - MAX_COMPARAR}.`
    : INMO ? '' : 'Fusionar deja en una sola tarjeta los anuncios del mismo inmueble.';
}

let toastTimer = null;
// `ver` es a dónde fue lo que se hizo, {texto, href}: «Guardada en Catálogo · Ver». Un aviso
// que sólo dice «listo» deja a la persona sin saber que la propiedad cambió de pestaña.
function toast(msg, deshacer, ver) {
  const t = document.getElementById('toast');
  t.innerHTML = `<span>${esc(msg)}</span>` +
    (ver ? `<a class="toast-ver" href="${esc(ver.href)}">${esc(ver.texto)}</a>` : '') +
    (deshacer ? '<button id="toastUndo">Deshacer</button>' : '') +
    '<button id="toastCerrar" aria-label="Cerrar aviso">&times;</button>';
  t.hidden = false;
  const cerrar = () => { clearTimeout(toastTimer); t.hidden = true; };
  const programar = () => { clearTimeout(toastTimer); toastTimer = setTimeout(cerrar, 10000); };
  programar();
  // Con el puntero o el foco encima no corre el reloj: era la otra forma de perder el
  // aviso — diez segundos y adiós, sin manera de volver a leerlo.
  t.onmouseenter = () => clearTimeout(toastTimer);
  t.onmouseleave = programar;
  t.onfocusin = () => clearTimeout(toastTimer);
  t.onfocusout = programar;
  document.getElementById('toastCerrar').onclick = cerrar;
  if (deshacer) document.getElementById('toastUndo').onclick = () => { cerrar(); deshacer(); };
}

document.getElementById('trayItems').addEventListener('click', e => {
  const it = e.target.closest('.tray-item');
  if (it && e.target.closest('.tray-x')) toggleSeleccion(it.dataset.id);
});
document.getElementById('trayClear').addEventListener('click', limpiarSeleccion);
document.getElementById('trayComparar').addEventListener('click', () => {
  location.href = `comparar.html?ids=${[...seleccion.keys()].map(encodeURIComponent).join(',')}`;
});

document.getElementById('trayEstado').addEventListener('change', async e => {
  const nuevo = e.target.value;
  e.target.value = '';
  if (!nuevo) return;
  // Sólo las que cambian: mandar un PUT por las que ya estaban así es ruido.
  const previos = new Map([...seleccion.values()].filter(l => l.status !== nuevo).map(l => [l.id, l.status]));
  if (!previos.size) return toast(`Las ${seleccion.size} ya estaban en ${nuevo}`);
  const { ok, fallidos } = await estadoEnLote([...previos.keys()].map(id => [id, nuevo]));
  const unidad = ok.length === 1 ? 'inmueble' : 'inmuebles';
  toast(`${ok.length} ${unidad} → ${nuevo}` +
        (fallidos.length ? `. ${fallidos.length} no se ${fallidos.length === 1 ? 'pudo guardar' : 'pudieron guardar'}.` : ''),
    ok.length ? async () => {
      const r = await estadoEnLote(ok.map(id => [id, previos.get(id)]));
      if (r.fallidos.length) toast(`No se pudo deshacer en ${r.fallidos.length}.`);
    } : null);
});

// «Son el mismo inmueble»: las tarjetas elegidas quedan en una, con todo lo que cada una
// traía detrás. Lo decide un asesor y vale para el equipo; se deshace desde la ficha,
// separando el anuncio que no era.
document.getElementById('trayFusionar').hidden = INMO;
document.getElementById('trayFusionar').addEventListener('click', async () => {
  const lista = [...seleccion.values()];
  const anuncios = lista.reduce((t, l) => t + l.anuncios, 0);
  if (!(await UI.confirmar({
    titulo: `¿Estas ${lista.length} tarjetas son el mismo inmueble?`,
    texto: `Quedarán en una sola tarjeta con sus ${anuncios} anuncios, para todo el equipo. `
      + 'Si alguno no era, se separa desde la ficha.',
    verbo: 'Fusionar' }))) return;
  try {
    await API.post('/duplicados/fusionar', { ids: lista.map(l => l.id) });
    toast(`${lista.length} tarjetas fusionadas en una`);
    seleccion.clear();
    render();
  } catch (err) { toast(`No se pudo fusionar: ${err.message}`); }
});

// Los clientes se piden una sola vez, la primera vez que hace falta.
let clientesCache = null;
async function cargarClientes() {
  if (clientesCache) return clientesCache;
  clientesCache = (await API.get('/clientes').catch(() => [])).sort((a, b) => a.nombre.localeCompare(b.nombre));
  document.getElementById('trayCliente').innerHTML = '<option value="">Asignar a cliente…</option>' +
    clientesCache.map(c => `<option value="${esc(c.id)}">${esc(c.nombre)}</option>`).join('');
  return clientesCache;
}
document.getElementById('trayCliente').addEventListener('focus', cargarClientes);
document.getElementById('trayCliente').addEventListener('mousedown', cargarClientes);

// Un proceso cuelga de una ficha, no del anuncio. Si el inmueble aún no tiene
// ficha, se crea con los datos del anuncio (igual que el botón de la ficha). El precio
// es el total: en un anuncio publicado por m², el publicado sería $700 por un terreno.
async function fichaDe(l) {
  const fs = await API.get(`/fichas?listing=${encodeURIComponent(l.id)}`).catch(() => []);
  if (fs[0]) return fs[0];
  return API.post('/fichas', {
    source_listing_id: l.id, titulo: l.titulo, precio: Anuncio.total(l),
    moneda: l.moneda, tamano_m2: l.size, fotos: l.fotos,
    construccion_m2: l.construccion && l.construccion !== l.size ? l.construccion : null,
  });
}
document.getElementById('trayCliente').addEventListener('change', async e => {
  const clienteId = e.target.value;
  e.target.value = '';
  if (!clienteId) return;
  const cliente = clientesCache?.find(c => String(c.id) === clienteId);
  const nombre = cliente?.nombre ?? 'el cliente';
  const lista = [...seleccion.values()];
  const cuantos = `${lista.length} ${lista.length === 1 ? 'inmueble' : 'inmuebles'}`;
  // Un toque en falso en el <select> proponía N inmuebles al cliente equivocado, y desde la
  // Bolsa además los sacaba de ella sin decirlo (R1-05).
  if (!(await UI.confirmar({
    titulo: `¿Proponer ${cuantos} a ${nombre}?`,
    texto: INMO ? 'Se agregan a lo que ya se le presentó.'
      : 'Pasan de la Bolsa al Catálogo, con su ficha, y quedan presentados a este cliente.',
    verbo: 'Proponer' }))) return;
  toast(`Proponiendo ${cuantos} a ${nombre}\u2026`);
  const res = await Promise.allSettled(lista.map(async l => {
    const f = await fichaDe(l);
    return API.post('/procesos', { cliente_id: clienteId, ficha_id: f.id });
  }));
  const ok = res.filter(r => r.status === 'fulfilled').length;
  // A dónde fue: desde la Bolsa, al Catálogo filtrado por ese cliente; desde el Catálogo,
  // a la tabla del cliente.
  const ver = INMO ? { texto: 'Ver en Clientes', href: `clientes.html#${encodeURIComponent(clienteId)}` }
    : { texto: 'Ver en el Catálogo', href: `index.html?tab=inmobiliaria&pcliente=${encodeURIComponent(clienteId)}` };
  toast(ok === lista.length
    ? `${ok} ${ok === 1 ? 'inmueble propuesto' : 'inmuebles propuestos'} a ${nombre}${INMO ? '' : ' · ahora en el Catálogo'}`
    : `${ok} de ${lista.length} propuestos a ${nombre}. Los demás fallaron o ya estaban.`, null, ok ? ver : null);
  limpiarSeleccion();
  if (!INMO) render();      // lo propuesto ya no es de la Bolsa
});
// ── Bolsa propia: guardar sin asignar ────────────────────────────────────────
// Inmobiliaria es "lo que tiene ficha". Una propiedad entra ahí de dos formas sin
// pasar por un cliente: guardando un anuncio de la Bolsa (se le crea su ficha) o
// dándola de alta a mano, que es una ficha sin anuncio detrás; el resto de sus datos
// se captura en su página.
document.getElementById('trayInmo').hidden = INMO;
document.getElementById('trayInmo').addEventListener('click', async () => {
  const lista = [...seleccion.values()];
  const res = await Promise.allSettled(lista.map(fichaDe));
  const ok = res.filter(r => r.status === 'fulfilled').length;
  toast(ok === lista.length
    ? `${ok === 1 ? 'Guardado' : `${ok} guardados`} en el Catálogo`
    : `${ok} de ${lista.length} guardados en el Catálogo. Los demás fallaron.`,
    null, ok ? { texto: 'Ver', href: 'index.html?tab=inmobiliaria' } : null);
  seleccion.clear();
  render();
});
// Y lo contrario: sacar de Inmobiliaria. No hay deshacer —con la ficha se va lo que
// cuelga de ella—, así que la confirmación dice qué se pierde.
document.getElementById('trayQuitar').hidden = !INMO;
document.getElementById('trayQuitar').addEventListener('click', async () => {
  const lista = [...seleccion.values()];
  const propias = lista.filter(l => l.id.startsWith('pipeline:')).length;
  const cuantas = lista.length === 1 ? 'esta propiedad' : `estas ${lista.length} propiedades`;
  if (!(await UI.confirmar({
    titulo: `¿Eliminar ${cuantas} del Catálogo?`,
    texto: 'Se borra su ficha con sus documentos, fotos subidas, fichas PDF y lo presentado a clientes. No se puede deshacer.\n\n'
      + (propias < lista.length ? 'Los anuncios de portal vuelven a la Bolsa. ' : '')
      + (propias ? `${propias === 1 ? 'La que se dio' : `Las ${propias} que se dieron`} de alta a mano se ${propias === 1 ? 'pierde' : 'pierden'} por completo.` : ''),
    verbo: 'Eliminar', peligro: true }))) return;
  const res = await Promise.allSettled(lista.map(l => API.quitarDeInmobiliaria(l.id)));
  const ok = res.filter(r => r.status === 'fulfilled').length;
  toast(ok === lista.length
    ? `${ok} ${ok === 1 ? 'propiedad eliminada' : 'propiedades eliminadas'} del Catálogo`
    : `${ok} de ${lista.length} eliminadas del Catálogo. Las demás fallaron.`,
    null, ok && lista.length > propias ? { texto: 'Ver la Bolsa', href: 'index.html' } : null);
  seleccion.clear();
  render();
});
document.getElementById('nueva-prop').hidden = !INMO;
document.getElementById('nueva-prop').addEventListener('click', async () => {
  const titulo = await UI.pedir({ titulo: 'Nueva propiedad', etiqueta: 'Nombre de la propiedad', verbo: 'Crear', placeholder: 'Bodega en Apodaca' });
  if (!titulo) return;
  try {
    const f = await API.post('/fichas', { titulo });
    location.href = `listing.html?id=${encodeURIComponent('pipeline:' + f.id)}`;
  } catch (err) { toast('No se pudo crear la propiedad: ' + err.message); }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await API.logout().catch(() => {});
  location.replace('login.html');
});

// ── Init ─────────────────────────────────────────────────────────────────────

// ── Buscar para un cliente ───────────────────────────────────────────────────
// `index.html?cliente=<id>` llega desde "Buscar inmuebles" en clientes.html: los
// criterios que se capturaron como píldoras en "Qué busca" se vuelven los filtros.
// Las llaves son las mismas que entiende /api/listings (ver cliente.criterios en
// schema.sql), así que aquí sólo se copian.
async function aplicarCliente(id) {
  const cs = await API.get('/clientes').catch(() => []);
  const c = cs.find(x => String(x.id) === String(id));
  if (!c) { toast('Ese cliente ya no existe'); return; }
  const cr = c.criterios ?? {};
  F.cliente = { id: c.id, nombre: c.nombre };
  F.tipos = (cr.tipos ?? []).filter(t => TIPOS_COM.includes(t));
  F.operacion = ['rent', 'sale'].includes(cr.operacion) ? cr.operacion : '';
  F.lugares = (cr.lugares ?? []).slice(0, MAX_LUGARES);
  for (const k of ['m2_min', 'm2_max', 'ppm_min', 'ppm_max', 'precio_min', 'precio_max'])
    F[k] = cr[k] ?? '';
  F.m2_de = ['terreno', 'construccion'].includes(cr.m2_de) ? cr.m2_de : '';
}
function quitarCriterios() {
  F.cliente = null; F.tipos = []; F.usos = []; F.carac = {}; F.operacion = ''; F.lugares = [];
  for (const k of ['m2_min', 'm2_max', 'm2_de', 'ppm_min', 'ppm_max', 'precio_min', 'precio_max']) F[k] = '';
  history.replaceState(null, '', location.pathname);
}

// Aviso de inventario viejo. El cron carga una fuente por noche de lunes a viernes, así
// que cada una se refresca una vez por semana: pasados FRESCURA_DIAS sin carga, algo
// se rompió (del 2026-09-23 en adelante fue el proxy, y el tablero no lo decía).
// Son 9 y no los 7 de scrapers.js («Al día»): con una carga por semana, a los 7 días justos una
// fuente sana ya no está al día pero tampoco está rota, y el aviso gritaría cada lunes.
const FRESCURA_DIAS = 9;
// Lo descartado se recuerda por fuente y por día: mañana, si sigue vieja, vuelve a avisar.
const FRESCURA_KEY = 'ol-frescura-oculta';
const frescuraOculta = () => { try { return JSON.parse(localStorage.getItem(FRESCURA_KEY) ?? '{}'); } catch { return {}; } };

async function avisarFrescura(sesion) {
  const r = await API.get('/frescura').catch(() => null);
  if (!r?.fuentes?.length) return;
  const dias = iso => Math.floor((Date.now() - new Date(iso)) / 86400000);
  const dia = iso => new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
  const el = document.getElementById('frescura'), txt = document.getElementById('frescuraTxt');
  // Una fuente sin ninguna carga todavía (Spot2, recién agregada) no está «vieja»: nadie la
  // ha cargado nunca, y «nunca» no es un dato que el asesor pueda usar (R1-15).
  const cargadas = r.fuentes.filter(f => f.ultima_carga);
  if (!cargadas.length) {
    txt.innerHTML = '<b>El inventario nunca se ha cargado.</b>';
  } else {
    const ocultas = frescuraOculta(), hoy = hoyLocal();
    const viejas = cargadas.filter(f => dias(f.ultima_carga) > FRESCURA_DIAS && ocultas[f.source ?? f.label] !== hoy);
    if (!viejas.length) return;
    if (cargadas.every(f => dias(f.ultima_carga) > FRESCURA_DIAS)) {
      const ult = cargadas.map(f => f.ultima_carga).sort().pop();
      txt.innerHTML = `<b>El inventario no se actualiza desde el ${esc(dia(ult))}</b> (hace ${dias(ult)} días): ` +
        'algunos anuncios pueden ya no estar disponibles. Confirma con el portal antes de ofrecerlos.';
    } else {
      txt.innerHTML = '<b>Sin actualizar:</b> ' + viejas.map(f => `${esc(f.label)} (desde el ${esc(dia(f.ultima_carga))})`).join(', ') +
        '. Sus anuncios pueden ya no estar disponibles.';
    }
    el.dataset.fuentes = JSON.stringify(viejas.map(f => f.source ?? f.label));
  }
  // «Ver fuentes» sólo para quien tiene la sección de Scrapers: al resto le daría un 403.
  document.getElementById('frescuraVer').hidden = !sesion?.scrapers;
  el.hidden = false;
}
document.getElementById('frescuraX').addEventListener('click', () => {
  const el = document.getElementById('frescura');
  const ocultas = frescuraOculta(), hoy = hoyLocal();
  for (const f of JSON.parse(el.dataset.fuentes ?? '[]')) ocultas[f] = hoy;
  try { localStorage.setItem(FRESCURA_KEY, JSON.stringify(ocultas)); } catch { /* sin persistencia */ }
  el.hidden = true;
});

API.me().then(async sesion => {
  document.getElementById('authBox').hidden = true;
  document.getElementById('userBox').hidden = false;
  const url = new URLSearchParams(location.search);
  if (url.get('cliente')) await aplicarCliente(url.get('cliente'));
  // Inmobiliaria: los clientes hacen falta para el filtro y su resumen. Desde la ficha
  // de un cliente se llega con ?pcliente=<id> ("lo que ya le presentamos").
  if (INMO) await Promise.all([cargarClientes(), cargarEquipo()]);
  // Después del cliente: si la URL trae filtros, son los que el asesor ajustó encima.
  const u = aplicarURL();
  // Se abre buscando en el área de partida de `config.js`, esté o no el mapa a la vista:
  // hasta 1366 px el tablero abre en rejilla, y sin esto una laptop vería el inventario
  // nacional y un monitor grande el de Monterrey. Con los criterios de un cliente no: sus
  // lugares mandan, y el mapa encuadra lo que salga. Si la URL traía cámara y el mapa se
  // ve, se respeta esa —es una búsqueda que alguien compartió, no la de fábrica—.
  // Y con lugares elegidos tampoco: son el otro modo de decir dónde.
  if (F.cliente || F.lugares.length) seguirMapa(false);
  else if (mapFollow.checked) {
    const area = u.mapa && inm.classList.contains('split') ? Mapa.area() : areaInicial();
    if (area) buscarEnElMapa(area, u.mapa ? MAPA_TXT : CENTRO_NOMBRE);
  }
  await render();
  restaurarScroll();
  recuperarComparacion();
  if (!INMO) avisarFrescura(sesion);
}).catch(err => {
  // El 401 lo maneja api.js redirigiendo al login; aquí sólo quedan fallos reales.
  console.error(err);
  UI.errorCarga(document.getElementById('grid'), `No se pudo cargar el inventario: ${err.message}`, () => location.reload());
});

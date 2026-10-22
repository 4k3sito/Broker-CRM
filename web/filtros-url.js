// Los filtros del tablero, de ida y vuelta por la URL.
//
// Existe para que una búsqueda sobreviva a recargar la página y se pueda mandar por
// liga: "locales en renta en San Pedro bajo $60k" es una URL y no cinco clics. Hasta
// el 2026-10-22 la URL sólo cargaba `tab`, `cliente`, `pcliente` y `asesor`.
//
// No toca el DOM ni el estado de app.js: recibe y devuelve objetos planos, y así se
// prueba en node (pruebas/web/filtros-url.test.js). app.js decide cuándo escribir y
// qué hacer con lo que se lee.
//
// Los nombres son los de la API (`precio_min`, `m2_de`, `near`…) para que una URL del
// tablero se lea igual que la petición que dispara. Lo que vale lo de fábrica no se
// escribe: un tablero sin filtros tiene la URL limpia.
const FiltrosURL = (() => {
  const NUM = /^\d+(\.\d+)?$/;
  // Texto libre y números, uno a uno. Los números se validan al leer.
  const TEXTO = ['q', 'calle', 'fuente', 'pcliente', 'asesor', 'near_txt'];
  const NUMEROS = ['precio_min', 'precio_max', 'm2_min', 'm2_max', 'ppm_min', 'ppm_max'];
  // Separador del lugar: "m40|Monterrey|Nuevo León". Los nombres de municipio no lo usan.
  const SEP = '|';

  function escribir(e) {
    const p = new URLSearchParams();
    const pon = (k, v) => { if (v !== '' && v != null) p.set(k, String(v)); };
    // `tab` y `cliente` primero: son los que ya existían y los que se leen con la vista.
    if (e.tab && e.tab !== 'bolsa') pon('tab', e.tab);
    pon('cliente', e.cliente);
    for (const k of TEXTO) if (k !== 'near_txt') pon(k, e[k]);
    pon('operacion', e.operacion);
    for (const k of NUMEROS) pon(k, e[k]);
    if (e.m2_min || e.m2_max) pon('m2_de', e.m2_de);
    for (const l of e.lugares ?? []) p.append('lugar', [l.valor, l.nombre ?? '', l.estado ?? ''].join(SEP));
    for (const t of e.tipos ?? []) p.append('tipo', t);
    for (const t of e.etapas ?? []) p.append('etapa', t);
    // Cercanía: o es un punto que puso la persona (near), o es la vista del mapa que
    // sigue. La vista se guarda como cámara, no como filtro, para que al recargar el
    // mapa vuelva a donde estaba y siga siguiendo.
    if (e.mapa) pon('mapa', [e.mapa.lat.toFixed(5), e.mapa.lng.toFixed(5), e.mapa.zoom.toFixed(2)].join(','));
    else if (e.near) { pon('near', e.near); pon('near_txt', e.near_txt); pon('radio', e.radio); }
    if (e.orden && e.orden !== 'recientes') pon('orden', e.orden);
    if (e.estado && e.estado !== 'Todos') pon('estado', e.estado);
    if (e.destacados) pon('destacados', 1);
    if (e.pagina > 1) pon('pagina', e.pagina);
    return p.toString();
  }

  // Devuelve sólo lo que vino y es válido; lo que falta, app.js lo deja como está.
  // `val` trae las listas cerradas que conoce app.js: tipos, órdenes y estados.
  function leer(qs, val = {}) {
    const p = new URLSearchParams(qs);
    const r = {};
    for (const k of TEXTO) { const v = p.get(k)?.trim(); if (v) r[k] = v; }
    for (const k of NUMEROS) { const v = p.get(k)?.trim(); if (v && NUM.test(v)) r[k] = v; }
    const op = p.get('operacion');
    if (op === 'rent' || op === 'sale') r.operacion = op;
    const m2de = p.get('m2_de');
    if (m2de === 'terreno' || m2de === 'construccion') r.m2_de = m2de;

    const lugares = p.getAll('lugar').map(s => {
      const [valor, nombre, estado] = s.split(SEP);
      return valor ? { valor, nombre: nombre || valor, estado: estado ?? '' } : null;
    }).filter(Boolean);
    if (lugares.length) r.lugares = lugares.slice(0, val.maxLugares ?? 20);

    const tipos = p.getAll('tipo').filter(t => !val.tipos || val.tipos.includes(t));
    if (tipos.length) r.tipos = [...new Set(tipos)];
    const etapas = p.getAll('etapa').filter(Boolean);
    if (etapas.length) r.etapas = [...new Set(etapas)];

    const mapa = (p.get('mapa') ?? '').split(',').map(Number);
    if (mapa.length === 3 && mapa.every(Number.isFinite) && Math.abs(mapa[0]) <= 90 && Math.abs(mapa[1]) <= 180)
      r.mapa = { lat: mapa[0], lng: mapa[1], zoom: Math.max(0, Math.min(22, mapa[2])) };
    else if (p.get('near')?.trim()) {
      r.near = p.get('near').trim();
      const radio = Number(p.get('radio'));
      // Los mismos topes que el control de radio del tablero.
      if (Number.isFinite(radio) && radio > 0) r.radio = Math.max(500, Math.min(12000, Math.round(radio / 500) * 500));
    } else delete r.near_txt;

    const orden = p.get('orden');
    if (orden && (!val.ordenes || val.ordenes.includes(orden))) r.orden = orden;
    const estado = p.get('estado');
    if (estado && (!val.estados || val.estados.includes(estado))) r.estado = estado;
    if (p.get('destacados') === '1') r.destacados = true;
    const pagina = Number(p.get('pagina'));
    if (Number.isInteger(pagina) && pagina > 1) r.pagina = pagina;
    return r;
  }

  return { escribir, leer };
})();

// La propiedad: los anuncios que son el mismo inmueble, y lo que el equipo decide de
// ellos. Lo comparten la ficha (sección «Anuncios de esta propiedad») y la página de
// posibles duplicados: el renglón de un anuncio se pinta igual en las dos y las tres
// decisiones —fusionar, separar, descartar— se piden desde aquí.
//
// Qué se fusiona solo lo decide el servidor (scrapers/v2/duplicados.py); esto sólo
// enseña el resultado y manda lo que diga el asesor. Usa esc, mx, srcSeguro y
// hrefSeguro de texto.js, Anuncio de anuncio.js y API de api.js.
const Propiedad = (() => {
  // Por qué quedaron juntos, como lo guarda `propiedad_anuncio.motivo` (unido con '+').
  const MOTIVOS = {
    eb_id: 'mismo ID de EasyBroker', gemelo: 'mismo anuncio en Inmuebles24 y Vivanuncios',
    anunciante: 'mismo anunciante, m² y precio', texto: 'mismo texto, m² y precio',
    foto: 'misma foto y m²', asesor: 'marcado por el equipo',
  };
  const SENALES = { foto: 'Misma foto y m²; el precio no cuadra', ubicacion: 'Mismos m² y precio, a pocos metros' };

  const motivo = m => (m ?? '').split('+').filter(Boolean).map(k => MOTIVOS[k] ?? k).join(' · ');
  const senal = s => SENALES[s] ?? s;

  // Un anuncio en un renglón: foto, precio, superficie, quién y dónde. `acciones` es
  // el marcado de sus botones; `nota` una etiqueta junto al portal («Este anuncio»).
  function fila(t, acciones = '', nota = '') {
    const op = t.transaction_type === 'rent' ? ' / mes' : '';
    const ppm = t.precio && t.property_size_m2 ? ` · $${mx(Math.round(t.precio / t.property_size_m2))}/m²` : '';
    const foto = srcSeguro(t.image);
    return `<div class="dp-fila${t.activo ? '' : ' baja'}" data-id="${esc(t.id)}">
      ${foto ? `<img class="dp-foto" src="${foto}" alt="" loading="lazy">` : '<span class="dp-foto"></span>'}
      <div class="dp-txt">
        <div class="dp-precio"><b>${t.precio ? '$' + mx(Math.round(t.precio)) : 'Sin precio'}</b>
          <span>${esc(t.currency ?? 'MXN')}${op}${t.property_size_m2 ? ' · ' + m2Txt(t.property_size_m2) : ''}${ppm}</span></div>
        <div class="dp-tit">${esc(t.title ?? 'Sin título')}</div>
        <div class="dp-meta"><b>${esc(Anuncio.fuente(t.source))}</b>${nota ? ` · <i>${esc(nota)}</i>` : ''}${t.anuncios > 1 ? ` · ya junta ${t.anuncios} anuncios` : ''}
          · ${esc(t.broker_name ?? 'Anunciante sin nombre')}${t.location || t.zona ? ' · ' + esc(t.location ?? t.zona) : ''}${t.activo ? '' : ' · dado de baja'}</div>
      </div>
      <div class="dp-acc">
        <a class="fx-btn" href="listing.html?id=${encodeURIComponent(t.id)}">Ficha</a>
        <a class="fx-btn" href="${hrefSeguro(t.url)}" target="_blank" rel="noopener">Portal &#8599;</a>
        ${acciones}
      </div>
    </div>`;
  }

  const de = id => API.get(`/duplicados${API.qs({ id })}`);
  const fusionar = ids => API.post('/duplicados/fusionar', { ids });
  const separar = id => API.post('/duplicados/separar', { id });
  const descartar = (a, b) => API.post('/duplicados/descartar', { a, b });

  return { motivo, senal, fila, de, fusionar, separar, descartar };
})();

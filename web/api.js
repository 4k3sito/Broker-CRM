// Capa de datos: sustituye al cliente de supabase-js que estaba repetido en los 6
// archivos. Misma sesión por cookie httponly — el token nunca se toca desde JS.
// A dónde se vuelve después de entrar. Sin esto, que la sesión caducara en una ficha
// significaba perder la ficha: se mandaba al login y el asesor aterrizaba en el tablero,
// con los filtros y el scroll perdidos. `next` viaja como ruta de este sitio y login.js
// la valida antes de usarla (si no, sería un redirect abierto).
function alLogin() {
  const aqui = location.pathname + location.search + location.hash;
  location.href = `login.html?next=${encodeURIComponent(aqui)}`;
}

const API = {
  async req(metodo, ruta, cuerpo, opciones) {
    const r = await fetch(`/api${ruta}`, {
      ...opciones,                  // { keepalive: true } para lo que sale al cerrar la página
      method: metodo,
      credentials: 'same-origin',   // la cookie de sesión viaja sola
      headers: cuerpo ? { 'Content-Type': 'application/json' } : undefined,
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    return API.leer(r);
  },
  async leer(r) {
    if (r.status === 401 && !location.pathname.endsWith('login.html')) {
      alLogin();
      throw new Error('Sesión expirada');
    }
    if (r.status === 204) return null;
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.detail ?? `Error ${r.status}`);
    return data;
  },
  get:    (ruta)         => API.req('GET', ruta),
  post:   (ruta, cuerpo, opciones) => API.req('POST', ruta, cuerpo, opciones),
  put:    (ruta, cuerpo) => API.req('PUT', ruta, cuerpo),
  patch:  (ruta, cuerpo) => API.req('PATCH', ruta, cuerpo),
  del:    (ruta)         => API.req('DELETE', ruta),

  // Saca una propiedad de Inmobiliaria: borra su ficha y, en cascada (schema.sql), lo
  // que cuelga de ella: procesos, documentos, archivos y fichas PDF. La llave es
  // (asesor, anuncio), así que un anuncio puede traer más de una ficha: se van todas,
  // o seguiría saliendo en la pestaña.
  async quitarDeInmobiliaria(listingId) {
    const fs = await API.get(`/fichas${API.qs({ listing: listingId })}`);
    await Promise.all(fs.map(f => API.del(`/fichas/${f.id}`)));
  },

  // Sube un archivo: el cuerpo ES el archivo (sin multipart) y el nombre va en la URL.
  // El tipo no se manda: la API lo lee de los bytes (ver "Archivos" en main.py).
  async subir(ruta, archivo, nombre) {
    return API.leer(await fetch(`/api${ruta}${API.qs({ nombre: nombre ?? archivo.name })}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream' }, body: archivo,
    }));
  },

  // Query string a partir de un objeto, saltando vacíos.
  qs(params) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === null || v === undefined || v === '' || v === false) continue;
      Array.isArray(v) ? v.forEach(x => p.append(k, x)) : p.append(k, v);
    }
    const s = p.toString();
    return s ? `?${s}` : '';
  },

  // El PDF del análisis de mercado. No es un `<a href>` normal a propósito: si la
  // propiedad no se puede analizar la API responde 422 con el motivo, y un enlace
  // llevaría al asesor a una página de JSON en vez de decírselo en su sitio.
  async pdfAnalisis(listingId) {
    const r = await fetch(`/api/analisis-pdf/${encodeURIComponent(listingId)}`,
                          { credentials: 'same-origin' });
    if (r.status === 401) { alLogin(); throw new Error('Sesión expirada'); }
    if (!r.ok) {
      const d = await r.json().catch(() => null);
      throw new Error(d?.detail ?? `Error ${r.status}`);
    }
    return r.blob();
  },

  // Baja un archivo que la API arma al vuelo (un .xlsx) y lo guarda con el nombre que
  // ella diga. Va por fetch y no por un <a href> por lo mismo que el PDF: si falla, el
  // motivo se dice en la página.
  async descargar(ruta) {
    const r = await fetch(`/api${ruta}`, { credentials: 'same-origin' });
    if (r.status === 401) { alLogin(); throw new Error('Sesión expirada'); }
    if (!r.ok) {
      const d = await r.json().catch(() => null);
      throw new Error(d?.detail ?? `Error ${r.status}`);
    }
    const nombre = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') ?? '')?.[1] ?? 'descarga';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await r.blob());
    a.download = nombre;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    // El servidor dice cuántos renglones escribió (`X-Filas`): el total filtrado puede
    // ser mayor que su tope, y el aviso del tablero no puede inventarse el número.
    return Number(r.headers.get('X-Filas')) || null;
  },

  me:     ()             => API.get('/me'),
  login:  (email, password) => API.post('/login', { email, password }),
  logout: ()             => API.post('/logout'),
};

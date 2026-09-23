// Capa de datos: sustituye al cliente de supabase-js que estaba repetido en los 6
// archivos. Misma sesión por cookie httponly — el token nunca se toca desde JS.
const API = {
  async req(metodo, ruta, cuerpo) {
    const r = await fetch(`/api${ruta}`, {
      method: metodo,
      credentials: 'same-origin',   // la cookie de sesión viaja sola
      headers: cuerpo ? { 'Content-Type': 'application/json' } : undefined,
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    if (r.status === 401 && !location.pathname.endsWith('login.html')) {
      location.href = 'login.html';
      throw new Error('Sesión expirada');
    }
    if (r.status === 204) return null;
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.detail ?? `Error ${r.status}`);
    return data;
  },
  get:    (ruta)         => API.req('GET', ruta),
  post:   (ruta, cuerpo) => API.req('POST', ruta, cuerpo),
  put:    (ruta, cuerpo) => API.req('PUT', ruta, cuerpo),
  patch:  (ruta, cuerpo) => API.req('PATCH', ruta, cuerpo),
  del:    (ruta)         => API.req('DELETE', ruta),

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
    if (r.status === 401) { location.href = 'login.html'; throw new Error('Sesión expirada'); }
    if (!r.ok) {
      const d = await r.json().catch(() => null);
      throw new Error(d?.detail ?? `Error ${r.status}`);
    }
    return r.blob();
  },

  me:     ()             => API.get('/me'),
  login:  (email, password) => API.post('/login', { email, password }),
  logout: ()             => API.post('/logout'),
};

// Helpers de texto compartidos por todas las páginas.
//
// Vive aparte de `api.js` a propósito: esa es la capa de datos y esto no toca la
// red. Existe porque `esc` llegó a tener cinco copias —tres llamadas `esc` y dos
// `escAttr`— y un helper sin casa se olvida: `listing.js` interpolaba el título,
// la dirección, la descripción y las características de un anuncio sin escapar,
// mientras `app.js` sí escapaba esos mismos campos. El contenido viene de
// portales scrapeados, o sea de terceros.

// Escapa para HTML **y** para dentro de un atributo: las comillas también.
const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Minúsculas sin acentos, para comparar lo que teclea el usuario.
const norm = s => (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Un `href` que sólo acepta http(s). Escapar no basta: `javascript:…` sobrevive
// intacto al escapado y se ejecuta al hacer clic.
const hrefSeguro = u => /^https?:/i.test(String(u ?? '').trim()) ? esc(u) : '#';

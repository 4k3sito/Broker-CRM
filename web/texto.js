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

// El `src` de una foto: http(s) o una foto subida al CRM (`/api/archivos/<id>`, ver
// "Archivos" en main.py). Lo demás no se pinta.
const srcSeguro = u => /^(https?:|\/api\/archivos\/)/i.test(String(u ?? '').trim()) ? esc(u) : '';

// Superficie de una propiedad, distinguiendo terreno y construcción cuando se sabe.
// Devuelve pares [etiqueta, m²]: los dos si el portal (o la ficha) los trae distintos;
// uno etiquetado si sólo se sabe cuál es; y "Superficie" a secas cuando el anuncio da
// un solo número sin decir de qué —o da el mismo para los dos, que es lo mismo—.
function superficies(terreno, construccion, area) {
  const t = Number(terreno) || null, c = Number(construccion) || null, a = Number(area) || null;
  if (t && c && t !== c) return [['Terreno', t], ['Construcción', c]];
  if (t && !c) return [['Terreno', t]];
  if (c && !t) return [['Construcción', c]];
  return (a ?? t) ? [['Superficie', a ?? t]] : [];
}
const m2Txt = n => `${Math.round(n).toLocaleString('es-MX')} m²`;

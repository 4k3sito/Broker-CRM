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

// Un número como se escribe en México: 1,234,567.
const mx = n => Number(n).toLocaleString('es-MX');

// Un monto que tiene que caber en poco espacio: "$115.5 M" de un millón para arriba,
// el número entero por debajo.
const dineroCorto = n => n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e8 ? 1 : 2).replace(/\.?0+$/, '')} M` : `$${mx(Math.round(n))}`;

// El peso de un archivo: "3.4 MB", "120 KB".
const pesoTxt = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

// Superficie de una propiedad, distinguiendo terreno y construcción cuando se sabe.
// Devuelve pares [etiqueta, m²]: los dos si el portal (o la ficha) trae los dos, aunque
// sean el mismo número (así lo pidió el equipo: hay que poder distinguirlos, y juntarlos
// le quitaba la etiqueta a más de la mitad de los locales y oficinas); uno etiquetado si
// sólo se sabe cuál es; y "Superficie" a secas cuando el anuncio da un solo número sin
// decir de qué.
function superficies(terreno, construccion, area) {
  const t = Number(terreno) || null, c = Number(construccion) || null, a = Number(area) || null;
  if (t && c) return [['Terreno', t], ['Construcción', c]];
  if (t && !c) return [['Terreno', t]];
  if (c && !t) return [['Construcción', c]];
  return (a ?? t) ? [['Superficie', a ?? t]] : [];
}
const m2Txt = n => `${Math.round(n).toLocaleString('es-MX')} m²`;

// La fecha de hoy en hora LOCAL, como AAAA-MM-DD. `new Date().toISOString()` da la fecha
// UTC: en Monterrey (UTC-6), de las 18:00 a medianoche ya es mañana, y lo que vencía hoy
// salía como vencido. Toda comparación con un `vence_el` usa esto.
const hoyLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Una fecha sin hora (AAAA-MM-DD) o un instante, en corto: "9 nov", con el año sólo si
// no es el actual ("9 nov 2025"). Una fecha sin hora se lee como local: `new Date('2026-11-09')`
// la tomaría como medianoche UTC y en México saldría el día anterior.
function fechaCorta(v) {
  if (!v) return '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00`) : new Date(v);
  if (isNaN(d)) return '';
  const o = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
  return d.toLocaleDateString('es-MX', o).replace('.', '');
}

// La liga de WhatsApp de un teléfono: sólo dígitos y, si son 10 (un número mexicano sin
// lada de país), con el 52 delante. Vacío si no parece un teléfono.
function waLink(tel) {
  const d = String(tel ?? '').replace(/\D/g, '');
  return d.length >= 10 ? `https://wa.me/${d.length === 10 ? '52' + d : d}` : '';
}

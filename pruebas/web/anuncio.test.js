// Pruebas de web/anuncio.js. Corren con `npm run probar:web` (node --test, sin
// dependencias). Los scripts de web/ son clásicos, con `const` globales y sin
// `module.exports`: aquí se cargan igual que los carga el navegador, uno tras otro en
// el mismo contexto, para no agregarle nada al código que se sirve.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({});
for (const f of ['texto.js', 'anuncio.js'])
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../web', f), 'utf8'), ctx, { filename: f });
const Anuncio = vm.runInContext('Anuncio', ctx);
// Lo que sale del contexto trae otros prototipos: se compara como datos.
const plano = v => JSON.parse(JSON.stringify(v));

// Una fila como la manda GET /api/listings, con lo mínimo.
const fila = extra => ({ id: 'lamudi:1', source: 'lamudi', external_id: '1', title: 'Local en Centro',
  price_numeric: 25000, currency: 'MXN', transaction_type: 'rent', status: 'new', ...extra });

test('el precio es el número que publicó el portal, con la moneda aparte', () => {
  const a = Anuncio.de(fila());
  assert.equal(a.precio, 25000);
  assert.equal(a.moneda, 'MXN');
});

// ── Precio ───────────────────────────────────────────────────────────────────
// Varios portales publican "$700" queriendo decir "$700 por m²".

test('el total de un anuncio con precio normal es su precio', () => {
  assert.equal(Anuncio.total(Anuncio.de(fila())), 25000);
});

test('el total de un anuncio publicado por m² es el que calculó la API, no el unitario', () => {
  const a = Anuncio.de(fila({ price_numeric: 700, price_is_per_m2: true, precio_total: 7500000, property_size_m2: 10714 }));
  assert.equal(Anuncio.total(a), 7500000);
});

test('un anuncio por m² sin superficie no tiene total', () => {
  assert.equal(Anuncio.total(Anuncio.de(fila({ price_numeric: 700, price_is_per_m2: true }))), null);
});

test('el precio por m² sale del total entre la superficie', () => {
  assert.equal(Anuncio.porMetro(Anuncio.de(fila({ property_size_m2: 100 }))), 250);
});

test('sin superficie, el precio por m² sólo se sabe si el portal lo publicó así', () => {
  assert.equal(Anuncio.porMetro(Anuncio.de(fila())), null);
  assert.equal(Anuncio.porMetro(Anuncio.de(fila({ price_numeric: 700, price_is_per_m2: true }))), 700);
});

test('lo que se enseña de un precio normal es el precio, sin notas', () => {
  assert.deepEqual(plano(Anuncio.precioVisible(Anuncio.de(fila()))), { monto: 25000, parcial: false, unitario: null });
});

test('de un anuncio por m² se enseña el total, y el unitario del que salió', () => {
  const a = Anuncio.de(fila({ price_numeric: 700, price_is_per_m2: true, precio_total: 7500000, property_size_m2: 10714 }));
  assert.deepEqual(plano(Anuncio.precioVisible(a)), { monto: 7500000, parcial: false, unitario: 700 });
});

test('de un anuncio por m² sin total se enseña el unitario, marcado como parcial', () => {
  const a = Anuncio.de(fila({ price_numeric: 700, price_is_per_m2: true }));
  assert.deepEqual(plano(Anuncio.precioVisible(a)), { monto: 700, parcial: true, unitario: 700 });
});

test('un anuncio sin precio no enseña ninguno', () => {
  assert.equal(Anuncio.precioVisible(Anuncio.de(fila({ price_numeric: null }))), null);
});

// ── Segundo precio ───────────────────────────────────────────────────────────
// Un inmueble puede ofrecerse en renta Y venta.

test('un anuncio con una sola oferta no tiene segundo precio', () => {
  assert.equal(Anuncio.segundoPrecio(Anuncio.de(fila())), null);
});

test('el segundo precio de una renta que también se vende', () => {
  const a = Anuncio.de(fila({ operacion_alt: 'sale', precio_alt: 4200000 }));
  assert.deepEqual(plano(Anuncio.segundoPrecio(a)), { etiqueta: 'También en venta', precio: '$4,200,000', nota: null });
});

test('el segundo precio de una venta que también se renta va por mes', () => {
  const a = Anuncio.de(fila({ transaction_type: 'sale', operacion_alt: 'rent', precio_alt: 18500.4 }));
  assert.deepEqual(plano(Anuncio.segundoPrecio(a)), { etiqueta: 'También en renta', precio: '$18,500/mes', nota: null });
});

test('un segundo precio por m² enseña el total y anota el unitario', () => {
  const a = Anuncio.de(fila({ operacion_alt: 'sale', precio_alt: 700, precio_alt_por_m2: true, precio_alt_total: 7500000 }));
  assert.deepEqual(plano(Anuncio.segundoPrecio(a)), { etiqueta: 'También en venta', precio: '$7,500,000', nota: '($700/m²)' });
});

test('un segundo precio por m² sin total se enseña como unitario', () => {
  const a = Anuncio.de(fila({ operacion_alt: 'rent', precio_alt: 120, precio_alt_por_m2: true }));
  assert.deepEqual(plano(Anuncio.segundoPrecio(a)), { etiqueta: 'También en renta', precio: '$120/m²/mes', nota: null });
});

test('se sabe que hay segunda oferta aunque su precio aún no se conozca', () => {
  const a = Anuncio.de(fila({ operacion_alt: 'sale' }));
  assert.deepEqual(plano(Anuncio.segundoPrecio(a)), { etiqueta: 'También en venta', precio: null, nota: null });
});

// ── Etiquetas ────────────────────────────────────────────────────────────────

test('el estado del asesor se lee de la API y se le devuelve en su clave', () => {
  assert.equal(Anuncio.de(fila({ status: 'contacted' })).status, 'Contactado');
  assert.equal(Anuncio.de(fila({ status: null })).status, 'Nuevo');
  assert.equal(Anuncio.estadoApi('Contactado'), 'contacted');
  assert.deepEqual(plano(Anuncio.ESTADOS), ['Nuevo', 'Revisado', 'Contactado', 'Rentado', 'Descartado']);
});

test('un anuncio de portal sin operación se toma como renta', () => {
  assert.equal(Anuncio.de(fila({ transaction_type: null })).transaccion, 'Renta');
  assert.equal(Anuncio.de(fila({ transaction_type: 'sale' })).transaccion, 'Venta');
});

test('una ficha propia sin operación no dice «Renta»', () => {
  assert.equal(Anuncio.de(fila({ source: 'pipeline', transaction_type: null })).transaccion, null);
});

test('la fuente tiene un nombre para enseñar, y una desconocida se enseña tal cual', () => {
  assert.equal(Anuncio.fuente('mercadolibre'), 'MercadoLibre');
  assert.equal(Anuncio.fuente('propiedadesmexico'), 'PropiedadesMX');
  assert.equal(Anuncio.fuente('metroscubicos'), 'Metros²');
  assert.equal(Anuncio.fuente('portalnuevo'), 'portalnuevo');
});

// ── Ubicación ────────────────────────────────────────────────────────────────

test('la dirección sale del lugar del portal, venga como texto, JSON u objeto', () => {
  assert.equal(Anuncio.de(fila({ location: 'Av. Constitución 100' })).direccion, 'Av. Constitución 100');
  assert.equal(Anuncio.de(fila({ location: '{"name": "Del Valle"}' })).direccion, 'Del Valle');
  assert.equal(Anuncio.de(fila({ location: { name: 'Mitras' } })).direccion, 'Mitras');
  assert.equal(Anuncio.de(fila({ location: null, neighborhood: 'Obispado' })).direccion, 'Obispado');
});

test('el municipio no se confunde con la dirección, pero sirve de ubicación si no hay otra', () => {
  const a = Anuncio.de(fila({ zona: 'San Pedro Garza García' }));
  assert.equal(a.direccion, null);
  assert.equal(a.zona, 'San Pedro Garza García');
  assert.equal(Anuncio.ubicacion(a), 'San Pedro Garza García');
  assert.equal(Anuncio.ubicacion(Anuncio.de(fila({ neighborhood: 'Obispado', zona: 'Monterrey' }))), 'Obispado');
});

test('mx escribe un número como se escribe en México', () => {
  assert.equal(vm.runInContext('mx(1234567.5)', ctx), '1,234,567.5');
});

// ── Propiedad: varios anuncios del mismo inmueble ────────────────────────────

test('un anuncio suelto es su propia propiedad, sin rango ni resumen', () => {
  const a = Anuncio.de(fila());
  assert.equal(a.propiedad, 'lamudi:1');
  assert.equal(a.anuncios, 1);
  assert.equal(Anuncio.rango(a), null);
  assert.equal(Anuncio.resumen(a), null);
});

test('una propiedad con varios anuncios dice cuántos y entre qué precios', () => {
  const a = Anuncio.de(fila({ propiedad: 'inmuebles24:9', anuncios: 12, anunciantes: 8,
    fuentes: ['inmuebles24', 'lamudi'], precio_min: 115500000, precio_max: 137500000 }));
  assert.deepEqual(plano(Anuncio.rango(a)), { min: 115500000, max: 137500000 });
  assert.equal(Anuncio.resumen(a), '12 anuncios · 8 anunciantes');
});

test('el mismo corredor en dos portales no presume anunciantes ni rango', () => {
  const a = Anuncio.de(fila({ anuncios: 2, anunciantes: 1, precio_min: null, precio_max: null }));
  assert.equal(Anuncio.resumen(a), '2 anuncios');
  assert.equal(Anuncio.rango(a), null);
});

test('terreno y construcción salen los dos aunque traigan el mismo número', () => {
  const sup = vm.runInContext('superficies', ctx);
  assert.deepEqual(plano(sup(800, 800, 800)), [['Terreno', 800], ['Construcción', 800]]);
  assert.deepEqual(plano(sup(800, 500, 800)), [['Terreno', 800], ['Construcción', 500]]);
  assert.deepEqual(plano(sup(800, null, 800)), [['Terreno', 800]]);
  assert.deepEqual(plano(sup(null, 500, 500)), [['Construcción', 500]]);
  assert.deepEqual(plano(sup(null, null, 300)), [['Superficie', 300]]);
  assert.deepEqual(plano(sup(null, null, null)), []);
});

test('los atributos salen en texto y en el orden de la API', () => {
  const a = Anuncio.de(fila({ atributos: [{ clave: 'altura', valor: 9.5 }, { clave: 'andenes', valor: true },
    { clave: 'cajones', valor: 1200 }, { clave: 'desconocido', valor: 1 }] }));
  assert.deepEqual(plano(Anuncio.datos(a).map(d => [d.clave, d.etiqueta, d.texto])),
    [['altura', 'Altura libre', '9.5 m'], ['andenes', 'Andenes', 'Sí'], ['cajones', 'Cajones', '1,200']]);
  assert.deepEqual(plano(Anuncio.datos(Anuncio.de(fila()))), []);
});

test('una rebaja gana a reciente; sin ninguna de las dos no hay insignia', () => {
  const baja = { pct: 8, antes: 100000, fecha: '2026-10-20T00:00:00+00:00' };
  assert.equal(Anuncio.insignia(Anuncio.de(fila({ baja, reciente: true }))).texto, 'Bajó 8%');
  assert.equal(Anuncio.insignia(Anuncio.de(fila({ baja }))).detalle, 'Antes $100,000');
  assert.equal(Anuncio.insignia(Anuncio.de(fila({ reciente: true }))).texto, 'Reciente');
  assert.equal(Anuncio.insignia(Anuncio.de(fila())), null);
});

test('el tiempo en el mercado se dice en la unidad que cabe', () => {
  const ahora = new Date('2026-10-30T12:00:00Z');
  const hace = d => Anuncio.tiempoEnMercado(Anuncio.de(fila({ desde: new Date(ahora - d * 864e5).toISOString() })), ahora);
  assert.equal(hace(0), '1 d');
  assert.equal(hace(12), '12 d');
  assert.equal(hace(150), '5 meses');
  assert.equal(hace(800), '2 años');
  assert.equal(Anuncio.tiempoEnMercado(Anuncio.de(fila()), ahora), null);
});

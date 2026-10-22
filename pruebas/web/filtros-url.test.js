// Pruebas de web/filtros-url.js. Corren con `npm run probar:web`. Se carga igual que
// en el navegador: un script clásico en un contexto, sin `module.exports`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({ URLSearchParams });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../web/filtros-url.js'), 'utf8'), ctx, { filename: 'filtros-url.js' });
const FiltrosURL = vm.runInContext('FiltrosURL', ctx);
const plano = v => JSON.parse(JSON.stringify(v));

const VAL = { tipos: ['oficina', 'local', 'bodega', 'terreno'], ordenes: ['recientes', 'precio_asc', 'precio_desc', 'm2_desc'],
              estados: ['Todos', 'Nuevo', 'Revisado', 'Contactado', 'Rentado', 'Descartado'] };

const vacio = { tab: 'bolsa', q: '', calle: '', operacion: '', fuente: '', precio_min: '', precio_max: '',
  m2_min: '', m2_max: '', m2_de: '', ppm_min: '', ppm_max: '', near: '', near_txt: '', radio: 2000,
  orden: 'recientes', lugares: [], tipos: [], etapas: [], pcliente: '', asesor: '', cliente: '',
  estado: 'Todos', destacados: false, pagina: 1, mapa: null };

test('un tablero sin filtros deja la URL limpia', () => {
  assert.equal(FiltrosURL.escribir(vacio), '');
});

test('una búsqueda completa sobrevive la ida y la vuelta', () => {
  const e = { ...vacio, q: 'valle oriente', operacion: 'rent', precio_max: '60000', m2_min: '120', m2_de: 'construccion',
    lugares: [{ valor: 'm40', nombre: 'Monterrey', estado: 'Nuevo León' }, { valor: 'm19', nombre: 'San Pedro Garza García', estado: 'Nuevo León' }],
    tipos: ['local', 'oficina'], orden: 'precio_asc', estado: 'Contactado', destacados: true, pagina: 3 };
  const r = plano(FiltrosURL.leer(FiltrosURL.escribir(e), VAL));
  assert.deepEqual(r, { q: 'valle oriente', operacion: 'rent', precio_max: '60000', m2_min: '120', m2_de: 'construccion',
    lugares: e.lugares, tipos: ['local', 'oficina'], orden: 'precio_asc', estado: 'Contactado', destacados: true, pagina: 3 });
});

test('la vista del mapa viaja como cámara y no como filtro de cercanía', () => {
  const qs = FiltrosURL.escribir({ ...vacio, near: '25.66, -100.36', near_txt: 'el centro del mapa', mapa: { lat: 25.66012, lng: -100.36, zoom: 12.5 } });
  assert.ok(!qs.includes('near'));
  assert.deepEqual(plano(FiltrosURL.leer(qs, VAL)), { mapa: { lat: 25.66012, lng: -100.36, zoom: 12.5 } });
});

test('un punto puesto a mano conserva su nombre y su radio', () => {
  const qs = FiltrosURL.escribir({ ...vacio, near: '25.65, -100.40', near_txt: 'Torre Koi', radio: 3000 });
  assert.deepEqual(plano(FiltrosURL.leer(qs, VAL)), { near: '25.65, -100.40', near_txt: 'Torre Koi', radio: 3000 });
});

test('el m² de terreno o construcción sólo se escribe si hay un rango de m²', () => {
  assert.equal(FiltrosURL.escribir({ ...vacio, m2_de: 'terreno' }), '');
});

test('la pestaña y el cliente que ya existían se conservan', () => {
  const qs = FiltrosURL.escribir({ ...vacio, tab: 'inmobiliaria', pcliente: '42', asesor: 'ana', etapas: ['presentado', 'aprobado'] });
  assert.equal(new URLSearchParams(qs).get('tab'), 'inmobiliaria');
  assert.deepEqual(plano(FiltrosURL.leer(qs, VAL)), { pcliente: '42', asesor: 'ana', etapas: ['presentado', 'aprobado'] });
});

test('lo que no es válido se ignora en vez de romper el tablero', () => {
  const r = plano(FiltrosURL.leer('precio_min=abc&operacion=trueque&tipo=castillo&tipo=local&orden=azar&estado=Vendido' +
    '&pagina=-2&radio=999999&near=25.6,-100.3&mapa=999,0,3&destacados=si&m2_de=aire', VAL));
  assert.deepEqual(r, { tipos: ['local'], near: '25.6,-100.3', radio: 12000 });
});

test('un nombre de lugar sin separador usa el valor como nombre', () => {
  assert.deepEqual(plano(FiltrosURL.leer('lugar=m40', VAL)), { lugares: [{ valor: 'm40', nombre: 'm40', estado: '' }] });
});

test('los textos con acentos y espacios llegan intactos', () => {
  const qs = FiltrosURL.escribir({ ...vacio, q: 'Av. Constitución & Zaragoza', calle: 'José Benítez' });
  assert.deepEqual(plano(FiltrosURL.leer(qs, VAL)), { q: 'Av. Constitución & Zaragoza', calle: 'José Benítez' });
});

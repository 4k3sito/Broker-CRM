// Pruebas de web/fotos.js (`npm run probar:web`): las reglas de las fotos de una
// propiedad que no necesitan navegador. Reducir la imagen, arrastrar y pegar se
// verifican en pantalla. Se carga como lo carga la página (ver anuncio.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({ File });
for (const f of ['texto.js', 'fotos.js'])
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../web', f), 'utf8'), ctx, { filename: f });
const Fotos = vm.runInContext('Fotos', ctx);
const plano = v => JSON.parse(JSON.stringify(v));

const archivo = (name, type, size = 1000) => ({ name, type, size });
const JPG = archivo('frente.jpg', 'image/jpeg'), PNG = archivo('plano.png', 'image/png');

// Un destino de mentira: anota lo que le piden en el orden en que se lo piden.
function destino(extra = {}) {
  const pasos = [];
  return { pasos,
    alEmpezar: n => pasos.push(`empieza ${n}`),
    preparar: async () => pasos.push('prepara'),
    subir: async a => pasos.push(`sube ${a.name}`),
    alTerminar: () => pasos.push('termina'),
    ...extra };
}
const sinReducir = { reducir: async f => f };

test('sólo se aceptan imágenes JPG, PNG, WEBP o GIF', () => {
  const lista = [JPG, PNG, archivo('a.webp', 'image/webp'), archivo('a.gif', 'image/gif'),
    archivo('predial.pdf', 'application/pdf'), archivo('logo.svg', 'image/svg+xml'), archivo('x', '')];
  assert.deepEqual(plano(Fotos.aceptadas(lista).map(f => f.name)), ['frente.jpg', 'plano.png', 'a.webp', 'a.gif']);
});

test('una liga de foto empieza con http o https; se pueden pegar varias', () => {
  assert.deepEqual(plano(Fotos.ligas(' https://x.mx/a.jpg\nhttp://y.mx/b.png  ')), ['https://x.mx/a.jpg', 'http://y.mx/b.png']);
  assert.deepEqual(plano(Fotos.ligas('x.mx/a.jpg javascript:alert(1) /api/me')), []);
  assert.deepEqual(plano(Fotos.ligas(null)), []);
});

test('quitar una foto y ponerla de portada devuelven la lista nueva sin tocar la que había', () => {
  const lista = ['a', 'b', 'c'];
  assert.deepEqual(plano(Fotos.sin(lista, 1)), ['a', 'c']);
  assert.deepEqual(plano(Fotos.dePortada(lista, 2)), ['c', 'a', 'b']);
  assert.deepEqual(lista, ['a', 'b', 'c']);
});

test('las fotos se suben una por una, en orden, entre el aviso de inicio y el de fin', async () => {
  const d = destino(), avisos = [];
  await Fotos.subir([JPG, archivo('predial.pdf', 'application/pdf'), PNG], d, { ...sinReducir, avisar: m => avisos.push(m) });
  assert.deepEqual(d.pasos, ['empieza 2', 'prepara', 'sube frente.jpg', 'sube plano.png', 'termina']);
  assert.deepEqual(avisos, []);
});

test('si nada de lo que se soltó es una imagen, se avisa y no se sube nada', async () => {
  const d = destino(), avisos = [];
  await Fotos.subir([archivo('predial.pdf', 'application/pdf')], d, { ...sinReducir, avisar: m => avisos.push(m) });
  assert.deepEqual(d.pasos, []);
  assert.deepEqual(avisos, ['Sólo se pueden subir imágenes JPG, PNG, WEBP o GIF.']);
});

test('se sube la foto ya reducida, no la original', async () => {
  const d = destino();
  await Fotos.subir([JPG], d, { reducir: async f => archivo('frente-chica.jpg', f.type), avisar: () => {} });
  assert.deepEqual(d.pasos, ['empieza 1', 'prepara', 'sube frente-chica.jpg', 'termina']);
});

test('una foto que pasa del tope se avisa y se salta; las demás suben', async () => {
  const d = destino(), avisos = [];
  const enorme = archivo('dron.png', 'image/png', Fotos.MAX_ARCHIVO + 1);
  await Fotos.subir([enorme, JPG], d, { ...sinReducir, avisar: m => avisos.push(m) });
  assert.deepEqual(d.pasos, ['empieza 2', 'prepara', 'sube frente.jpg', 'termina']);
  assert.deepEqual(avisos, ['"dron.png" pesa 20.0 MB y el máximo por archivo es 20.0 MB.']);
});

test('si una subida falla se avisa, no se intentan las que faltan y aun así se termina', async () => {
  const avisos = [];
  const d = destino({ subir: async a => { if (a.name === 'frente.jpg') throw new Error('sin red'); d.pasos.push(`sube ${a.name}`); } });
  await Fotos.subir([JPG, PNG], d, { ...sinReducir, avisar: m => avisos.push(m) });
  assert.deepEqual(d.pasos, ['empieza 2', 'prepara', 'termina']);
  assert.deepEqual(avisos, ['No se pudo subir la foto: sin red']);
});

test('una captura pegada recibe nombre propio; un archivo con nombre lo conserva', () => {
  const pegado = { clipboardData: { files: [new File(['x'], 'image.png', { type: 'image/png' }),
    new File(['x'], 'image.png', { type: 'image/png' }), new File(['x'], 'fachada.jpg', { type: 'image/jpeg' }),
    new File(['x'], 'notas.txt', { type: 'text/plain' })] } };
  const nombres = Fotos.pegadas(pegado).map(f => f.name);
  assert.equal(nombres.length, 3);
  assert.match(nombres[0], /^captura-\d{4}-\d\d-\d\d-\d\d-\d\d\.png$/);
  assert.match(nombres[1], /^captura-.*-2\.png$/);
  assert.equal(nombres[2], 'fachada.jpg');
});

test('la caja enseña la portada marcada, y sólo las demás pueden subir a portada', () => {
  const html = Fotos.caja(['https://x.mx/a.jpg', '/api/archivos/0b0e3c1a-1111-4222-8333-444455556666', 'javascript:alert(1)']);
  assert.equal((html.match(/class="fx-thumb[ "]/g) ?? []).length, 3);
  assert.equal((html.match(/class="fx-thumb portada"/g) ?? []).length, 1);
  assert.equal((html.match(/class="foto-top"/g) ?? []).length, 2);
  assert.equal((html.match(/class="foto-del"/g) ?? []).length, 3);
  assert.ok(html.includes('la primera es la portada'));
  assert.ok(!html.includes('javascript:'), 'una liga que no es de foto no llega a un src');
});

test('la caja vacía lo dice, y mientras sube dice cuántas', () => {
  assert.ok(Fotos.caja([]).includes('aún no hay'));
  assert.ok(!Fotos.caja([]).includes('fx-thumbs'));
  assert.ok(Fotos.caja([], { subiendo: 1 }).includes('Subiendo 1 foto&#8230;'));
  assert.ok(Fotos.caja([], { subiendo: 3 }).includes('Subiendo 3 fotos&#8230;'));
});

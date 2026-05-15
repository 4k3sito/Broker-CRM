'use strict';
const fs   = require('fs');
const path = require('path');

// ── Cargar .env ───────────────────────────────────────────────────────────
const envFile = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf-8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq < 1) return;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !process.env[key]) process.env[key] = val;
  });
}

const API_KEY = process.env.EASYBROKER_API_KEY;
if (!API_KEY) {
  console.error('Error: EASYBROKER_API_KEY no encontrada. Crea un archivo .env con esa variable.');
  process.exit(1);
}

const BASE     = 'https://api.easybroker.com/v1';
const OUTPUT   = path.resolve(__dirname, '..', 'listings.json');
const PER_PAGE = 50;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function apiFetch(url) {
  const res = await fetch(url, {
    headers: { 'X-Authorization': API_KEY, 'Content-Type': 'application/json' },
  });
  if (res.status === 401) { console.error('\nAPI Key inválida o sin permisos.'); process.exit(1); }
  if (!res.ok) throw new Error(`Error API ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Obtener lista paginada ────────────────────────────────────────────────
async function fetchAllBasic() {
  const all = [];
  let page = 1, totalPages = 4;

  do {
    const qs   = new URLSearchParams({ page: String(page), limit: String(PER_PAGE) });
    const data = await apiFetch(`${BASE}/properties?${qs}`);
    const items = data.content ?? [];

    if (page === 1) {
      const total = data.pagination?.total ?? items.length;
      totalPages  = Math.ceil(total / PER_PAGE);
      console.log(`Total en la cuenta: ${total} propiedades — ${totalPages} página(s)\n`);
    }

    all.push(...items);
    process.stdout.write(`\rPágina ${page}/${totalPages} — ${items.length} props (acum: ${all.length})   `);
    page++;
    if (page <= totalPages) await sleep(300);
  } while (page <= totalPages);

  console.log('\n');
  return all;
}

// ── Obtener detalle individual (url + todas las fotos) ────────────────────
async function fetchDetail(publicId) {
  return apiFetch(`${BASE}/properties/${publicId}`);
}

// ── Mapear a nuestro schema ───────────────────────────────────────────────
function mapListing(basic, detail) {
  const src = detail ?? basic;

  const rental  = (src.operations ?? basic.operations ?? []).find(op => op.type === 'rental');
  const precio  = rental
    ? { monto: rental.amount, moneda: 'MN' }
    : null;

  // Fotos: del detalle si hay, si no la imagen principal del list
  const fotos = detail?.property_images?.length
    ? detail.property_images.map(i => i.url).filter(Boolean)
    : [basic.title_image_full].filter(Boolean);

  return {
    id:        basic.public_id,
    fuente:    'easybroker',
    titulo:    (src.title ?? '').trim(),
    precio,
    direccion: src.location ?? basic.location ?? '',
    fotos,
    url:       src.url ?? '',
    whatsapp:  null,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('\nObteniendo propiedades desde EasyBroker...\n');

  const basic = await fetchAllBasic();

  console.log(`Obteniendo detalle (URL + fotos) de ${basic.length} propiedades...\n`);
  const listings = [];

  for (let i = 0; i < basic.length; i++) {
    const b = basic[i];
    process.stdout.write(`\r[${i + 1}/${basic.length}] ${b.public_id}   `);

    let detail = null;
    try {
      detail = await fetchDetail(b.public_id);
      await sleep(150); // respetar rate limit (20 req/s)
    } catch (e) {
      process.stdout.write(` (sin detalle: ${e.message})`);
    }

    listings.push(mapListing(b, detail));
  }

  console.log('\n');

  // ── Merge con listings.json existente ────────────────────────────────
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(OUTPUT, 'utf-8')); } catch { /* primer run */ }

  // Marcar i24 que no tengan fuente
  existing = existing.map(l => l.fuente ? l : { ...l, fuente: 'inmuebles24' });

  // Upsert: EB siempre se actualiza (precio/fotos pueden cambiar)
  const map = new Map(existing.map(l => [l.id, l]));
  for (const l of listings) map.set(l.id, l);

  const merged = Array.from(map.values());
  fs.writeFileSync(OUTPUT, JSON.stringify(merged, null, 2), 'utf-8');

  const cEB  = merged.filter(l => l.fuente === 'easybroker').length;
  const cI24 = merged.filter(l => l.fuente === 'inmuebles24').length;
  console.log(`Guardados ${merged.length} listings únicos → ${OUTPUT}`);
  console.log(`  EasyBroker: ${cEB}  |  Inmuebles24: ${cI24}\n`);
}

main().catch(err => { console.error('\n' + err.message); process.exit(1); });

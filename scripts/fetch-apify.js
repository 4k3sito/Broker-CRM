'use strict';
const fs   = require('fs');
const path = require('path');
const { ApifyClient } = require('apify-client');

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

const API_TOKEN = process.env.APIFY_API_TOKEN;
if (!API_TOKEN) {
  console.error('Error: APIFY_API_TOKEN no encontrada. Agrega APIFY_API_TOKEN=... a tu archivo .env');
  process.exit(1);
}

const ACTORS = require('./apify-actors.config');
const OUTPUT = path.resolve(__dirname, '..', 'listings.json');

const client = new ApifyClient({ token: API_TOKEN });

async function runActor(actorConfig) {
  const { actorId, label, fuente, input, mapItem } = actorConfig;
  console.log(`\n── ${label} ──`);
  console.log(`   Actor: ${actorId}`);

  // Inicia el run y espera a que termine (equivalente al .call() de la doc)
  const run = await client.actor(actorId).call(input);
  console.log(`   Run: ${run.id} | Estado: ${run.status}`);

  // Descarga los items del dataset de resultados
  const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit: 9999 });
  console.log(`   ${items.length} items descargados`);

  const listings = [];
  for (const item of items) {
    try {
      const mapped = mapItem(item, fuente);
      if (mapped?.id && mapped?.fuente) listings.push(mapped);
    } catch {
      // item individual malformado — continuar
    }
  }

  console.log(`   ${listings.length} propiedades válidas`);
  return listings;
}

async function main() {
  console.log('\nObteniendo propiedades desde Apify...\n');

  const actores = ACTORS.filter(a => !a.disabled);
  if (actores.length === 0) {
    console.log('No hay actores activos. Edita scripts/apify-actors.config.js');
    return;
  }

  const allNew = [];
  for (const cfg of actores) {
    try {
      const listings = await runActor(cfg);
      allNew.push(...listings);
    } catch (e) {
      console.error(`\n   Error en "${cfg.label}": ${e.message}`);
    }
  }

  if (allNew.length === 0) {
    console.log('\nNo se obtuvieron propiedades de ningún actor.');
    return;
  }

  // ── Merge con listings.json existente ─────────────────────────────────────
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(OUTPUT, 'utf-8')); } catch { /* primer run */ }

  const map = new Map(existing.map(l => [l.id, l]));
  for (const l of allNew) map.set(l.id, l);

  const merged = Array.from(map.values());
  fs.writeFileSync(OUTPUT, JSON.stringify(merged, null, 2), 'utf-8');

  // ── Resumen ───────────────────────────────────────────────────────────────
  const counts = {};
  for (const l of merged) counts[l.fuente] = (counts[l.fuente] ?? 0) + 1;

  console.log(`\nGuardados ${merged.length} listings únicos → ${OUTPUT}`);
  for (const [fuente, count] of Object.entries(counts)) {
    console.log(`  ${fuente}: ${count}`);
  }
  console.log('');
}

main().catch(err => { console.error('\n' + err.message); process.exit(1); });

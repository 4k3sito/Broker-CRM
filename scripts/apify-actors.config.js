'use strict';

/**
 * Actores de Apify configurados para OfficeScrapper.
 *
 * Schema de salida esperado por OfficeScrapper:
 *   { id, fuente, titulo, precio, direccion, fotos, url, whatsapp }
 *
 * Para agregar más actores: copia un bloque, ajusta actorId, input y mapItem.
 * Para deshabilitar un actor sin borrarlo: agrega  disabled: true
 */

module.exports = [

  // ── Inmuebles24 ───────────────────────────────────────────────────────────
  // Actor: fatihtahta/inmuebles24-scraper
  // Ventajas vs scraper Playwright anterior:
  //   - Obtiene número de WhatsApp del publicador
  //   - Título real de la propiedad (antes quedaba vacío)
  //   - Sin problemas de Cloudflare
  // Costo: ~$1.50 USD por cada 1,000 resultados
  {
    actorId: 'fatihtahta/inmuebles24-scraper',
    label:   'Inmuebles24',
    fuente:  'inmuebles24',

    input: {
      location:      ['Monterrey'],
      deal_type:     'rent',
      property_type: ['commercial_space'],
      sort_by:       'most_relevant',
      limit:         150,
    },

    mapItem(item, fuente) {
      // Precio: busca la operación de Renta, toma el primer precio
      const ops    = item.pricing?.operations ?? [];
      const rental = ops.find(op => op.operation_type?.name === 'Renta') ?? ops[0];
      const p      = rental?.prices?.[0] ?? null;
      const precio = p ? { monto: p.amount, moneda: p.currency === 'USD' ? 'USD' : 'MN' } : null;

      // Fotos: ordenadas por index, usa URL en tamaño large
      const pics  = (item.media?.pictures ?? []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const fotos = pics.length
        ? pics.map(pic => pic.large ?? pic.url ?? '').filter(Boolean)
        : [item.media?.primary_image_url].filter(Boolean);

      // Dirección: address directo o compuesto desde jerarquía geográfica
      const hier      = item.location?.hierarchy ?? [];
      const zone      = hier.find(h => h.type === 'zone')?.name ?? '';
      const city      = hier.find(h => h.type === 'city')?.name ?? '';
      const direccion = str(item.location?.address?.name) || [zone, city].filter(Boolean).join(', ');

      return {
        id:        String(item.id),   // mismo formato que el scraper Playwright anterior
        fuente,
        titulo:    str(item.generated_title ?? item.title),
        precio,
        direccion,
        fotos,
        url:       str(item.url),
        whatsapp:  item.contact?.whatsapp ?? null,
      };
    },
  },

  // ── Lamudi México ─────────────────────────────────────────────────────────
  // Descomentalo cuando tengas el actorId de apify.com/store?q=lamudi
  // {
  //   actorId: 'REEMPLAZA_CON_ACTOR_ID_LAMUDI',
  //   label:   'Lamudi México',
  //   fuente:  'lamudi',
  //   input: {
  //     startUrls: [{ url: 'https://www.lamudi.com.mx/comercial/renta/?search%5Bstate%5D=Nuevo+Le%C3%B3n' }],
  //     maxItems: 200,
  //   },
  //   mapItem(item, fuente) {
  //     return {
  //       id:        `lamudi_${item.id ?? slugify(item.url)}`,
  //       fuente,
  //       titulo:    str(item.title ?? item.name ?? item.propertyType),
  //       precio:    parsePrecio(item.price ?? item.rentPrice),
  //       direccion: str(item.address ?? item.location),
  //       fotos:     toPhotoArray(item.images ?? item.photos),
  //       url:       str(item.url),
  //       whatsapp:  null,
  //     };
  //   },
  // },

];

// ── Helpers compartidos ───────────────────────────────────────────────────

function str(val) {
  return (val != null ? String(val) : '').trim();
}

function parsePrecio(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return { monto: raw, moneda: 'MN' };
  const s = String(raw).replace(/[$,\s]/g, '');
  const monto = parseFloat(s);
  if (isNaN(monto)) return null;
  const moneda = /USD|dol/i.test(String(raw)) ? 'USD' : 'MN';
  return { monto, moneda };
}

function toPhotoArray(val) {
  if (!val) return [];
  if (typeof val === 'string') return val ? [val] : [];
  if (Array.isArray(val)) {
    return val
      .map(v => (typeof v === 'string' ? v : (v?.url ?? v?.src ?? v?.href ?? '')))
      .filter(Boolean);
  }
  return [];
}

function slugify(url) {
  return String(url ?? '').replace(/[^a-z0-9]/gi, '_').slice(0, 60) || 'unknown';
}

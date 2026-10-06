// Pestañas de navegación, compartidas por todas las páginas. Sustituye al menú
// hamburguesa: la navegación vive siempre visible en la topbar. Se inyecta desde
// aquí para no repetir el marcado en cada HTML.
(() => {
  const TABS = [
    // Dos pestañas sobre la misma página (index.html): la ficha y comparar se marcan
    // con la pestaña de la que se vino, que app.js deja en sessionStorage.
    { href: 'index.html',                  label: 'Bolsa Inmobiliaria', de: ['index.html', 'listing.html', 'comparar.html', ''], tab: 'bolsa' },
    { href: 'index.html?tab=inmobiliaria', label: 'Catálogo',           de: ['index.html', 'listing.html', 'comparar.html', ''], tab: 'inmobiliaria' },
    { href: 'clientes.html', label: 'Clientes',  de: ['clientes.html'] },
    { href: 'tareas.html',   label: 'Tareas',    de: ['tareas.html'], badge: 'tareas' },
    { href: 'scrapers.html', label: 'Scrapers',  de: ['scrapers.html'] },
  ];
  const aqui = location.pathname.split('/').pop();
  let tab = new URLSearchParams(location.search).get('tab') === 'inmobiliaria' ? 'inmobiliaria' : 'bolsa';
  if (aqui !== 'index.html' && aqui !== '') {
    try { tab = sessionStorage.getItem('ol-tab') === 'inmobiliaria' ? 'inmobiliaria' : 'bolsa'; } catch { /* sin persistencia */ }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const topbar = document.querySelector('.topbar');
    if (!topbar) return;
    topbar.querySelector('.topbar-nav')?.remove();
    const nav = document.createElement('nav');
    nav.className = 'topbar-nav';
    nav.setAttribute('aria-label', 'Secciones');
    nav.innerHTML = TABS.map(t => {
      const on = t.de.includes(aqui) && (!t.tab || t.tab === tab);
      return `<a href="${t.href}"${on ? ' class="active" aria-current="page"' : ''}>${t.label}` +
             (t.badge ? `<span class="tb-badge" data-badge="${t.badge}" hidden></span>` : '') + `</a>`;
    }).join('');
    const brand = topbar.querySelector('.brand-group');
    brand ? brand.after(nav) : topbar.prepend(nav);

    // Avatar con iniciales junto a "Salir". Silencioso si no hay sesión.
    API.me().then(u => {
      const nombre = (u.nombre || u.email || '').trim();
      const ini = nombre.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
      const box = document.getElementById('userBox');
      if (box && !document.querySelector('.tb-ava')) {
        const ava = document.createElement('span');
        ava.className = 'tb-ava';
        ava.title = u.email ?? '';
        ava.textContent = ini;
        // En el teléfono "Salir" se esconde (hermes.css, ≤560 px) y el avatar es
        // la única salida: tocarlo ofrece cerrar la sesión.
        ava.addEventListener('click', () => {
          if (confirm('¿Cerrar sesión?')) document.getElementById('logout-btn')?.click();
        });
        box.prepend(ava);
      }
    }).catch(() => {});

    // Insignia de tareas vencidas. Si el endpoint falla, simplemente no aparece.
    const b = nav.querySelector('[data-badge="tareas"]');
    if (b && aqui !== 'login.html') {
      API.get('/tareas').then(ts => {
        const hoy = new Date().toISOString().slice(0, 10);
        const n = (ts ?? []).filter(t => t.vence_el && t.vence_el < hoy && t.columna !== 'completado').length;
        if (n) { b.textContent = n; b.hidden = false; b.title = `${n} vencidas`; }
      }).catch(() => {});
    }
  });
})();

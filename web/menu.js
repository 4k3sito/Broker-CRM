// Pestañas de navegación, compartidas por todas las páginas. En escritorio viven
// siempre visibles en la topbar; en el teléfono (≤900 px, hermes.css) no caben y
// las sustituye un botón «Menú» que abre una hoja inferior con los mismos enlaces.
// Se inyecta desde aquí para no repetir el marcado en cada HTML.
(() => {
  const TABS = [
    // Dos pestañas sobre la misma página (index.html): la ficha y comparar se marcan
    // con la pestaña de la que se vino, que app.js deja en sessionStorage.
    { href: 'index.html',                  label: 'Bolsa Inmobiliaria', de: ['index.html', 'listing.html', 'comparar.html', ''], tab: 'bolsa' },
    { href: 'index.html?tab=inmobiliaria', label: 'Catálogo',           de: ['index.html', 'listing.html', 'comparar.html', ''], tab: 'inmobiliaria' },
    { href: 'duplicados.html', label: 'Duplicados', de: ['duplicados.html'] },
    { href: 'clientes.html', label: 'Clientes',  de: ['clientes.html'] },
    { href: 'tareas.html',   label: 'Tareas',    de: ['tareas.html'], badge: 'tareas' },
  ];
  // Scrapers no está en la lista: sólo la ven las cuentas que la API marca con
  // `scrapers` en /me, y se agrega abajo cuando eso contesta.
  const SCRAPERS = { href: 'scrapers.html', label: 'Scrapers', de: ['scrapers.html'] };
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
    const enlace = t => {
      const on = t.de.includes(aqui) && (!t.tab || t.tab === tab);
      return `<a href="${t.href}"${on ? ' class="active" aria-current="page"' : ''}>${t.label}` +
             (t.badge ? `<span class="tb-badge" data-badge="${t.badge}" hidden></span>` : '') + `</a>`;
    };
    nav.innerHTML = TABS.map(enlace).join('');
    const brand = topbar.querySelector('.brand-group');
    brand ? brand.after(nav) : topbar.prepend(nav);

    // La hoja del teléfono. Un <dialog> modal trae gratis el foco atrapado, Escape y
    // el fondo; los enlaces se copian de la barra para que las dos digan lo mismo
    // (insignia de tareas y Scrapers incluidos, que llegan después).
    const btn = document.createElement('button');
    btn.className = 'nav-menu';
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>Menú';
    nav.after(btn);
    const hoja = document.createElement('dialog');
    hoja.className = 'nav-hoja';
    hoja.setAttribute('aria-label', 'Secciones');
    hoja.innerHTML = `<div class="nav-hoja-head"><span>Secciones</span>
        <button type="button" class="nav-hoja-x" aria-label="Cerrar menú">&times;</button></div>
      <nav class="nav-hoja-lista"></nav>
      <div class="nav-hoja-pie" hidden><span class="nav-hoja-quien"></span>
        <button type="button" class="nav-hoja-salir">Cerrar sesión</button></div>`;
    document.body.appendChild(hoja);
    const lista = hoja.querySelector('.nav-hoja-lista');
    const copiar = () => { lista.innerHTML = nav.innerHTML; };
    copiar();
    new MutationObserver(copiar).observe(nav, { childList: true, subtree: true, characterData: true, attributes: true });
    btn.addEventListener('click', () => hoja.showModal());
    hoja.querySelector('.nav-hoja-x').addEventListener('click', () => hoja.close());
    // Tocar el fondo cierra: el clic cae en el propio <dialog>, fuera de su contenido.
    hoja.addEventListener('click', e => { if (e.target === hoja) hoja.close(); });
    hoja.querySelector('.nav-hoja-salir').addEventListener('click', () => {
      hoja.close();
      document.getElementById('logout-btn')?.click();
    });

    // Avatar con iniciales junto a "Salir". Silencioso si no hay sesión.
    API.me().then(u => {
      if (u.scrapers) nav.insertAdjacentHTML('beforeend', enlace(SCRAPERS));
      const nombre = (u.nombre || u.email || '').trim();
      const ini = nombre.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
      hoja.querySelector('.nav-hoja-quien').textContent = nombre;
      hoja.querySelector('.nav-hoja-pie').hidden = !document.getElementById('logout-btn');
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

// Menú lateral, compartido por todas las páginas. Se inyecta desde aquí en vez de
// repetir el mismo marcado en seis archivos HTML: el día que cambie una entrada,
// cambia en un solo lugar.
//
// El botón se cuelga al principio de la topbar; el cajón entra desde la izquierda.
(() => {
  const ITEMS = [
    { href: 'index.html',    label: 'Propiedades', hint: 'Catálogo e inventario',
      d: 'M3 21V7l9-4 9 4v14M9 22V12h6v10' },
    { href: 'clientes.html', label: 'Clientes',    hint: 'Cartera y procesos',
      d: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8' },
    { href: 'tareas.html',   label: 'Tareas',      hint: 'Tablero del equipo',
      d: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11' },
    { href: 'scrapers.html', label: 'Scrapers',    hint: 'Salud del inventario',
      d: 'M4 4h16v6H4zM4 14h16v6H4M8 7h.01M8 17h.01' },
    { href: '',              label: 'Reportes',    hint: 'Actividad y cierre', soon: true,
      d: 'M3 3v18h18M7 16V9m5 7V5m5 11v-4' },
  ];

  const aqui = location.pathname.split('/').pop() || 'index.html';

  const drawer = document.createElement('div');
  drawer.className = 'mn';
  drawer.hidden = true;
  drawer.innerHTML = `
    <div class="mn-scrim"></div>
    <nav class="mn-panel" aria-label="Navegación principal">
      <div class="mn-head">
        <svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <rect x="2" y="2" width="28" height="28" stroke="currentColor" stroke-width="2"/>
          <rect x="9" y="9" width="14" height="14" fill="currentColor"/>
          <rect x="13.5" y="13.5" width="5" height="5" fill="var(--topbar)"/>
        </svg>
        <span class="mn-brand"><strong>Office<i>Lab</i></strong><small>Nuevo León</small></span>
        <button class="mn-x" aria-label="Cerrar menú">&times;</button>
      </div>
      <p class="mn-label">Navegación</p>
      <div class="mn-nav">
        ${ITEMS.map(m => `
          <a class="mn-item${m.href === aqui ? ' active' : ''}${m.soon ? ' soon' : ''}"
             href="${m.soon ? '#' : m.href}"${m.soon ? ' aria-disabled="true"' : ''}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${m.d}"/></svg>
            <span class="mn-txt"><strong>${m.label}</strong><small>${m.hint}</small></span>
            ${m.soon ? '<span class="mn-soon">Pronto</span>' : ''}
          </a>`).join('')}
      </div>
      <div class="mn-foot" id="mnFoot"></div>
    </nav>`;

  const abrir = v => {
    drawer.hidden = !v;
    document.body.style.overflow = v ? 'hidden' : '';
  };

  document.addEventListener('DOMContentLoaded', () => {
    const topbar = document.querySelector('.topbar');
    if (!topbar) return;
    const btn = document.createElement('button');
    btn.className = 'mn-btn';
    btn.setAttribute('aria-label', 'Abrir menú');
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>`;
    btn.addEventListener('click', () => abrir(true));
    topbar.prepend(btn);
    document.body.appendChild(drawer);

    drawer.querySelector('.mn-scrim').addEventListener('click', () => abrir(false));
    drawer.querySelector('.mn-x').addEventListener('click', () => abrir(false));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') abrir(false); });

    // El pie muestra quién está dentro. Silencioso si no hay sesión.
    API.me().then(u => {
      const ini = (u.nombre || u.email).trim().split(/\s+/).slice(0, 2)
        .map(w => w[0]).join('').toUpperCase();
      document.getElementById('mnFoot').innerHTML =
        `<span class="mn-ava">${ini}</span>
         <span class="mn-txt"><strong>${u.nombre ?? u.email}</strong><small>${u.email}</small></span>`;
    }).catch(() => {});
  });
})();

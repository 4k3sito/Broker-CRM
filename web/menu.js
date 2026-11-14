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
    // «Revisión» y no «Duplicados»: la página trae también los precios atípicos. La insignia
    // cuenta lo que espera una decisión (ver más abajo).
    { href: 'duplicados.html', label: 'Revisión', de: ['duplicados.html'], badge: 'revision' },
    { href: 'clientes.html', label: 'Clientes',  de: ['clientes.html'] },
    { href: 'tareas.html',   label: 'Tareas',    de: ['tareas.html'], badge: 'tareas' },
  ];
  // Scrapers no está en la lista: sólo la ven las cuentas que la API marca con
  // `scrapers` en /me, y se agrega abajo cuando eso contesta. Esa respuesta tarda, y la
  // pestaña (y las insignias) aparecían después de pintada la barra, moviendo las demás:
  // lo último que /me dijo se recuerda y la pestaña nace ya puesta; las insignias reservan
  // su lugar (hermes.css) aunque estén vacías.
  const SCRAPERS = { href: 'scrapers.html', label: 'Scrapers', de: ['scrapers.html'] };
  const memoria = {
    leer: k => { try { return localStorage.getItem(k); } catch { return null; } },
    poner: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* sin persistencia */ } },
  };
  const aqui = location.pathname.split('/').pop();
  let tab = new URLSearchParams(location.search).get('tab') === 'inmobiliaria' ? 'inmobiliaria' : 'bolsa';
  if (aqui !== 'index.html' && aqui !== '') {
    try { tab = sessionStorage.getItem('ol-tab') === 'inmobiliaria' ? 'inmobiliaria' : 'bolsa'; } catch { /* sin persistencia */ }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const topbar = document.querySelector('.topbar');
    if (!topbar) return;

    // «Saltar al contenido»: lo primero que alcanza el tabulador. No navega a un #ancla
    // porque clientes.js lee el hash como el cliente abierto; enfoca por programa.
    const destino = document.querySelector('main, .tk-shell');
    if (destino) {
      const saltar = document.createElement('a');
      saltar.className = 'saltar';
      saltar.href = '#';
      saltar.textContent = 'Saltar al contenido';
      saltar.addEventListener('click', e => {
        e.preventDefault();
        if (!destino.hasAttribute('tabindex')) destino.setAttribute('tabindex', '-1');
        destino.classList.add('salto-destino');
        destino.focus();
      });
      document.body.prepend(saltar);
    }

    topbar.querySelector('.topbar-nav')?.remove();
    const nav = document.createElement('nav');
    nav.className = 'topbar-nav';
    nav.setAttribute('aria-label', 'Secciones');
    const enlace = t => {
      const on = t.de.includes(aqui) && (!t.tab || t.tab === tab);
      return `<a href="${t.href}"${on ? ' class="active" aria-current="page"' : ''}>${t.label}` +
             (t.badge ? `<span class="tb-badge vacia" data-badge="${t.badge}"></span>` : '') + `</a>`;
    };
    nav.innerHTML = TABS.map(enlace).join('') + (memoria.leer('ol-scrapers') === '1' ? enlace(SCRAPERS) : '');
    // Insignia de una pestaña: vacía (reservada pero invisible) o con la cifra. De mil para
    // arriba se acorta —«3.1k»— para que quepa en el hueco; el título trae la cifra entera.
    const ponerInsignia = (clave, n, titulo) => {
      const b = nav.querySelector(`[data-badge="${clave}"]`);
      if (!b) return;
      b.textContent = n ? (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : n) : '';
      b.title = n ? titulo : '';
      b.classList.toggle('vacia', !n);
    };
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

    // Cerrar sesión vive aquí y no en cada página: antes cada una cableaba su «Salir» (y
    // tareas, además, lo repetía). Sin confirmar: entrar otra vez deshace salir, y el
    // login devuelve a la misma página (`next=`). Si falla la red no se redirige, o la
    // sesión seguiría abierta sin que se note.
    const salir = async boton => {
      const txt = boton?.textContent;
      if (boton) boton.disabled = true;
      try {
        await API.logout();
        location.href = 'login.html';
      } catch {
        if (boton) { boton.disabled = false; boton.textContent = 'No se pudo salir. Reintentar'; setTimeout(() => { boton.textContent = txt; }, 4000); }
      }
    };
    // El «Salir» suelto de cada página queda en el HTML (sus scripts le cuelgan un
    // listener) pero ya no se ve: el avatar tiene el menú de cuenta.
    document.getElementById('logout-btn')?.setAttribute('hidden', '');
    hoja.querySelector('.nav-hoja-salir').addEventListener('click', e => salir(e.currentTarget));

    // Avatar con iniciales y su menú de cuenta. Silencioso si no hay sesión.
    API.me().then(u => {
      if (u.scrapers && !nav.querySelector('[href="scrapers.html"]')) nav.insertAdjacentHTML('beforeend', enlace(SCRAPERS));
      if (!u.scrapers) nav.querySelector('[href="scrapers.html"]')?.remove();
      memoria.poner('ol-scrapers', u.scrapers ? '1' : '');
      const nombre = (u.nombre || u.email || '').trim();
      const ini = nombre.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
      hoja.querySelector('.nav-hoja-quien').textContent = nombre;
      hoja.querySelector('.nav-hoja-pie').hidden = false;
      const box = document.getElementById('userBox');
      if (box && !document.querySelector('.tb-ava')) montarCuenta(box, u, nombre, ini, salir);
      cargarInsignias();
    }).catch(() => {});

    // El avatar abre un menú con lo que de la cuenta se puede hacer. Antes el avatar sólo
    // decía el correo, y «Cambiar contraseña» no estaba enlazada desde ningún lado.
    function montarCuenta(box, u, nombre, ini, salir) {
      const ava = document.createElement('button');
      ava.type = 'button';
      ava.className = 'tb-ava';
      ava.setAttribute('aria-haspopup', 'true');
      ava.setAttribute('aria-expanded', 'false');
      ava.setAttribute('aria-label', `Cuenta de ${nombre}`);
      ava.textContent = ini;
      const panel = document.createElement('div');
      panel.className = 'tb-cuenta';
      panel.setAttribute('role', 'group');
      panel.setAttribute('aria-label', 'Cuenta');
      panel.hidden = true;
      panel.innerHTML = `<div class="tb-cuenta-quien"><strong>${esc(u.nombre || u.email)}</strong>` +
          (u.nombre && u.email ? `<span>${esc(u.email)}</span>` : '') + `</div>
        <a class="tb-cuenta-it" href="update-password.html">Cambiar contraseña</a>
        <button type="button" class="tb-cuenta-it" data-tema></button>
        <button type="button" class="tb-cuenta-it" data-salir>Cerrar sesión</button>`;
      box.prepend(ava);
      box.append(panel);
      const tema = panel.querySelector('[data-tema]');
      const pintarTema = () => {
        tema.textContent = document.documentElement.getAttribute('data-theme') === 'dark'
          ? 'Tema: oscuro · cambiar a claro' : 'Tema: claro · cambiar a oscuro';
      };
      // El interruptor es el de theme.js (guarda la preferencia); aquí sólo se le da otra puerta.
      tema.hidden = !document.querySelector('.th-btn');
      tema.addEventListener('click', () => { document.querySelector('.th-btn')?.click(); pintarTema(); });
      panel.querySelector('[data-salir]').addEventListener('click', e => salir(e.currentTarget));

      const cerrar = devolverFoco => {
        panel.hidden = true;
        ava.setAttribute('aria-expanded', 'false');
        if (devolverFoco) ava.focus();
      };
      ava.addEventListener('click', () => {
        if (!panel.hidden) return cerrar();
        pintarTema();
        panel.hidden = false;
        ava.setAttribute('aria-expanded', 'true');
        panel.querySelector('a, button:not([hidden])').focus();
      });
      document.addEventListener('click', e => { if (!panel.hidden && !box.contains(e.target)) cerrar(); });
      box.addEventListener('focusout', e => { if (e.relatedTarget && !box.contains(e.relatedTarget)) cerrar(); });
      // En captura y deteniendo el evento: la página de abajo (tareas, clientes…) también
      // escucha Esc para cerrar su panel, y no debe cerrarlo al cerrar este menú.
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !panel.hidden) { e.preventDefault(); e.stopPropagation(); cerrar(true); }
      }, true);
    }

    // Insignias. Si un endpoint falla, la insignia simplemente no aparece.
    function cargarInsignias() {
      if (aqui === 'login.html') return;
      // Tareas vencidas (de todo el equipo: no se cambia aquí a «las mías»).
      API.get('/tareas').then(ts => {
        const hoy = hoyLocal();       // fecha local: la UTC marca vencido lo de hoy desde las 18:00
        const n = (ts ?? []).filter(t => t.vence_el && t.vence_el < hoy && t.columna !== 'completado').length;
        ponerInsignia('tareas', n, `${n} ${n === 1 ? 'vencida' : 'vencidas'}`);
      }).catch(() => {});
      // Revisión: lo que espera decisión en Nuevo León, que es donde abre la página. La cifra es
      // la de pares de duplicados (el KPI de la página); el title suma los precios atípicos. Los
      // mismos endpoints que usa duplicados.js (`total`, con una fila por página). En la propia página no se pone: ahí la cifra viva
      // es la suya, y ésta quedaría vieja con cada decisión.
      if (aqui === 'duplicados.html') return;
      const q = API.qs({ estado: 'Nuevo León', per_page: 1 });
      Promise.allSettled([API.get(`/duplicados/sugerencias${q}`), API.get(`/outliers${q}`)]).then(rs => {
        const cuenta = r => r.status === 'fulfilled' ? Number(r.value?.total) || 0 : 0;
        const n = cuenta(rs[0]), m = cuenta(rs[1]);
        ponerInsignia('revision', n, `${mx(n)} ${n === 1 ? 'par' : 'pares'} y ${mx(m)} ${m === 1 ? 'precio atípico' : 'precios atípicos'} por revisar`);
      });
    }
  });
})();

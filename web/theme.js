// Tema claro/oscuro. Va en <head> y SIN defer a propósito: tiene que poner el
// atributo antes del primer paint, o la página parpadea en blanco al recargar.
// No puede ser un <script> inline — la CSP del Caddyfile es `script-src 'self'`.
(() => {
  const raiz = document.documentElement;
  const guardado = (() => {
    try { return localStorage.getItem('ol-theme'); } catch { return null; }  // modo privado
  })();

  const aplicar = oscuro => {
    raiz.setAttribute('data-theme', oscuro ? 'dark' : 'light');
    document.querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', oscuro ? '#160C24' : '#201333');
  };
  // Sin preferencia guardada manda el sistema.
  aplicar(guardado ? guardado === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);

  // El botón se cuelga de la topbar, igual que el del menú: así ninguna página
  // repite el marcado. Login y recuperación no tienen topbar y se quedan sin
  // botón — siguen el tema guardado o el del sistema, que es lo que importa ahí.
  document.addEventListener('DOMContentLoaded', () => {
    const destino = document.querySelector('.topbar-right');
    if (!destino) return;
    const btn = document.createElement('button');
    btn.className = 'th-btn';
    btn.type = 'button';
    // Sólo el glifo: con la pestaña de Scrapers, la topbar de Tareas ya no tiene
    // sitio para una etiqueta. El cuadro medio relleno es el ícono de contraste
    // de siempre y encaja con la marca, que es un cuadro dentro de otro.
    btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" stroke-width="1.6" aria-hidden="true">
      <rect x="1.5" y="1.5" width="13" height="13"/>
      <path d="M8 1.5v13H2.2a.7.7 0 0 1-.7-.7V2.2a.7.7 0 0 1 .7-.7z" fill="currentColor" stroke="none"/>
    </svg>`;
    const pintar = () => {
      const oscuro = raiz.getAttribute('data-theme') === 'dark';
      const t = oscuro ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro';
      btn.title = t;
      btn.setAttribute('aria-label', t);
      btn.setAttribute('aria-pressed', String(oscuro));
    };
    btn.addEventListener('click', () => {
      const oscuro = raiz.getAttribute('data-theme') !== 'dark';
      aplicar(oscuro);
      try { localStorage.setItem('ol-theme', oscuro ? 'dark' : 'light'); } catch { /* no persiste */ }
      pintar();
    });
    pintar();
    // Antes del bloque de sesión: en el mock el orden es filete · conteo · tema · entrar.
    destino.insertBefore(btn, document.getElementById('authBox') ?? destino.firstChild);
  });
})();

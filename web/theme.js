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

  // El único interruptor vive en el menú de cuenta (menu.js), que llama a esta función:
  // cambia el tema, lo guarda y avisa a los mapas. Login y recuperación no tienen menú y
  // se quedan con el tema guardado o el del sistema, que es lo que importa ahí.
  window.OLTema = {
    oscuro: () => raiz.getAttribute('data-theme') === 'dark',
    alternar() {
      const oscuro = !this.oscuro();
      aplicar(oscuro);
      try { localStorage.setItem('ol-theme', oscuro ? 'dark' : 'light'); } catch { /* no persiste */ }
      // Los mapas (MapLibre) traen su propio estilo de teselas y no leen los tokens de CSS:
      // se enteran por este evento y cambian de estilo (mapa.js, ubicacion.js).
      document.dispatchEvent(new CustomEvent('ol-tema', { detail: { oscuro } }));
      return oscuro;
    },
  };
})();

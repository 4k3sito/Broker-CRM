// Diálogo de confirmación y aviso, compartidos por todas las páginas. Sustituyen a
// `confirm()` y `alert()` del navegador, que ui_change.md §5.2 prohíbe: no se pueden
// estilizar, dicen «localhost dice…» y no nombran la acción en el botón.
//
//   await UI.confirmar({ titulo, texto, verbo, peligro })   → true si se aceptó
//   UI.aviso('No se pudo guardar: …')                       → aviso que se cierra solo
//
// `texto` es la consecuencia en cifras («Se borran 3 procesos y 2 fichas»); `verbo` es lo
// que dice el botón («Eliminar», no «Aceptar»). Todo se pinta con textContent: lo que
// venga de un portal o de un cliente no puede inyectar marcado.
const UI = (() => {
  let dlg = null;

  function armar() {
    dlg = document.createElement('dialog');
    dlg.className = 'ui-dlg';
    dlg.innerHTML = `<form method="dialog">
        <h2 class="ui-dlg-t"></h2>
        <p class="ui-dlg-x"></p>
        <div class="ui-dlg-acc">
          <button value="no" class="ui-dlg-no">Cancelar</button>
          <button value="si" class="ui-dlg-si"></button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    // Tocar el fondo es cancelar: el clic cae en el propio <dialog>, fuera del form.
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close('no'); });
  }

  function confirmar({ titulo, texto = '', verbo = 'Aceptar', peligro = false }) {
    if (!dlg) armar();
    dlg.querySelector('.ui-dlg-t').textContent = titulo;
    const x = dlg.querySelector('.ui-dlg-x');
    x.textContent = texto;
    x.hidden = !texto;
    const si = dlg.querySelector('.ui-dlg-si');
    si.textContent = verbo;
    si.classList.toggle('peligro', peligro);
    dlg.returnValue = '';
    dlg.showModal();
    // El foco empieza en Cancelar cuando la acción no se deshace: un Enter de más no borra.
    (peligro ? dlg.querySelector('.ui-dlg-no') : si).focus();
    return new Promise(ok => dlg.addEventListener('close', () => ok(dlg.returnValue === 'si'), { once: true }));
  }

  let caja = null, reloj = 0;
  function aviso(msg) {
    if (!caja) {
      caja = document.createElement('div');
      caja.className = 'ui-aviso';
      caja.setAttribute('role', 'alert');
      caja.innerHTML = '<span></span><button type="button" aria-label="Cerrar aviso">&times;</button>';
      caja.querySelector('button').addEventListener('click', () => { caja.hidden = true; });
      // Se detiene al pasar el ratón: un error largo tiene que poder leerse.
      caja.addEventListener('mouseenter', () => clearTimeout(reloj));
      caja.addEventListener('mouseleave', () => { reloj = setTimeout(() => { caja.hidden = true; }, 3000); });
      document.body.appendChild(caja);
    }
    caja.querySelector('span').textContent = msg;
    caja.hidden = false;
    clearTimeout(reloj);
    reloj = setTimeout(() => { caja.hidden = true; }, 7000);
  }

  return { confirmar, aviso };
})();

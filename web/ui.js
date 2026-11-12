// Diálogo de confirmación y aviso, compartidos por todas las páginas. Sustituyen a
// `confirm()` y `alert()` del navegador, que ui_change.md §5.2 prohíbe: no se pueden
// estilizar, dicen «localhost dice…» y no nombran la acción en el botón.
//
//   await UI.confirmar({ titulo, texto, verbo, peligro })   → true si se aceptó
//   await UI.pedir({ titulo, etiqueta, verbo, valor, placeholder, tipo }) → texto o null
//   UI.aviso('No se pudo guardar: …')                       → aviso que se cierra solo
//   UI.guardar(promesa, { que, revertir })                  → avisa y revierte si falla
//   UI.errorCarga(el, 'No se pudieron cargar …', reintentar) → error con «Reintentar»
//
// `prompt()` también está prohibido por lo mismo: para pedir un nombre o una liga se usa
// UI.pedir, que valida que no venga vacío y dice en el botón lo que va a pasar.
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

  let dlgPedir = null;
  function pedir({ titulo, etiqueta = '', verbo = 'Aceptar', valor = '', placeholder = '', tipo = 'text' }) {
    if (!dlgPedir) {
      dlgPedir = document.createElement('dialog');
      dlgPedir.className = 'ui-dlg';
      dlgPedir.innerHTML = `<form method="dialog">
          <h2 class="ui-dlg-t"></h2>
          <label class="ui-dlg-lbl"><span></span><input class="ui-dlg-in" autocomplete="off"></label>
          <div class="ui-dlg-acc">
            <button value="no" class="ui-dlg-no" formnovalidate>Cancelar</button>
            <button value="si" class="ui-dlg-si"></button>
          </div>
        </form>`;
      document.body.appendChild(dlgPedir);
      dlgPedir.addEventListener('click', e => { if (e.target === dlgPedir) dlgPedir.close('no'); });
    }
    dlgPedir.querySelector('.ui-dlg-t').textContent = titulo;
    const lbl = dlgPedir.querySelector('.ui-dlg-lbl span');
    lbl.textContent = etiqueta;
    lbl.hidden = !etiqueta;
    const inp = dlgPedir.querySelector('.ui-dlg-in');
    inp.type = tipo;
    inp.value = valor;
    inp.placeholder = placeholder;
    inp.required = true;
    dlgPedir.querySelector('.ui-dlg-si').textContent = verbo;
    dlgPedir.returnValue = '';
    dlgPedir.showModal();
    inp.focus();
    inp.select();
    return new Promise(ok => dlgPedir.addEventListener('close', () => {
      const v = inp.value.trim();
      ok(dlgPedir.returnValue === 'si' && v ? v : null);
    }, { once: true }));
  }

  // Un guardado optimista: la pantalla ya muestra el valor nuevo. Si el servidor no lo
  // acepta, se deshace en pantalla y se dice qué no se guardó. Nunca sólo a la consola.
  function guardar(promesa, { que = 'el cambio', revertir } = {}) {
    return Promise.resolve(promesa).then(r => r, err => {
      try { revertir?.(); } catch { /* revertir es de la página */ }
      aviso(`No se guardó ${que}: ${err?.message ?? 'error desconocido'}`);
      throw err;
    });
  }

  // Un fallo de carga no es «no hay datos». Pinta el error donde iba el contenido, con
  // un botón para volver a intentar.
  function errorCarga(el, msg, reintentar) {
    if (!el) return;
    el.innerHTML = '<div class="ui-err" role="alert"><p></p><button type="button" class="btn-clear">Reintentar</button></div>';
    el.querySelector('p').textContent = msg;
    const b = el.querySelector('button');
    if (reintentar) b.addEventListener('click', reintentar); else b.remove();
  }

  return { confirmar, pedir, aviso, guardar, errorCarga };
})();

// Las fotos de una propiedad, como un solo flujo. Se administran en dos sitios —la
// ficha (listing.js) y la fila desplegada de un cliente (clientes.js)— y en los dos es
// lo mismo: una caja con miniaturas donde se sube del equipo, se arrastra, se pega una
// captura con Ctrl+V o se pega una liga; se quita una foto o se pone de portada (la
// primera de la lista).
//
// La página pinta la caja con `Fotos.caja(fotos, …)` y llama una vez a
// `Fotos.escuchar(raiz, destinoDe)`. `destinoDe(caja)` contesta de quién son las fotos
// de esa caja —la ficha, o una ficha PDF— con un objeto así, o null si ahí no se edita:
//
//   fotos()        la lista como está ahora
//   guardar(lista) guarda la lista nueva (quitar, portada y ligas son eso)
//   subir(archivo) sube un archivo ya reducido; la API lo agrega al final
//   preparar()     opcional: lo que haga falta antes de la primera subida
//   alEmpezar(n) / alTerminar()   opcionales: para decir "Subiendo…" y repintar
//
// Aquí no se llama a la API: qué ruta guarda y qué se repinta lo sabe la página. Lo que
// sí vive aquí es todo lo demás: qué archivos son fotos, reducirlas, el tope de tamaño,
// subirlas una por una, los avisos y los eventos de la caja. Las reglas se prueban en
// pruebas/web/fotos.test.js (`npm run probar:web`); reducir, arrastrar y pegar, en
// pantalla. Usa `srcSeguro` y `pesoTxt` de texto.js, que se carga antes.

const sinExtension = n => n.replace(/\.[A-Za-z0-9]{1,5}$/, '') || n;

// Deja soltar archivos del equipo sobre `caja`. Sólo reacciona a archivos: arrastrar
// texto o una liga sigue haciendo lo de siempre. Es lo que usan los documentos de la
// ficha; las cajas de fotos escuchan por su cuenta (ver `Fotos.escuchar`).
function soltarArchivos(caja, alSoltar) {
  const trae = e => [...(e.dataTransfer?.types ?? [])].includes('Files');
  caja.ondragover = e => { if (trae(e)) { e.preventDefault(); caja.classList.add('soltar'); } };
  caja.ondragleave = e => { if (!caja.contains(e.relatedTarget)) caja.classList.remove('soltar'); };
  caja.ondrop = e => {
    if (!trae(e)) return;
    e.preventDefault();
    caja.classList.remove('soltar');
    alSoltar([...e.dataTransfer.files], e);
  };
}

const Fotos = (() => {
  const TIPOS = /^image\/(jpeg|png|webp|gif)$/;
  const MAX_ARCHIVO = 20 * 1024 * 1024;       // el mismo tope que pone la API
  const LADO_MAX = 2400;

  // ── Reglas ─────────────────────────────────────────────────────────────────
  const aceptadas = files => [...files].filter(f => TIPOS.test(f.type));
  // Las ligas de foto que vienen en un texto pegado: una o varias, separadas por espacios.
  const ligas = crudo => (crudo ?? '').split(/\s+/).filter(u => /^https?:\/\//i.test(u));
  const sin = (lista, i) => lista.filter((_, k) => k !== i);
  const dePortada = (lista, i) => [lista[i], ...sin(lista, i)];

  // Una foto de celular pesa 5–12 MB y aquí se ve a 1,200 px: se reduce en el navegador
  // antes de subirla. Si no hace falta (o el navegador no puede), sube tal cual.
  async function reducir(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, LADO_MAX / Math.max(bmp.width, bmp.height));
      if (k === 1 && file.size <= 1.5 * 1048576) return file;
      const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);     // un PNG transparente no sale negro
      g.drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.86));
      return blob && blob.size < file.size ? new File([blob], sinExtension(file.name) + '.jpg', { type: 'image/jpeg' }) : file;
    } catch { return file; }
  }

  // Las imágenes de un `paste`, ya con nombre: una captura llega como "image.png" (o sin
  // nombre) y en el servidor se apilarían todas iguales.
  function pegadas(e) {
    const imgs = aceptadas(e.clipboardData?.files ?? []);
    const sello = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    return imgs.map((f, i) => /^image\./.test(f.name) || !f.name
      ? new File([f], `captura-${sello}${i ? `-${i + 1}` : ''}.${f.type.split('/')[1]}`, { type: f.type })
      : f);
  }

  // ── Subir ──────────────────────────────────────────────────────────────────
  // Una por una y en orden: la API agrega cada foto al final de la lista. Una que pasa
  // del tope se avisa y se salta; si una subida falla, no se intentan las que faltan.
  // `con` existe para las pruebas: cómo se avisa y cómo se reduce.
  async function subir(files, destino, con = {}) {
    const avisar = con.avisar ?? (m => alert(m)), achicar = con.reducir ?? reducir;
    files = aceptadas(files);
    if (!files.length) return avisar('Sólo se pueden subir imágenes JPG, PNG, WEBP o GIF.');
    destino.alEmpezar?.(files.length);
    try {
      await destino.preparar?.();
      for (const f of files) {
        const lista = await achicar(f);
        if (lista.size > MAX_ARCHIVO) {
          avisar(`"${lista.name}" pesa ${pesoTxt(lista.size)} y el máximo por archivo es ${pesoTxt(MAX_ARCHIVO)}.`);
          continue;
        }
        await destino.subir(lista);
      }
    } catch (err) { avisar('No se pudo subir la foto: ' + err.message); }
    await destino.alTerminar?.();
  }

  function agregarLiga(destino, crudo) {
    const nuevas = ligas(crudo);
    if (!nuevas.length) { if ((crudo ?? '').trim()) alert('La liga de una foto empieza con https://'); return; }
    destino.guardar([...destino.fotos(), ...nuevas]);
  }

  // ── La caja ────────────────────────────────────────────────────────────────
  // Miniaturas con quitar y "de portada", y el alta. `clase` es la de la página;
  // `antes`, marcado suyo que va arriba; `corta`, los textos para una caja angosta;
  // `subiendo`, cuántas fotos van en camino.
  function caja(fotos, { clase = '', antes = '', corta = false, subiendo = 0 } = {}) {
    const ayuda = corta ? 'JPG, PNG o WEBP. También puedes arrastrarlas aquí o pegar una captura con Ctrl+V.'
      : 'JPG, PNG o WEBP. También puedes arrastrarlas aquí o pegar una captura de pantalla con Ctrl+V.';
    const va = corta ? 'Subiendo&#8230;' : `Subiendo ${subiendo} ${subiendo === 1 ? 'foto' : 'fotos'}&#8230;`;
    return `<div class="${clase ? clase + ' ' : ''}fx-fotos">
    ${antes}
    <span class="fx-lab">Fotos <small>${fotos.length ? 'la primera es la portada' : 'aún no hay'}</small></span>
    ${fotos.length ? `<div class="fx-thumbs">${fotos.map((u, i) => `<span class="fx-thumb${i ? '' : ' portada'}">
      <img src="${srcSeguro(u)}" alt="" loading="lazy">
      ${i ? `<button type="button" class="foto-top" data-i="${i}" title="Usar como portada">&#8593;</button>` : ''}
      <button type="button" class="foto-del" data-i="${i}" title="Quitar foto">&times;</button></span>`).join('')}</div>` : ''}
    <div class="fx-add">
      <input class="foto-url" placeholder="${corta ? 'Liga de una foto (https://…)' : 'Pega la liga de una foto (https://…)'}" aria-label="Liga de una foto">
      <button type="button" class="foto-sube">${corta ? 'Subir' : 'Subir fotos'}&#8230;</button>
    </div>
    <p class="fx-hint">${subiendo ? va : ayuda}</p>
    <input type="file" data-foto-file accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden>
  </div>`;
  }

  // Los eventos de todas las cajas que haya dentro de `raiz`, ahora y después: la
  // página repinta y no hay que volver a enlazar nada. Se llama una sola vez.
  function escuchar(raiz, destinoDe) {
    const trae = e => [...(e.dataTransfer?.types ?? [])].includes('Files');
    // La caja donde pasó el evento y de quién son sus fotos, o nada.
    const donde = el => {
      const c = el?.closest?.('.fx-fotos'), d = c && raiz.contains(c) ? destinoDe(c) : null;
      return d ? { c, d } : null;
    };
    const liga = input => { const x = donde(input), v = input.value; input.value = ''; if (x) agregarLiga(x.d, v); };

    raiz.addEventListener('click', e => {
      const t = e.target, x = donde(t);
      if (!x) return;
      if (t.closest('.foto-sube')) return x.c.querySelector('[data-foto-file]').click();
      const del = t.closest('.foto-del'), top = t.closest('.foto-top');
      if (del) { if (confirm('¿Quitar esta foto?')) x.d.guardar(sin(x.d.fotos(), +del.dataset.i)); return; }
      if (top) x.d.guardar(dePortada(x.d.fotos(), +top.dataset.i));
    });
    raiz.addEventListener('change', e => {
      const t = e.target;
      if (t.matches('[data-foto-file]')) { const x = donde(t); if (x && t.files.length) subir(t.files, x.d); }
      else if (t.matches('.fx-fotos .foto-url')) liga(t);
    });
    // Se vacía antes de guardar: si no, el `change` que sigue al Enter la agregaría dos veces.
    raiz.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.matches?.('.fx-fotos .foto-url')) { e.preventDefault(); liga(e.target); }
    });
    // Soltar archivos del equipo sobre la caja. Sólo archivos: arrastrar texto, una
    // liga o una fila sigue haciendo lo de siempre.
    raiz.addEventListener('dragover', e => { const x = trae(e) && donde(e.target); if (x) { e.preventDefault(); x.c.classList.add('soltar'); } });
    raiz.addEventListener('dragleave', e => { const c = e.target.closest?.('.fx-fotos'); if (c && !c.contains(e.relatedTarget)) c.classList.remove('soltar'); });
    raiz.addEventListener('drop', e => {
      const x = trae(e) && donde(e.target);
      if (!x) return;
      e.preventDefault();
      x.c.classList.remove('soltar');
      subir(e.dataTransfer.files, x.d);
    });
    // Pegar una imagen (Ctrl+V) la sube a la caja donde está el cursor; si la página
    // sólo tiene una caja, a esa. Con varias y el cursor fuera, no se adivina.
    document.addEventListener('paste', e => {
      const cajas = raiz.querySelectorAll('.fx-fotos');
      const x = donde(e.target) ?? (cajas.length === 1 ? donde(cajas[0]) : null);
      const imgs = x ? pegadas(e) : [];
      if (!imgs.length) return;
      e.preventDefault();
      subir(imgs, x.d);
    });
  }

  return { MAX_ARCHIVO, aceptadas, ligas, sin, dePortada, pegadas, subir, caja, escuchar };
})();

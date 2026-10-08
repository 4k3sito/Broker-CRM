// Subir fotos de una propiedad: lo que comparten la ficha (listing.js) y la tabla de
// un cliente (clientes.js). Aquí no se llama a la API ni se pinta nada: sólo se prepara
// el archivo y se escucha el arrastre.
const sinExtension = n => n.replace(/\.[A-Za-z0-9]{1,5}$/, '') || n;
const TIPOS_FOTO = /^image\/(jpeg|png|webp|gif)$/;
const LADO_MAX = 2400;
// Una foto de celular pesa 5–12 MB y aquí se ve a 1,200 px: se reduce en el navegador
// antes de subirla. Si no hace falta (o el navegador no puede), sube tal cual.
async function prepararFoto(file) {
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

// Deja soltar archivos del equipo sobre `caja`. Sólo reacciona a archivos: arrastrar
// texto o una liga sigue haciendo lo de siempre.
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

// Las imágenes de un `paste`, ya con nombre: una captura llega como "image.png" (o sin
// nombre) y en el servidor se apilarían todas iguales.
function fotosPegadas(e) {
  const imgs = [...(e.clipboardData?.files ?? [])].filter(f => TIPOS_FOTO.test(f.type));
  const sello = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  return imgs.map((f, i) => /^image\./.test(f.name) || !f.name
    ? new File([f], `captura-${sello}${i ? `-${i + 1}` : ''}.${f.type.split('/')[1]}`, { type: f.type })
    : f);
}

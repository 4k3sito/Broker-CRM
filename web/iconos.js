// Los iconos de los datos de un inmueble: la fila de la tarjeta y los hechos de la ficha.
// Trazo recto de 2 px con puntas cuadradas, para que sigan a un sistema sin esquinas
// redondeadas. Decoran: el dato va en el `title` o en la etiqueta de al lado, y por eso
// van con aria-hidden. Son datos de código, no de terceros: no pasan por `esc`.
const Iconos = (() => {
  const TRAZOS = {
    Terreno: 'M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5',
    Construcción: 'M12 2 3 7v10l9 5 9-5V7zM3 7l9 5 9-5M12 12v10',
    Superficie: 'M3 3h18v18H3z',
    cajones: 'M4 11l2-6h12l2 6v8h-3v-2H7v2H4zM4 11h16',
    banos: 'M3 12h18v4l-2 3H5l-2-3zM6 12V4h4v2M6 19v2M18 19v2',
    altura: 'M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4',
    andenes: 'M3 21V8l9-5 9 5v13M7 21v-9h10v9M7 15h10M7 18h10',
    frente: 'M3 9v6M21 9v6M3 12h18',
    elevador: 'M4 3h16v18H4zM9 13V8M7 10l2-2 2 2M15 8v5M13 11l2 2 2-2',
  };
  const de = (nombre, px = 13) => TRAZOS[nombre]
    ? `<svg width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="${TRAZOS[nombre]}"/></svg>`
    : '';
  return { de };
})();

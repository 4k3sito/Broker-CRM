// Configuración pública del front. Nada de esto es secreto: viaja al navegador.
// Los mapas (mapa.js, ubicacion.js) son MapLibre + OpenFreeMap y no piden llave.
window.OL_CONFIG = {
  // Teléfono de oficina que aparece en la ficha PDF de Pro Realtors.
  oficinaTel: '8125074607',
  centro: [-100.36, 25.66],   // [lng, lat] Monterrey / San Pedro
  centroNombre: 'Monterrey',  // cómo se le dice a esa vista en los filtros
  zoom: 11,
  // Área con la que abre el tablero, en metros. Es FIJA a propósito: hasta hoy salía de
  // lo que el mapa enseñaba, así que un portátil de 13" abría con 12,388 inmuebles y un
  // monitor de 27" con 14,399 — misma búsqueda, distinto inventario. El mapa sólo manda
  // cuando alguien lo mueve o pide «buscar en esta zona».
  radioInicial: 10000,
};

// Configuración pública del front. La llave de Google Maps viaja al navegador por
// diseño: restríngela en Google Cloud a "Sitios web" con tu dominio y sólo a la
// "Maps JavaScript API".
window.OL_CONFIG = {
  googleMapsKey: 'PEGA_AQUI_TU_LLAVE',
  // Necesario para los pines con HTML (AdvancedMarker). 'DEMO_MAP_ID' sirve para
  // desarrollo; en producción crea un Map ID en Google Cloud → Map Management.
  googleMapId: 'DEMO_MAP_ID',
  // Teléfono de oficina que aparece en la ficha PDF de Pro Realtors.
  oficinaTel: '8125074607',
  centro: [-100.36, 25.66],   // [lng, lat] Monterrey / San Pedro
  zoom: 11,
};

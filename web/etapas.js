// Etapas del proceso comercial (cliente × propiedad): las ocho de `proceso.status`.
//
// Vive aparte porque la usan tres páginas —tareas (el pipeline), clientes y la ficha
// de un inmueble— y una lista de estados copiada en tres archivos se desincroniza:
// antes de esto cada página traía su propio `['presentado','aprobado','rechazado']`.
//
// El orden es el avance. `pausa` y `rechazado` son laterales: no son un paso más,
// son salirse del camino, y el tablero los esconde salvo que se pidan.

const ETAPAS = [
  { key: 'prospecto',     label: 'Prospecto',     ayuda: 'Sin presentar todavía: investigar, contactar al dueño, armar la ficha.' },
  { key: 'por_presentar', label: 'Por presentar', ayuda: 'Lista para enseñarse al cliente en la siguiente junta.' },
  { key: 'presentado',    label: 'Presentado',    ayuda: 'Ya se enseñó o se mandó ficha y documentos; el cliente la está revisando.' },
  { key: 'aprobado',      label: 'Aprobado',      ayuda: 'El cliente la aprobó: QHSE, levantamiento, plano, precio con el dueño.' },
  { key: 'negociacion',   label: 'Negociación',   ayuda: 'Carta intención u oferta en curso.' },
  { key: 'cerrado',       label: 'Cerrado',       ayuda: 'Contrato firmado.' },
  { key: 'pausa',         label: 'En pausa',      ayuda: 'On hold: se espera al dueño, al cliente o a un tercero.', lateral: true },
  { key: 'rechazado',     label: 'Descartado',    ayuda: 'Cancelada, descartada o rentada a otro.', lateral: true },
];
const ETAPA = Object.fromEntries(ETAPAS.map((e, i) => [e.key, { ...e, orden: i }]));
const etapaLabel = k => ETAPA[k]?.label ?? k;
const etapaActiva = k => !ETAPA[k]?.lateral;

// La etapa de un cliente es la de su proceso más avanzado. Un cliente con todo
// descartado sale como descartado; uno sin procesos, sin etapa.
function etapaMayor(estados) {
  const activas = estados.filter(etapaActiva);
  const pool = activas.length ? activas : estados;
  return pool.sort((a, b) => (activas.length ? ETAPA[b].orden - ETAPA[a].orden
                                             : ETAPA[a].orden - ETAPA[b].orden))[0] ?? null;
}

// <option>s de un <select> de etapa.
const etapaOpciones = sel => ETAPAS.map(e =>
  `<option value="${e.key}"${e.key === sel ? ' selected' : ''}>${e.label}</option>`).join('');

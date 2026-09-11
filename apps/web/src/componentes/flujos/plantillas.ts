/**
 * Plantillas de flujo: con qué empieza alguien que abre esto por primera vez.
 *
 * No están aquí por adorno. Un constructor en blanco obliga a inventarse el
 * flujo Y aprender la herramienta a la vez, y lo que sale es un bot de un
 * mensaje que nadie activa. Cada plantilla es un flujo que se puede publicar
 * tal cual, y que además enseña un patrón: esperar, ramificar, etiquetar,
 * entregar a una persona.
 *
 * Viven en la web y no en el servidor a propósito: son **contenido de la
 * interfaz**, no datos del inquilino. En cuanto se crea el flujo, el grafo es
 * suyo y la plantilla deja de existir — no hay herencia que mantener ni
 * «plantilla actualizada» que propagar.
 */
import type { DisparadorDeFlujo, GrafoDeFlujo } from '../../api/tipos.ts';

export interface PlantillaDeFlujo {
  id: string;
  nombre: string;
  /** Qué resuelve, en una línea. Es lo que se lee antes de elegir. */
  resume: string;
  /** Categoría para agrupar la galería. */
  grupo: 'Atender' | 'Calificar' | 'Recuperar';
  grafo: GrafoDeFlujo;
  disparadores: DisparadorDeFlujo[];
}

export const PLANTILLAS: PlantillaDeFlujo[] = [
  {
    id: 'vacio',
    nombre: 'Empezar desde cero',
    resume: 'Un saludo y un final. Lo demás lo pones tú.',
    grupo: 'Atender',
    grafo: {
      inicio: 'saludo',
      nodos: [
        { id: 'saludo', tipo: 'mensaje', texto: '¡Hola! ¿En qué te ayudamos?', siguiente: 'fin' },
        { id: 'fin', tipo: 'fin' },
      ],
    },
    disparadores: [{ tipo: 'conversacion_abierta' }],
  },
  {
    id: 'bienvenida',
    nombre: 'Bienvenida y paso a un agente',
    resume: 'Responde al primer mensaje al instante y deja la conversación asignada.',
    grupo: 'Atender',
    grafo: {
      inicio: 'saludo',
      nodos: [
        {
          id: 'saludo',
          tipo: 'mensaje',
          texto: '¡Hola! Gracias por escribirnos.',
          siguiente: 'respira',
        },
        // Dos mensajes seguidos en el mismo segundo se leen como una máquina.
        // Cuatro segundos entre uno y otro se leen como alguien escribiendo.
        { id: 'respira', tipo: 'pausa', segundos: 4, siguiente: 'aviso' },
        {
          id: 'aviso',
          tipo: 'mensaje',
          texto: 'Un asesor te atiende en un momento.',
          siguiente: 'asignar',
        },
        { id: 'asignar', tipo: 'asignar', usuarioId: '', siguiente: 'fin' },
        { id: 'fin', tipo: 'fin' },
      ],
    },
    disparadores: [{ tipo: 'conversacion_abierta' }],
  },
  {
    id: 'calificar',
    nombre: 'Calificar el lead',
    resume: 'Pregunta si busca algo concreto y separa a quien compra de quien mira.',
    grupo: 'Calificar',
    grafo: {
      inicio: 'saludo',
      nodos: [
        {
          id: 'saludo',
          tipo: 'mensaje',
          texto: '¡Hola! ¿Buscas algo en concreto o prefieres que te asesoremos?',
          siguiente: 'espera',
        },
        {
          id: 'espera',
          tipo: 'esperar_respuesta',
          segundos: 3600,
          siguiente: 'ramas',
          alExpirar: 'frio',
        },
        {
          id: 'ramas',
          tipo: 'condicion',
          casos: [
            { contiene: ['si', 'sí', 'busco', 'necesito', 'precio'], siguiente: 'etiqueta' },
            { contiene: ['no', 'solo miro', 'mirando'], siguiente: 'despedida' },
          ],
          siNo: 'asignar',
        },
        { id: 'etiqueta', tipo: 'etiquetar', etiquetaId: '', siguiente: 'asignar' },
        { id: 'asignar', tipo: 'asignar', usuarioId: '', siguiente: 'aviso' },
        {
          id: 'aviso',
          tipo: 'mensaje',
          texto: 'Perfecto, te paso con un asesor ahora mismo.',
          siguiente: 'fin',
        },
        {
          id: 'despedida',
          tipo: 'mensaje',
          texto: 'Sin problema. Aquí estamos cuando lo necesites.',
          siguiente: 'fin',
        },
        { id: 'frio', tipo: 'etiquetar', etiquetaId: '', siguiente: 'fin' },
        { id: 'fin', tipo: 'fin' },
      ],
    },
    disparadores: [{ tipo: 'conversacion_abierta' }],
  },
  {
    id: 'precio',
    nombre: 'Responde a «precio» o «catálogo»',
    resume: 'Arranca solo cuando escriben esas palabras, y pasa a un asesor si insisten.',
    grupo: 'Atender',
    grafo: {
      inicio: 'respuesta',
      nodos: [
        {
          id: 'respuesta',
          tipo: 'mensaje',
          texto: 'Te paso el catálogo con precios. ¿Quieres que te llamemos?',
          siguiente: 'espera',
        },
        {
          id: 'espera',
          tipo: 'esperar_respuesta',
          segundos: 7200,
          siguiente: 'ramas',
          alExpirar: 'fin',
        },
        {
          id: 'ramas',
          tipo: 'condicion',
          casos: [{ contiene: ['si', 'sí', 'llamen', 'llamada'], siguiente: 'asignar' }],
          siNo: 'fin',
        },
        { id: 'asignar', tipo: 'asignar', usuarioId: '', siguiente: 'fin' },
        { id: 'fin', tipo: 'fin' },
      ],
    },
    disparadores: [{ tipo: 'palabra_clave', palabras: ['precio', 'precios', 'catálogo', 'costo'] }],
  },
  {
    id: 'recordatorio',
    nombre: 'Recordatorio antes de perderlo',
    resume: 'Si no contesta, insiste una vez y después lo marca como frío.',
    grupo: 'Recuperar',
    grafo: {
      inicio: 'pregunta',
      nodos: [
        {
          id: 'pregunta',
          tipo: 'mensaje',
          texto: '¿Seguimos con tu consulta?',
          siguiente: 'espera',
        },
        {
          id: 'espera',
          tipo: 'esperar_respuesta',
          segundos: 21_600,
          siguiente: 'asignar',
          alExpirar: 'insistir',
        },
        {
          id: 'insistir',
          tipo: 'mensaje',
          texto: 'Te dejamos por aquí por si aún te interesa. ¿Te ayudamos?',
          siguiente: 'espera2',
        },
        {
          id: 'espera2',
          tipo: 'esperar_respuesta',
          segundos: 86_400,
          siguiente: 'asignar',
          alExpirar: 'frio',
        },
        { id: 'asignar', tipo: 'asignar', usuarioId: '', siguiente: 'fin' },
        { id: 'frio', tipo: 'etiquetar', etiquetaId: '', siguiente: 'fin' },
        { id: 'fin', tipo: 'fin' },
      ],
    },
    disparadores: [{ tipo: 'conversacion_abierta' }],
  },
];

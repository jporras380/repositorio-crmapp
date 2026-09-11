/**
 * Salesbots: el grafo y sus transiciones, como dominio puro (ADR-002).
 *
 * Aquí no hay base de datos, ni colas, ni envíos. Este módulo responde a una
 * sola pregunta —«estando en este nodo y habiendo pasado esto, ¿qué hay que
 * hacer y a dónde se va?»— y devuelve **efectos descritos**, no ejecutados.
 * Quien los ejecuta es el worker, dentro de una transacción.
 *
 * Esa separación es la que hace posible el **modo prueba sin envío real** que
 * pide el requisito: simular un flujo es llamar a estas funciones y no
 * ejecutar los efectos. No hace falta un «modo simulación» repartido por el
 * motor con `if (prueba)` en cada envío, que es exactamente la clase de
 * bandera que un día se queda a `false` en producción.
 *
 * ## El grafo
 *
 * Nodos deliberadamente pocos. Un constructor visual con cuarenta tipos de
 * nodo es un lenguaje de programación mal hecho; estos siete cubren el criterio
 * de salida de la fase 3 —calificar un lead sin humano— y se amplían cuando un
 * flujo real lo pida:
 *
 *   mensaje            envía un texto y sigue
 *   esperar_respuesta  se duerme hasta que el contacto escriba, o hasta el plazo
 *   pausa              se duerme un rato sin esperar a nadie
 *   condicion          bifurca según lo que dijo el contacto
 *   etiquetar          pone una etiqueta (el filtro de primer nivel de la bandeja)
 *   asignar            pasa la conversación a una persona
 *   fin                termina, opcionalmente cerrando la conversación
 */

// ---------------------------------------------------------------------------
// Grafo
// ---------------------------------------------------------------------------

export type Nodo =
  | { id: string; tipo: 'mensaje'; texto: string; siguiente: string | null }
  | {
      id: string;
      tipo: 'esperar_respuesta';
      /** Plazo antes de rendirse. Sin plazo, un flujo puede quedarse vivo para siempre. */
      segundos: number;
      /** A dónde ir cuando el contacto responde. */
      siguiente: string | null;
      /** A dónde ir si vence el plazo. Sin esto, el silencio termina el flujo. */
      alExpirar: string | null;
    }
  | {
      id: string;
      tipo: 'condicion';
      /** Se evalúan en orden; gana la primera que casa. */
      casos: { contiene: string[]; siguiente: string | null }[];
      siNo: string | null;
    }
  | {
      id: string;
      tipo: 'pausa';
      /**
       * Cuánto calla antes de seguir. Tope de un día, y no es arbitrario: una
       * ejecución dormida en una pausa NO se reanuda porque el contacto
       * escriba —no está esperando respuesta—, así que mientras dura, la
       * conversación no puede disparar ningún otro bot. Cuanto más larga la
       * pausa, más tiempo sordo. Para esperar días, lo correcto es
       * `esperar_respuesta`, que sí escucha.
       */
      segundos: number;
      siguiente: string | null;
    }
  | { id: string; tipo: 'etiquetar'; etiquetaId: string; siguiente: string | null }
  | { id: string; tipo: 'asignar'; usuarioId: string; siguiente: string | null }
  | { id: string; tipo: 'fin'; cerrarConversacion?: boolean };

export interface Grafo {
  inicio: string;
  nodos: Nodo[];
}

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

export interface ProblemaDelGrafo {
  codigo:
    | 'sin_nodos'
    | 'inicio_desconocido'
    | 'id_repetido'
    | 'destino_desconocido'
    | 'texto_vacio'
    | 'espera_invalida'
    | 'pausa_invalida'
    | 'condicion_vacia'
    | 'bucle_sin_espera'
    | 'inalcanzable';
  mensaje: string;
  nodoId?: string;
}

const MAX_SEGUNDOS_DE_ESPERA = 30 * 24 * 60 * 60; // 30 días
const MAX_SEGUNDOS_DE_PAUSA = 24 * 60 * 60; // 1 día — ver el comentario del nodo

/**
 * Valida el grafo antes de publicarlo. Publicar es lo que lo pone a hablar con
 * clientes reales, así que este es el último sitio donde un error sale gratis.
 *
 * El problema que de verdad importa es **`bucle_sin_espera`**: un ciclo que no
 * pasa por ningún `esperar_respuesta` envía mensajes en bucle a la velocidad
 * de la red. No es una molestia, es dinero del cliente y su número reportado
 * por spam en cuestión de minutos. El motor además corta por número de pasos,
 * pero cortar en caliente es contener el incendio; esto lo evita.
 */
export function validarGrafo(g: Grafo): ProblemaDelGrafo[] {
  const problemas: ProblemaDelGrafo[] = [];
  if (g.nodos.length === 0) {
    return [{ codigo: 'sin_nodos', mensaje: 'El flujo no tiene ningún paso.' }];
  }

  const porId = new Map<string, Nodo>();
  for (const n of g.nodos) {
    if (porId.has(n.id)) {
      problemas.push({
        codigo: 'id_repetido',
        mensaje: `Hay dos pasos con el id "${n.id}".`,
        nodoId: n.id,
      });
    }
    porId.set(n.id, n);
  }
  if (!porId.has(g.inicio)) {
    problemas.push({
      codigo: 'inicio_desconocido',
      mensaje: `El paso inicial "${g.inicio}" no existe.`,
    });
  }

  const destino = (id: string | null, nodoId: string) => {
    if (id !== null && !porId.has(id)) {
      problemas.push({
        codigo: 'destino_desconocido',
        mensaje: `El paso "${nodoId}" lleva a "${id}", que no existe.`,
        nodoId,
      });
    }
  };

  for (const n of g.nodos) {
    switch (n.tipo) {
      case 'mensaje':
        if (!n.texto.trim()) {
          problemas.push({
            codigo: 'texto_vacio',
            mensaje: 'Hay un mensaje sin texto.',
            nodoId: n.id,
          });
        }
        destino(n.siguiente, n.id);
        break;
      case 'esperar_respuesta':
        if (
          !Number.isFinite(n.segundos) ||
          n.segundos <= 0 ||
          n.segundos > MAX_SEGUNDOS_DE_ESPERA
        ) {
          problemas.push({
            codigo: 'espera_invalida',
            mensaje: `La espera de "${n.id}" tiene que estar entre 1 segundo y 30 días.`,
            nodoId: n.id,
          });
        }
        destino(n.siguiente, n.id);
        destino(n.alExpirar, n.id);
        break;
      case 'pausa':
        if (!Number.isFinite(n.segundos) || n.segundos <= 0 || n.segundos > MAX_SEGUNDOS_DE_PAUSA) {
          problemas.push({
            codigo: 'pausa_invalida',
            mensaje: `La pausa de "${n.id}" tiene que estar entre 1 segundo y 24 horas.`,
            nodoId: n.id,
          });
        }
        destino(n.siguiente, n.id);
        break;
      case 'condicion':
        if (n.casos.length === 0) {
          problemas.push({
            codigo: 'condicion_vacia',
            mensaje: `La condición "${n.id}" no tiene ningún caso.`,
            nodoId: n.id,
          });
        }
        for (const caso of n.casos) destino(caso.siguiente, n.id);
        destino(n.siNo, n.id);
        break;
      case 'etiquetar':
      case 'asignar':
        destino(n.siguiente, n.id);
        break;
      case 'fin':
        break;
    }
  }

  problemas.push(...buscarBuclesSinEspera(g, porId));
  for (const n of g.nodos) {
    if (n.id !== g.inicio && !alcanzables(g, porId).has(n.id)) {
      problemas.push({
        codigo: 'inalcanzable',
        mensaje: `Al paso "${n.id}" no se llega desde el inicio.`,
        nodoId: n.id,
      });
    }
  }
  return problemas;
}

function salidas(n: Nodo): (string | null)[] {
  switch (n.tipo) {
    case 'mensaje':
    case 'pausa':
    case 'etiquetar':
    case 'asignar':
      return [n.siguiente];
    case 'esperar_respuesta':
      return [n.siguiente, n.alExpirar];
    case 'condicion':
      return [...n.casos.map((c) => c.siguiente), n.siNo];
    case 'fin':
      return [];
  }
}

function alcanzables(g: Grafo, porId: Map<string, Nodo>): Set<string> {
  const vistos = new Set<string>();
  const pila = [g.inicio];
  while (pila.length) {
    const id = pila.pop()!;
    if (vistos.has(id)) continue;
    const n = porId.get(id);
    if (!n) continue;
    vistos.add(id);
    for (const s of salidas(n)) if (s) pila.push(s);
  }
  return vistos;
}

/**
 * Ciclos que no pasan por una espera. Se busca sobre el grafo con las aristas
 * que salen de `esperar_respuesta` CORTADAS: si en ese grafo recortado sigue
 * habiendo un ciclo, es un bucle que se ejecuta sin parar nunca.
 */
function buscarBuclesSinEspera(g: Grafo, porId: Map<string, Nodo>): ProblemaDelGrafo[] {
  const enCamino = new Set<string>();
  const cerrados = new Set<string>();
  const encontrados: ProblemaDelGrafo[] = [];

  const visitar = (id: string): void => {
    const n = porId.get(id);
    if (!n || cerrados.has(id)) return;
    if (enCamino.has(id)) {
      encontrados.push({
        codigo: 'bucle_sin_espera',
        mensaje:
          `El paso "${id}" forma un bucle que enviaría mensajes sin parar. ` +
          `Una pausa no lo corta: seguiría enviando, solo que más lento.`,
        nodoId: id,
      });
      return;
    }
    enCamino.add(id);
    // Solo `esperar_respuesta` corta el camino: lo que sigue depende de que
    // alguien escriba, así que el ciclo no se cierra solo. Una `pausa` NO
    // corta nada — un bucle con pausas sigue siendo un bucle que manda
    // mensajes para siempre, y «más lento» no es «no».
    if (n.tipo !== 'esperar_respuesta') {
      for (const s of salidas(n)) if (s) visitar(s);
    }
    enCamino.delete(id);
    cerrados.add(id);
  };

  for (const n of g.nodos) visitar(n.id);
  return encontrados;
}

// ---------------------------------------------------------------------------
// Transiciones
// ---------------------------------------------------------------------------

/** Lo que le pasa a una ejecución parada en un nodo. */
export type EntradaDelFlujo =
  /** Se acaba de llegar a este nodo. */
  | { tipo: 'entrar' }
  /** El contacto escribió. */
  | { tipo: 'respuesta'; texto: string }
  /** Venció el plazo de la espera. */
  | { tipo: 'expiro' };

export type Efecto =
  | { tipo: 'enviar_texto'; texto: string }
  | { tipo: 'etiquetar'; etiquetaId: string }
  | { tipo: 'asignar'; usuarioId: string }
  | { tipo: 'cerrar_conversacion' };

/**
 * Variables de la ejecución. Viven en `flow_runs.context` y sobreviven al
 * reinicio del worker: son lo que el flujo «recuerda».
 */
export interface ContextoDelFlujo {
  /** Lo último que escribió el contacto. Lo lee `condicion`. */
  ultimaRespuesta?: string;
}

export interface Paso {
  efectos: Efecto[];
  /** Nodo siguiente, o `null` si el flujo termina aquí. */
  siguiente: string | null;
  /** Si el flujo queda dormido: qué espera y cuántos segundos. */
  espera?: { segundos: number; motivo: 'respuesta' | 'pausa' };
}

/**
 * La transición. Función pura: mismo nodo y misma entrada, mismo resultado.
 *
 * Devuelve efectos DESCRITOS. El worker los ejecuta y el simulador los pinta;
 * ninguno de los dos necesita su propia copia de estas reglas.
 */
export function decidirPaso(
  nodo: Nodo,
  entrada: EntradaDelFlujo,
  contexto: ContextoDelFlujo = {},
): Paso {
  switch (nodo.tipo) {
    case 'mensaje':
      return { efectos: [{ tipo: 'enviar_texto', texto: nodo.texto }], siguiente: nodo.siguiente };

    case 'etiquetar':
      return {
        efectos: [{ tipo: 'etiquetar', etiquetaId: nodo.etiquetaId }],
        siguiente: nodo.siguiente,
      };

    case 'asignar':
      return {
        efectos: [{ tipo: 'asignar', usuarioId: nodo.usuarioId }],
        siguiente: nodo.siguiente,
      };

    case 'fin':
      return {
        efectos: nodo.cerrarConversacion ? [{ tipo: 'cerrar_conversacion' }] : [],
        siguiente: null,
      };

    case 'pausa':
      // Entrar duerme; volver —siempre por el reloj, nunca por un entrante—
      // sigue. Es la misma mecánica que la espera, con una diferencia que
      // decide el motor: `motivo: 'pausa'` hace que un mensaje del contacto
      // NO la reanude.
      return entrada.tipo === 'entrar'
        ? { efectos: [], siguiente: nodo.id, espera: { segundos: nodo.segundos, motivo: 'pausa' } }
        : { efectos: [], siguiente: nodo.siguiente };

    case 'esperar_respuesta':
      if (entrada.tipo === 'entrar') {
        return {
          efectos: [],
          siguiente: nodo.id,
          espera: { segundos: nodo.segundos, motivo: 'respuesta' },
        };
      }
      // Contestó dentro de plazo, o se acabó el plazo. Son dos caminos
      // distintos a propósito: «no contestó» suele merecer otra cosa que
      // «contestó», y mezclarlos obliga a adivinar cuál fue.
      return {
        efectos: [],
        siguiente: entrada.tipo === 'respuesta' ? nodo.siguiente : nodo.alExpirar,
      };

    case 'condicion': {
      // La condición casi nunca recibe la respuesta directamente: llega un
      // paso después de la espera, ya con la entrada `entrar`. Por eso lee del
      // contexto, que es donde la ejecución guarda lo último que dijo el
      // contacto. Leerla solo de `entrada` era el bug silencioso de manual:
      // todas las condiciones caerían siempre por la rama «si no».
      const texto = entrada.tipo === 'respuesta' ? entrada.texto : (contexto.ultimaRespuesta ?? '');
      const caso = nodo.casos.find((c) => c.contiene.some((p) => contiene(texto, p)));
      return { efectos: [], siguiente: caso ? caso.siguiente : nodo.siNo };
    }
  }
}

/**
 * Comparación de texto del contacto contra una palabra del flujo.
 *
 * Sin acentos y sin mayúsculas: quien escribe desde el móvil pone «si» tan a
 * menudo como «sí», y un flujo que distinga las dos cosas se rompe con la
 * mitad de la gente. Es contención de subcadena y no palabra exacta porque el
 * contacto responde «si claro, me interesa», no «si».
 */
export function contiene(texto: string, palabra: string): boolean {
  return normalizar(texto).includes(normalizar(palabra));
}

export function normalizar(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// ---------------------------------------------------------------------------
// Simulación (modo prueba sin envío real)
// ---------------------------------------------------------------------------

export interface PasoSimulado {
  nodoId: string;
  tipo: Nodo['tipo'];
  efectos: Efecto[];
  /** Lo que el simulador «recibió» en ese paso, si algo. */
  entrada?: string;
}

export interface Simulacion {
  pasos: PasoSimulado[];
  /** Por qué terminó: llegó a un fin, se quedó esperando, o se cortó. */
  final: 'fin' | 'esperando' | 'sin_respuestas' | 'limite_de_pasos';
}

const LIMITE_DE_PASOS = 50;

/**
 * Recorre el flujo con respuestas de mentira y devuelve lo que HABRÍA hecho.
 *
 * Es el «modo prueba» del requisito, y sale gratis porque las transiciones son
 * puras: aquí no hay ni base de datos ni cola, así que no hay forma de que se
 * escape un mensaje real por accidente.
 */
export function simular(g: Grafo, respuestas: string[]): Simulacion {
  const porId = new Map(g.nodos.map((n) => [n.id, n]));
  const pasos: PasoSimulado[] = [];
  const cola = [...respuestas];
  const contexto: ContextoDelFlujo = {};
  let actual: string | null = g.inicio;
  let entrada: EntradaDelFlujo = { tipo: 'entrar' };
  // Una pausa pasa dos veces por el mismo nodo —duerme y despierta— y en la
  // simulación eso se vería como el paso repetido sin nada en medio.
  let reanudandoPausa = false;

  for (let i = 0; i < LIMITE_DE_PASOS; i++) {
    if (actual === null) return { pasos, final: 'fin' };
    const nodo = porId.get(actual);
    if (!nodo) return { pasos, final: 'fin' };

    const paso = decidirPaso(nodo, entrada, contexto);
    if (!reanudandoPausa) {
      pasos.push({
        nodoId: nodo.id,
        tipo: nodo.tipo,
        efectos: paso.efectos,
        ...(entrada.tipo === 'respuesta' ? { entrada: entrada.texto } : {}),
      });
    }
    reanudandoPausa = false;

    if (paso.espera?.motivo === 'pausa') {
      // En la simulación la pausa no hace perder el tiempo a nadie: se pinta
      // el paso y se sigue como si el reloj ya hubiera pasado.
      entrada = { tipo: 'expiro' };
      reanudandoPausa = true;
      continue;
    }

    if (paso.espera) {
      const siguiente = cola.shift();
      if (siguiente === undefined) return { pasos, final: 'sin_respuestas' };
      contexto.ultimaRespuesta = siguiente;
      entrada = { tipo: 'respuesta', texto: siguiente };
      continue; // se vuelve al mismo nodo de espera, ya con la respuesta
    }
    actual = paso.siguiente;
    entrada = { tipo: 'entrar' };
    if (actual === null) return { pasos, final: 'fin' };
  }
  return { pasos, final: 'limite_de_pasos' };
}

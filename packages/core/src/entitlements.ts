/**
 * Ciclo de vida de la suscripción y qué puede hacer una cuenta en cada estado.
 *
 * Vive en `packages/core` porque es dominio puro, sin I/O. Eso no es
 * organización de carpetas: es lo que impide que esta lógica acabe duplicada
 * en React. `apps/web` no puede importar `core`, y lo vigila
 * `scripts/check-architecture.sh`. Un cliente cuya prueba caducó no puede
 * recuperar el envío de imágenes editando el estado de un componente.
 *
 * ## El ciclo
 *
 *   prueba (1 mes)  ──caduca sin pagar──▶  gracia (7 días)  ──▶  suspendida
 *   activa (pagada) ──no renueva───────▶  gracia (7 días)  ──▶  suspendida
 *
 * En **gracia** solo se envía texto: nada de imagen, vídeo, audio ni
 * documento. En **suspendida** no se envía nada y la cuenta queda en solo
 * lectura, para que el cliente pueda ver y exportar su historial en vez de que
 * la única salida sea perder sus datos.
 *
 * ## Dos decisiones que evitan bugs caros
 *
 * **1. El estado efectivo se DERIVA de las fechas, no se lee de una columna.**
 * La columna `status` es una caché que mantiene un job. Si la política
 * confiara en ella, un cliente cuya gracia venció a las 3 de la mañana
 * seguiría enviando hasta que el cron pasara. Aquí las fechas mandan y la
 * columna solo sirve para listados y para saber si alguien canceló.
 *
 * **2. Los días de gracia se guardan por suscripción, no son una constante.**
 * Si el plazo fuera una constante leída al evaluar, cambiarla de 7 a 14 días
 * alargaría —o acortaría— la gracia de todos los clientes vivos de golpe,
 * retroactivamente. Guardarla por fila hace que el cambio solo afecte a las
 * suscripciones nuevas.
 */

/** Lo que dice la columna `status`: intención declarada, no verdad temporal. */
export type EstadoDeclarado = 'trialing' | 'active' | 'cancelled';

/** Lo que de verdad puede hacer la cuenta ahora mismo. */
export type EstadoEfectivo = 'prueba' | 'activa' | 'gracia' | 'suspendida';

export const DIAS_DE_GRACIA_POR_DEFECTO = 7;
export const MESES_DE_PRUEBA_POR_DEFECTO = 1;

export interface Suscripcion {
  estadoDeclarado: EstadoDeclarado;
  /** Fin de la prueba. `null` si la cuenta nunca tuvo prueba. */
  pruebaHasta: Date | null;
  /** Fin del periodo pagado en curso. `null` si nunca ha pagado. */
  periodoHasta: Date | null;
  /** Días de gracia de ESTA suscripción. Se guarda por fila a propósito. */
  diasDeGracia: number;
}

/**
 * Instante en que se acaba el acceso completo.
 *
 * El periodo pagado manda sobre la prueba: si el cliente pagó a mitad de
 * prueba, lo que vale es lo que compró.
 */
export function accesoHasta(s: Suscripcion): Date | null {
  return s.periodoHasta ?? s.pruebaHasta;
}

/** Instante en que se acaba la gracia y empieza la suspensión. */
export function graciaHasta(s: Suscripcion): Date | null {
  const fin = accesoHasta(s);
  if (!fin) return null;
  return new Date(fin.getTime() + s.diasDeGracia * 24 * 60 * 60 * 1000);
}

/**
 * Estado real en un instante dado.
 *
 * `ahora` es un parámetro y no `new Date()` dentro: una función que lee el
 * reloj no se puede probar, y esto decide si un cliente puede trabajar.
 */
export function estadoEfectivo(s: Suscripcion, ahora: Date): EstadoEfectivo {
  const fin = accesoHasta(s);

  // Cancelar no corta el servicio a mitad de periodo: el cliente pagó por él.
  // Lo que hace es que no habrá renovación, así que al llegar el fin entra en
  // gracia como cualquier otro impago.
  if (!fin) return 'suspendida';

  if (ahora < fin) {
    return s.periodoHasta && ahora < s.periodoHasta ? 'activa' : 'prueba';
  }

  const gracia = graciaHasta(s);
  if (gracia && ahora < gracia) return 'gracia';

  return 'suspendida';
}

export interface Capacidades {
  puedeEnviarTexto: boolean;
  /** Imagen, vídeo, audio, documento, sticker, ubicación. */
  puedeEnviarMedios: boolean;
  /** Plantillas de WhatsApp. En gracia se cortan porque pueden llevar medios. */
  puedeEnviarPlantillas: boolean;
  puedeEjecutarBots: boolean;
  puedeUsarIa: boolean;
  /**
   * Si las cuentas de canal siguen suscritas al proveedor.
   *
   * Al suspender se DESCONECTAN: se da de baja la suscripción del webhook en
   * Meta y el proveedor deja de enviarnos nada. Es mejor que recibir y
   * descartar — rechazar webhooks provoca reintentos y, sostenido en el
   * tiempo, puede llevar a Meta a desactivar nuestro webhook.
   *
   * Reconectar al pagar es automático y no molesta al cliente: su token sigue
   * cifrado en `channel_secrets` (ADR-004), así que no tiene que volver a
   * autorizar nada.
   *
   * Consecuencia asumida: los mensajes que le escriban mientras está
   * desconectado no llegan nunca a la plataforma. Quedan en su cuenta de
   * WhatsApp, pero no en su bandeja.
   */
  canalesConectados: boolean;
  /** Si los entrantes se muestran al usuario. */
  muestraEntrantes: boolean;
  /**
   * Siempre `true`, en todos los estados.
   *
   * Con los canales desconectados no debería llegar nada, así que esto cubre
   * un caso de carrera, no el camino normal: eventos que Meta ya tenía en
   * vuelo cuando se dio de baja la suscripción. A esos se les responde 200 y
   * se guardan, porque devolver un error solo genera reintentos.
   */
  persisteEntrantesEnCrudo: true;
  soloLectura: boolean;
}

const COMPLETO: Capacidades = {
  puedeEnviarTexto: true,
  puedeEnviarMedios: true,
  puedeEnviarPlantillas: true,
  puedeEjecutarBots: true,
  puedeUsarIa: true,
  canalesConectados: true,
  muestraEntrantes: true,
  persisteEntrantesEnCrudo: true,
  soloLectura: false,
};

const DEGRADADO: Capacidades = {
  puedeEnviarTexto: true,
  puedeEnviarMedios: false,
  puedeEnviarPlantillas: false,
  // Bots e IA apagados en cuanto empieza la degradación. La IA además cuesta
  // dinero nuestro en tokens, y un bot enviando por una cuenta degradada es
  // gasto sin ingreso.
  puedeEjecutarBots: false,
  puedeUsarIa: false,
  // Los canales siguen conectados en gracia: poder escribir sin ver las
  // respuestas no sirve de nada, y el objetivo de la gracia es que el cliente
  // pueda seguir atendiendo mientras regulariza.
  canalesConectados: true,
  muestraEntrantes: true,
  persisteEntrantesEnCrudo: true,
  soloLectura: false,
};

const SUSPENDIDO: Capacidades = {
  puedeEnviarTexto: false,
  puedeEnviarMedios: false,
  puedeEnviarPlantillas: false,
  puedeEjecutarBots: false,
  puedeUsarIa: false,
  // Desconectados. Meta deja de enviarnos webhooks, en vez de que los
  // rechacemos uno a uno.
  canalesConectados: false,
  muestraEntrantes: false,
  persisteEntrantesEnCrudo: true,
  soloLectura: true,
};

export function capacidadesDe(estado: EstadoEfectivo): Capacidades {
  switch (estado) {
    case 'prueba':
    case 'activa':
      return COMPLETO;
    case 'gracia':
      return DEGRADADO;
    case 'suspendida':
      return SUSPENDIDO;
  }
}

export function capacidades(s: Suscripcion, ahora: Date): Capacidades {
  return capacidadesDe(estadoEfectivo(s, ahora));
}

// ---------------------------------------------------------------------------
// Decisión de envío
// ---------------------------------------------------------------------------

export type TipoDeEnvio =
  'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'location' | 'template';

const TIPOS_CON_MEDIOS = new Set<TipoDeEnvio>(['image', 'video', 'audio', 'document', 'sticker']);

export type MotivoDeBloqueo =
  | 'suscripcion_suspendida'
  | 'medios_no_permitidos_en_gracia'
  | 'plantillas_no_permitidas_en_gracia'
  | 'bots_detenidos'
  | 'ia_detenida';

export interface DecisionDeEnvio {
  permitido: boolean;
  motivo?: MotivoDeBloqueo;
  estado: EstadoEfectivo;
  /**
   * Qué contarle al usuario. En español porque va a la interfaz, y concreto
   * porque un "no permitido" sin explicación genera un ticket de soporte.
   */
  mensaje?: string;
}

export interface PeticionDeEnvio {
  tipo: TipoDeEnvio;
  /** Quién envía. Un bot o la IA tienen restricciones propias. */
  origen: 'human' | 'bot' | 'ai';
}

/**
 * Única función que decide si un envío sale. La API la llama antes de encolar.
 *
 * Devuelve el motivo además del booleano: la interfaz necesita explicar por
 * qué no se puede, y el log necesita poder distinguir un bloqueo por
 * facturación de un fallo del canal.
 */
export function evaluarEnvio(
  s: Suscripcion,
  peticion: PeticionDeEnvio,
  ahora: Date,
): DecisionDeEnvio {
  const estado = estadoEfectivo(s, ahora);
  const c = capacidadesDe(estado);

  if (peticion.origen === 'bot' && !c.puedeEjecutarBots) {
    return {
      permitido: false,
      motivo: 'bots_detenidos',
      estado,
      mensaje: 'Las automatizaciones están detenidas mientras la suscripción no esté al día.',
    };
  }

  if (peticion.origen === 'ai' && !c.puedeUsarIa) {
    return {
      permitido: false,
      motivo: 'ia_detenida',
      estado,
      mensaje: 'La IA está desactivada mientras la suscripción no esté al día.',
    };
  }

  if (!c.puedeEnviarTexto) {
    return {
      permitido: false,
      motivo: 'suscripcion_suspendida',
      estado,
      mensaje:
        'La suscripción está suspendida. Puedes consultar y exportar tu historial, ' +
        'pero no enviar mensajes hasta regularizar el pago.',
    };
  }

  if (peticion.tipo === 'template' && !c.puedeEnviarPlantillas) {
    return {
      permitido: false,
      motivo: 'plantillas_no_permitidas_en_gracia',
      estado,
      mensaje: 'Durante el periodo de gracia solo se pueden enviar mensajes de texto.',
    };
  }

  if (TIPOS_CON_MEDIOS.has(peticion.tipo) && !c.puedeEnviarMedios) {
    return {
      permitido: false,
      motivo: 'medios_no_permitidos_en_gracia',
      estado,
      mensaje:
        'Durante el periodo de gracia solo se pueden enviar mensajes de texto, sin adjuntos.',
    };
  }

  return { permitido: true, estado };
}

// ---------------------------------------------------------------------------
// Avisos
// ---------------------------------------------------------------------------

/**
 * Días que faltan para el próximo corte, para avisar antes de que ocurra.
 *
 * Negativo si ya pasó. Se usa para el aviso previo: un cliente que se entera
 * de que le cortaron cuando intenta responder a alguien es un cliente que se
 * va.
 */
export function diasHastaElProximoCorte(s: Suscripcion, ahora: Date): number | null {
  const estado = estadoEfectivo(s, ahora);
  const objetivo =
    estado === 'prueba' || estado === 'activa'
      ? accesoHasta(s)
      : estado === 'gracia'
        ? graciaHasta(s)
        : null;

  if (!objetivo) return null;
  return Math.ceil((objetivo.getTime() - ahora.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Fin de prueba para una cuenta nueva. Un mes NATURAL, no treinta dias.
 *
 * El camino ingenuo —`fin.setMonth(fin.getMonth() + 1)`— tiene dos errores que
 * cuestan dinero:
 *
 * 1. **Desborda.** El 31 de enero mas un mes da "31 de febrero", que JavaScript
 *    convierte en el 3 de marzo. Son tres dias de prueba regalados a todo el
 *    que se registre a fin de mes. Aqui se recorta al ultimo dia del mes
 *    destino.
 * 2. **Usa la hora local del servidor.** Todo lo demas del sistema es UTC; si
 *    esta funcion no lo fuera, el corte se movería al cambiar la zona horaria
 *    del contenedor.
 */
export function finDePrueba(desde: Date, meses: number = MESES_DE_PRUEBA_POR_DEFECTO): Date {
  const diaOriginal = desde.getUTCDate();
  const fin = new Date(desde.getTime());

  // Ir primero al dia 1 evita el desbordamiento al cambiar de mes.
  fin.setUTCDate(1);
  fin.setUTCMonth(fin.getUTCMonth() + meses);

  const ultimoDiaDelMes = new Date(
    Date.UTC(fin.getUTCFullYear(), fin.getUTCMonth() + 1, 0),
  ).getUTCDate();

  fin.setUTCDate(Math.min(diaOriginal, ultimoDiaDelMes));
  return fin;
}

// ---------------------------------------------------------------------------
// Transiciones
// ---------------------------------------------------------------------------

/**
 * Efecto secundario que hay que ejecutar al cambiar de estado.
 *
 * Se devuelve como dato y no se ejecuta aquí porque `core` no hace I/O. Quien
 * llama —un job de mantenimiento o el webhook del proveedor de pagos— traduce
 * cada accion a la llamada correspondiente. Asi la decision es probable sin
 * red ni base de datos, y la ejecucion es sustituible.
 */
export type AccionDeTransicion =
  | 'desconectar_canales'
  | 'reconectar_canales'
  | 'detener_bots'
  | 'reanudar_bots'
  | 'detener_ia'
  | 'reanudar_ia'
  | 'avisar_degradacion'
  | 'avisar_suspension'
  | 'avisar_reactivacion';

/**
 * Qué hay que hacer al pasar de un estado a otro.
 *
 * Deriva de la diferencia entre capacidades en lugar de estar escrito a mano
 * transición por transición. Con cuatro estados hay doce transiciones
 * posibles, y una tabla escrita a mano se desincroniza de las capacidades en
 * cuanto alguien añade un estado. Aquí no puede: si una capacidad cambia, la
 * acción aparece sola.
 */
export function accionesDeTransicion(
  anterior: EstadoEfectivo,
  nuevo: EstadoEfectivo,
): AccionDeTransicion[] {
  if (anterior === nuevo) return [];

  const antes = capacidadesDe(anterior);
  const ahora = capacidadesDe(nuevo);
  const acciones: AccionDeTransicion[] = [];

  if (antes.canalesConectados && !ahora.canalesConectados) acciones.push('desconectar_canales');
  if (!antes.canalesConectados && ahora.canalesConectados) acciones.push('reconectar_canales');

  if (antes.puedeEjecutarBots && !ahora.puedeEjecutarBots) acciones.push('detener_bots');
  if (!antes.puedeEjecutarBots && ahora.puedeEjecutarBots) acciones.push('reanudar_bots');

  if (antes.puedeUsarIa && !ahora.puedeUsarIa) acciones.push('detener_ia');
  if (!antes.puedeUsarIa && ahora.puedeUsarIa) acciones.push('reanudar_ia');

  // Los avisos van por estado de destino, no por diferencia de capacidades:
  // lo que se le cuenta al cliente depende de donde ha llegado.
  if (nuevo === 'gracia') acciones.push('avisar_degradacion');
  if (nuevo === 'suspendida') acciones.push('avisar_suspension');
  if ((nuevo === 'activa' || nuevo === 'prueba') && anterior !== 'prueba') {
    acciones.push('avisar_reactivacion');
  }

  return acciones;
}

/**
 * Error de negocio: algo que el usuario puede entender y, casi siempre,
 * corregir. Se distingue de un fallo nuestro en que lleva un **código
 * estable** —lo que la interfaz usa para decidir qué pintar— y un mensaje ya
 * redactado para personas.
 *
 * Vive en `core` porque lo lanzan varias capas (la puerta de envío, la
 * autenticación, los canales) y todas necesitan la MISMA clase: si cada una
 * declarara la suya, el filtro de errores de la API tendría que reconocerlas
 * una a una y el día que alguien añada la octava se le olvidará, con lo que un
 * «fuera de ventana» saldría como 500.
 *
 * **La concesión:** `httpStatus` es vocabulario HTTP dentro del dominio puro.
 * Se acepta a conciencia. La alternativa —una tabla de traducción de código a
 * estado en la API— separa mejor las capas y obliga a mantener dos listas
 * sincronizadas para no ganar nada: quien escribe la regla es quien sabe si
 * esto es un 409 o un 422.
 */
export class ErrorDeNegocio extends Error {
  constructor(
    readonly codigo: string,
    mensaje: string,
    readonly httpStatus = 400,
    /** Datos que la interfaz necesita para actuar (p. ej. plantillas sugeridas). */
    readonly detalle?: Record<string, unknown>,
  ) {
    super(mensaje);
    this.name = 'ErrorDeNegocio';
  }
}

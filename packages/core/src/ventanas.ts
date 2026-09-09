/**
 * Ventanas de sesión (ARCH §9).
 *
 * Vive en `core` y no en `channels` porque es una regla de negocio, y porque
 * el requisito "cero lógica de negocio en el frontend" solo se sostiene si el
 * cálculo está donde `apps/web` no puede importarlo.
 *
 * Lo que sí es de cada canal es la **política**: cuánto dura la ventana y qué
 * la reinicia. El adaptador la declara, esta función la aplica. Así el núcleo
 * no necesita saber que WhatsApp usa 24 horas.
 */

export interface PoliticaDeVentana {
  /**
   * Duración desde el último entrante. `null` cuando el canal no tiene
   * ventana, que puede ser el caso de TikTok — el adaptador lo declara en vez
   * de que el núcleo lo asuma.
   */
  duracionHoras: number | null;

  /**
   * Si un mensaje SALIENTE reinicia la ventana.
   *
   * En WhatsApp es `false`, y es la regla que más se malinterpreta: la ventana
   * la reinicia el cliente al escribir, no nosotros al responder. Codificarlo
   * al revés hace que el sistema crea que puede enviar cuando ya no puede, y
   * el error solo aparece cuando Meta rechaza el envío.
   */
  salienteReinicia: boolean;

  /**
   * Ventana de entrada gratuita, en horas.
   *
   * WhatsApp la abre cuando el contacto llega por un anuncio Click-to-WhatsApp
   * o por el botón de una página: 72 horas en las que todo es gratis. Es más
   * larga que la ventana normal, así que se toma la mayor de las dos.
   */
  entradaGratuitaHoras?: number | undefined;
}

const HORA = 60 * 60 * 1000;

/** Cómo se abrió la ventana. Cambia cuánto dura. */
export type OrigenDeVentana = 'mensaje' | 'entrada_gratuita';

/**
 * Instante en que expira la ventana, o `null` si el canal no tiene ninguna.
 *
 * Devuelve un instante y no unas horas restantes a propósito: se guarda en
 * `conversations.session_expires_at` y se compara contra `now()` en la API. Si
 * se guardaran horas, habría que recalcular en cada lectura y el resultado
 * dependería de cuándo se lee.
 */
export function calcularExpiracion(
  politica: PoliticaDeVentana,
  ultimoEntranteEn: Date | null,
  origen: OrigenDeVentana = 'mensaje',
): Date | null {
  if (politica.duracionHoras === null) return null;
  if (!ultimoEntranteEn) return null;

  const horas =
    origen === 'entrada_gratuita' && politica.entradaGratuitaHoras
      ? Math.max(politica.entradaGratuitaHoras, politica.duracionHoras)
      : politica.duracionHoras;

  return new Date(ultimoEntranteEn.getTime() + horas * HORA);
}

/**
 * Si la ventana permite enviar texto libre ahora.
 *
 * `null` en `expiraEn` significa que el canal no tiene ventana, y eso es
 * ABIERTA, no cerrada. Tratarlo como cerrada bloquearía un canal que no tiene
 * la restricción.
 */
export function ventanaAbierta(expiraEn: Date | null, ahora: Date): boolean {
  if (expiraEn === null) return true;
  return ahora < expiraEn;
}

/** Milisegundos que quedan. `null` si no hay ventana, `0` si ya cerró. */
export function tiempoRestante(expiraEn: Date | null, ahora: Date): number | null {
  if (expiraEn === null) return null;
  return Math.max(0, expiraEn.getTime() - ahora.getTime());
}

/**
 * Nueva expiración tras un mensaje.
 *
 * Encapsula la regla de `salienteReinicia` para que ningún adaptador tenga que
 * acordarse: si el canal no reinicia con salientes, la expiración anterior se
 * mantiene tal cual.
 */
export function expiracionTrasMensaje(
  politica: PoliticaDeVentana,
  direccion: 'inbound' | 'outbound',
  momento: Date,
  expiracionActual: Date | null,
  origen: OrigenDeVentana = 'mensaje',
): Date | null {
  if (direccion === 'inbound') return calcularExpiracion(politica, momento, origen);
  if (politica.salienteReinicia) return calcularExpiracion(politica, momento, origen);
  return expiracionActual;
}

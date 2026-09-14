import type { EstadoDeReserva } from '../../api/tipos.ts';

/**
 * Cómo se dice cada estado en pantalla. Un solo sitio: la lista, la ficha y
 * la conversación usan las mismas palabras, o recepción aprende tres.
 */
export const ESTADO_DE_RESERVA: Record<EstadoDeReserva, string> = {
  pendiente: 'Pendiente de confirmar',
  confirmada: 'Confirmada',
  en_casa: 'Huésped en casa',
  finalizada: 'Finalizada',
  cancelada: 'Cancelada',
};

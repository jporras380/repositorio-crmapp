/**
 * El ciclo de vida de una reserva, y lo que se debe.
 *
 * Dominio puro. Las transiciones no se deciden en un `if` repartido por el
 * controlador y la pantalla: se deciden aquí, y la API y la web preguntan.
 *
 *   pendiente ──confirmar──▶ confirmada ──llegar──▶ en_casa ──salir──▶ finalizada
 *       │                        │
 *       └──────cancelar──────────┴──▶ cancelada
 *
 * Las que NO existen, a propósito:
 *
 * - **No se cancela a alguien que ya está en casa.** Si el huésped se va
 *   antes, eso es una salida anticipada —se finaliza—; «cancelar» una estancia
 *   en curso borraría del historial que durmió allí.
 * - **No se llega sin confirmar.** Un check-in de una reserva pendiente es
 *   una reserva que nadie confirmó y que alguien aceptó en recepción; que el
 *   sistema obligue a confirmarla primero es lo que deja constancia.
 * - **Finalizada y cancelada son terminales.** Reabrirlas reescribe lo que
 *   ya pasó; si el cliente vuelve, es otra reserva.
 */

export type EstadoDeReserva = 'pendiente' | 'confirmada' | 'en_casa' | 'finalizada' | 'cancelada';

export type AccionDeReserva = 'confirmar' | 'llegar' | 'salir' | 'cancelar';

const TRANSICIONES: Record<AccionDeReserva, { desde: EstadoDeReserva[]; hasta: EstadoDeReserva }> =
  {
    confirmar: { desde: ['pendiente'], hasta: 'confirmada' },
    llegar: { desde: ['confirmada'], hasta: 'en_casa' },
    salir: { desde: ['en_casa'], hasta: 'finalizada' },
    cancelar: { desde: ['pendiente', 'confirmada'], hasta: 'cancelada' },
  };

export interface ResultadoDeTransicion {
  permitida: boolean;
  hasta?: EstadoDeReserva;
  motivo?: string;
}

export function transicionDeReserva(
  estado: EstadoDeReserva,
  accion: AccionDeReserva,
): ResultadoDeTransicion {
  const t = TRANSICIONES[accion];
  if (t.desde.includes(estado)) return { permitida: true, hasta: t.hasta };
  return {
    permitida: false,
    motivo: MOTIVOS[`${estado}:${accion}`] ?? motivoGenerico(estado, accion),
  };
}

/** Lo que se puede hacer con una reserva en este estado. La pantalla pinta botones con esto. */
export function accionesPosibles(estado: EstadoDeReserva): AccionDeReserva[] {
  return (Object.keys(TRANSICIONES) as AccionDeReserva[]).filter((a) =>
    TRANSICIONES[a].desde.includes(estado),
  );
}

/** Una reserva ocupa la habitación mientras no esté cancelada ni finalizada. */
export function reservaViva(estado: EstadoDeReserva): boolean {
  return estado === 'pendiente' || estado === 'confirmada' || estado === 'en_casa';
}

const MOTIVOS: Record<string, string> = {
  'en_casa:cancelar':
    'El huésped ya está en casa: si se va antes, registra la salida en vez de cancelar.',
  'pendiente:llegar': 'Confirma la reserva antes de registrar la llegada.',
  'finalizada:cancelar': 'La estancia ya terminó; no se puede cancelar.',
  'cancelada:confirmar': 'Una reserva cancelada no se reabre. Crea una nueva.',
};

function motivoGenerico(estado: EstadoDeReserva, accion: AccionDeReserva): string {
  return `No se puede ${VERBO[accion]} una reserva ${NOMBRE[estado]}.`;
}

const VERBO: Record<AccionDeReserva, string> = {
  confirmar: 'confirmar',
  llegar: 'registrar la llegada de',
  salir: 'registrar la salida de',
  cancelar: 'cancelar',
};

const NOMBRE: Record<EstadoDeReserva, string> = {
  pendiente: 'pendiente',
  confirmada: 'confirmada',
  en_casa: 'con el huésped en casa',
  finalizada: 'finalizada',
  cancelada: 'cancelada',
};

// ---------------------------------------------------------------------------
// Saldo
// ---------------------------------------------------------------------------

export interface Saldo {
  total: number;
  pagado: number;
  pendiente: number;
  /** Pagado de más: se dice, no se esconde en un pendiente negativo. */
  aFavor: number;
}

export function saldoDeReserva(total: number, pagos: number[]): Saldo {
  const pagado = pagos.reduce((s, p) => s + p, 0);
  return {
    total,
    pagado,
    pendiente: Math.max(0, total - pagado),
    aFavor: Math.max(0, pagado - total),
  };
}

// ---------------------------------------------------------------------------
// Solapes
// ---------------------------------------------------------------------------

/**
 * Dos estancias en la misma habitación se pisan si comparten al menos una
 * noche. Salir el 30 y entrar otro el 30 NO se pisa: el día de salida no es
 * noche. Con fechas `YYYY-MM-DD` la comparación de texto es la de calendario.
 */
export function seSolapan(
  a: { entrada: string; salida: string },
  b: { entrada: string; salida: string },
): boolean {
  return a.entrada < b.salida && b.entrada < a.salida;
}

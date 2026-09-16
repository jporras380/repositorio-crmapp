/**
 * Horario de atención del negocio (0027).
 *
 * Dominio puro: recibe el horario, la zona horaria y un instante, y dice si
 * está abierto. Sin base de datos y sin `new Date()` implícito, para que se
 * pueda probar un domingo a las tres de la mañana sin esperar al domingo.
 *
 * **La hora es la del hotel, no la del servidor.** Barranca es UTC−5 y el
 * servidor puede estar en cualquier sitio; con `Intl` se convierte el instante
 * a la hora local del negocio sin meter una dependencia de zonas horarias.
 */

/** `"09:00"`. Minutos desde medianoche, en hora local del negocio. */
export type HoraLocal = string;

/** Un tramo abierto: `["09:00", "13:00"]`. */
export type Tramo = [HoraLocal, HoraLocal];

/**
 * Día ISO (1 = lunes … 7 = domingo) → tramos abiertos. Un día que no aparece
 * está cerrado. Que no aparezca ninguno significa «siempre cerrado», no
 * «siempre abierto»: un horario vacío no puede leerse como 24/7 por accidente.
 */
export type Horario = Record<string, Tramo[]>;

const MINUTOS = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function esHoraValida(h: string): boolean {
  return MINUTOS.test(h);
}

function aMinutos(h: HoraLocal): number {
  const m = MINUTOS.exec(h);
  if (!m) return Number.NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Motivos por los que un horario no vale, para avisar antes de guardarlo. */
export type ErrorDeHorario =
  | { tipo: 'dia_invalido'; dia: string }
  | { tipo: 'hora_invalida'; dia: string; valor: string }
  | { tipo: 'tramo_al_reves'; dia: string; tramo: Tramo }
  | { tipo: 'tramos_se_solapan'; dia: string };

export function validarHorario(horario: Horario): ErrorDeHorario[] {
  const errores: ErrorDeHorario[] = [];
  for (const [dia, tramos] of Object.entries(horario)) {
    if (!/^[1-7]$/.test(dia)) {
      errores.push({ tipo: 'dia_invalido', dia });
      continue;
    }
    const minutos: [number, number][] = [];
    for (const tramo of tramos) {
      const [desde, hasta] = tramo;
      if (!esHoraValida(desde) || !esHoraValida(hasta)) {
        errores.push({ tipo: 'hora_invalida', dia, valor: esHoraValida(desde) ? hasta : desde });
        continue;
      }
      // Un tramo que termina antes de empezar no es «cruza la medianoche»: es
      // un error de escritura. Para trasnochar se pone un tramo en cada día.
      if (aMinutos(hasta) <= aMinutos(desde)) {
        errores.push({ tipo: 'tramo_al_reves', dia, tramo });
        continue;
      }
      minutos.push([aMinutos(desde), aMinutos(hasta)]);
    }
    minutos.sort((a, b) => a[0] - b[0]);
    if (minutos.some((t, i) => i > 0 && t[0] < minutos[i - 1]![1])) {
      errores.push({ tipo: 'tramos_se_solapan', dia });
    }
  }
  return errores;
}

const DIA_ISO: Record<string, string> = {
  Mon: '1',
  Tue: '2',
  Wed: '3',
  Thu: '4',
  Fri: '5',
  Sat: '6',
  Sun: '7',
};

/** El instante, visto desde la zona horaria del negocio: día ISO y minutos. */
export function momentoLocal(
  instante: Date,
  zonaHoraria: string,
): { dia: string; minutos: number } | null {
  let partes: Intl.DateTimeFormatPart[];
  try {
    partes = new Intl.DateTimeFormat('en-US', {
      timeZone: zonaHoraria,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instante);
  } catch {
    // Zona horaria desconocida: no se inventa una. Quien llama decide, y en el
    // aviso automático eso significa no enviar nada.
    return null;
  }
  const valor = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? '';
  const dia = DIA_ISO[valor('weekday')];
  if (!dia) return null;
  return { dia, minutos: Number(valor('hour')) * 60 + Number(valor('minute')) };
}

/**
 * ¿Está abierto el negocio en ese instante?
 *
 * `null` cuando no se puede saber (zona horaria desconocida): quien llama
 * decide qué hacer, y nunca se supone que está cerrado.
 */
export function estaAbierto(instante: Date, horario: Horario, zonaHoraria: string): boolean | null {
  const ahora = momentoLocal(instante, zonaHoraria);
  if (!ahora) return null;
  const tramos = horario[ahora.dia] ?? [];
  return tramos.some(([desde, hasta]) => {
    const d = aMinutos(desde);
    const h = aMinutos(hasta);
    // Abierto incluye la hora de apertura y excluye la de cierre: a las 20:00
    // de un horario que cierra a las 20:00 ya está cerrado.
    return Number.isFinite(d) && Number.isFinite(h) && ahora.minutos >= d && ahora.minutos < h;
  });
}

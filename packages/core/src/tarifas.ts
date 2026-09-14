/**
 * Cuánto cuesta una estancia.
 *
 * Dominio puro: fechas, tarifas y servicios entran; un total con su desglose
 * y la lista de problemas salen. Lo usan el cotizador que el agente abre
 * mientras chatea y, en el PR siguiente, la reserva — y tiene que dar lo
 * mismo en los dos sitios, así que vive aquí y en ningún otro.
 *
 * ## Las reglas que costaría dinero equivocar
 *
 * - **Una noche es la fecha de entrada hasta el día antes de la salida.** El
 *   día de salida no se cobra. Entrar el 27 y salir el 30 son TRES noches:
 *   27, 28 y 29.
 * - **Si dos tarifas cubren la misma noche, gana la de rango más corto.**
 *   «Temporada alta» (enero–marzo) y dentro «Carnavales» (tres días): quien
 *   creó Carnavales lo hizo a propósito para esas noches. A igual rango, gana
 *   la creada después — que es la corrección de la otra.
 * - **Se cotiza por noche, no por estancia.** Una estancia que empieza en
 *   temporada baja y termina en alta cobra cada noche a su precio. Promediar
 *   o aplicar la tarifa del primer día es la forma habitual de regalar o
 *   cobrar de más sin que nadie lo vea.
 * - **Nunca se inventa un precio.** Una noche sin tarifa y sin precio base NO
 *   vale cero: se devuelve como problema, y la interfaz no deja mandar esa
 *   cotización como si estuviera completa.
 *
 * Las fechas son de calendario —`YYYY-MM-DD`, sin hora ni zona— y se recorren
 * en UTC. La noche del 28 de julio es la del 28 en Barranca; hacer la cuenta
 * con horas locales es como un cambio de horario convierte tres noches en dos.
 */

export type UnidadDeServicio = 'por_estancia' | 'por_noche' | 'por_persona_noche';

export interface TarifaParaCotizar {
  id: string;
  nombre: string;
  /** `YYYY-MM-DD`, inclusive. */
  desde: string;
  /** `YYYY-MM-DD`, inclusive. */
  hasta: string;
  /** Céntimos por noche. */
  precio: number;
  minNoches: number;
  /** 0 = domingo … 6 = sábado. `null` = todos los días. */
  dias: number[] | null;
}

export interface ServicioParaCotizar {
  id: string;
  nombre: string;
  precio: number;
  unidad: UnidadDeServicio;
}

export interface PeticionDeCotizacion {
  entrada: string;
  salida: string;
  personas: number;
  capacidad: number;
  /** Céntimos por noche cuando ninguna tarifa aplica. `null` = sin precio de lista. */
  precioBase: number | null;
  moneda: string;
  /** En orden de creación: ante un empate, gana la última. */
  tarifas: TarifaParaCotizar[];
  /**
   * `YYYY-MM-DD`. Si llega, una entrada anterior se avisa. Lo pasa quien
   * sabe qué día es; el dominio no mira el reloj.
   */
  hoy?: string;
  servicios?: ServicioParaCotizar[];
}

export type CodigoDeProblemaDeCotizacion =
  | 'fechas_invalidas'
  | 'entrada_pasada'
  | 'sin_noches'
  | 'estancia_demasiado_larga'
  | 'noche_sin_precio'
  | 'minimo_de_noches'
  | 'excede_capacidad';

export interface ProblemaDeCotizacion {
  codigo: CodigoDeProblemaDeCotizacion;
  mensaje: string;
  fecha?: string;
}

export interface NocheCotizada {
  fecha: string;
  precio: number;
  /** Nombre de la tarifa aplicada; `null` si se usó el precio base. */
  tarifa: string | null;
}

export interface LineaDeServicio {
  nombre: string;
  cantidad: number;
  precioUnitario: number;
  total: number;
}

export interface Cotizacion {
  noches: number;
  personas: number;
  moneda: string;
  detalle: NocheCotizada[];
  alojamiento: number;
  servicios: LineaDeServicio[];
  total: number;
  problemas: ProblemaDeCotizacion[];
  /** `false` si falta algún precio: esa cifra no se le puede dar a un cliente. */
  completa: boolean;
}

/** Tope de noches por cotización: más que esto es un contrato, no una estancia. */
export const MAX_NOCHES = 90;

const DIA_MS = 86_400_000;

export function cotizarEstancia(p: PeticionDeCotizacion): Cotizacion {
  const problemas: ProblemaDeCotizacion[] = [];
  const vacia = (): Cotizacion => ({
    noches: 0,
    personas: p.personas,
    moneda: p.moneda,
    detalle: [],
    alojamiento: 0,
    servicios: [],
    total: 0,
    problemas,
    completa: false,
  });

  const inicio = aDia(p.entrada);
  const fin = aDia(p.salida);
  if (inicio === null || fin === null) {
    problemas.push({ codigo: 'fechas_invalidas', mensaje: 'Las fechas no son válidas.' });
    return vacia();
  }
  const noches = Math.round((fin - inicio) / DIA_MS);
  if (noches <= 0) {
    problemas.push({
      codigo: 'sin_noches',
      mensaje: 'La salida tiene que ser posterior a la entrada.',
    });
    return vacia();
  }
  if (noches > MAX_NOCHES) {
    problemas.push({
      codigo: 'estancia_demasiado_larga',
      mensaje: `Una cotización llega a ${MAX_NOCHES} noches como mucho.`,
    });
    return vacia();
  }

  // Equivocarse de año al reservar es de los errores más comunes en
  // recepción, y el sistema lo aceptaba en silencio. Es un AVISO y no un
  // bloqueo: registrar tarde la estancia de alguien que ya vino es legítimo.
  if (p.hoy && p.entrada < p.hoy) {
    problemas.push({
      codigo: 'entrada_pasada',
      mensaje: `La entrada (${p.entrada}) ya pasó. ¿Es el año correcto?`,
    });
  }

  if (p.personas > p.capacidad) {
    problemas.push({
      codigo: 'excede_capacidad',
      mensaje: `Son ${p.personas} personas y el tipo admite ${p.capacidad}.`,
    });
  }

  const detalle: NocheCotizada[] = [];
  const tarifasUsadas = new Map<string, TarifaParaCotizar>();

  for (let i = 0; i < noches; i++) {
    const dia = inicio + i * DIA_MS;
    const fecha = aTexto(dia);
    const tarifa = tarifaDeLaNoche(p.tarifas, dia);
    if (tarifa) {
      tarifasUsadas.set(tarifa.id, tarifa);
      detalle.push({ fecha, precio: tarifa.precio, tarifa: tarifa.nombre });
    } else if (p.precioBase !== null) {
      detalle.push({ fecha, precio: p.precioBase, tarifa: null });
    } else {
      detalle.push({ fecha, precio: 0, tarifa: null });
      problemas.push({
        codigo: 'noche_sin_precio',
        mensaje: `La noche del ${fecha} no tiene tarifa ni precio base.`,
        fecha,
      });
    }
  }

  for (const t of tarifasUsadas.values()) {
    if (noches < t.minNoches) {
      problemas.push({
        codigo: 'minimo_de_noches',
        mensaje: `«${t.nombre}» pide un mínimo de ${t.minNoches} noches.`,
      });
    }
  }

  const alojamiento = detalle.reduce((s, n) => s + n.precio, 0);
  const servicios = (p.servicios ?? []).map((s) => {
    const cantidad =
      s.unidad === 'por_estancia' ? 1 : s.unidad === 'por_noche' ? noches : noches * p.personas;
    return { nombre: s.nombre, cantidad, precioUnitario: s.precio, total: cantidad * s.precio };
  });
  const total = alojamiento + servicios.reduce((s, l) => s + l.total, 0);

  return {
    noches,
    personas: p.personas,
    moneda: p.moneda,
    detalle,
    alojamiento,
    servicios,
    total,
    problemas,
    // Una cotización con un mínimo de noches incumplido o con más personas
    // de las que caben SÍ tiene cifra; lo que no tiene es precio completo si
    // falta una noche. Son avisos distintos y la interfaz los pinta distinto.
    completa: !problemas.some((x) => x.codigo === 'noche_sin_precio'),
  };
}

/**
 * La tarifa que manda en una noche: entre las que la cubren, la de rango más
 * corto; a igual rango, la última de la lista (la creada después).
 */
function tarifaDeLaNoche(tarifas: TarifaParaCotizar[], dia: number): TarifaParaCotizar | null {
  const semana = new Date(dia).getUTCDay();
  let mejor: TarifaParaCotizar | null = null;
  let mejorRango = Infinity;
  for (const t of tarifas) {
    const desde = aDia(t.desde);
    const hasta = aDia(t.hasta);
    if (desde === null || hasta === null) continue;
    if (dia < desde || dia > hasta) continue;
    if (t.dias && !t.dias.includes(semana)) continue;
    const rango = hasta - desde;
    // `<=` y no `<`: a igual rango, la que viene después en la lista gana.
    if (rango <= mejorRango) {
      mejor = t;
      mejorRango = rango;
    }
  }
  return mejor;
}

/** `YYYY-MM-DD` → milisegundos de medianoche UTC, o `null` si no es una fecha real. */
function aDia(texto: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  if (!m) return null;
  const [a, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(a, mes - 1, d);
  const f = new Date(ms);
  // Rechaza el 31 de febrero, que Date convierte en silencio en 3 de marzo.
  if (f.getUTCFullYear() !== a || f.getUTCMonth() !== mes - 1 || f.getUTCDate() !== d) {
    return null;
  }
  return ms;
}

function aTexto(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

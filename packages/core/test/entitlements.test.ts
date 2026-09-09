/**
 * Tests del ciclo de vida de la suscripción.
 *
 * Sin base de datos ni relojes reales: `core` es dominio puro y `ahora` es un
 * parámetro. Eso permite probar el instante exacto del corte, que es donde
 * están los errores de esta clase de lógica.
 *
 * Un bug aquí bloquea a un cliente que paga, o deja enviar gratis a uno que no.
 * Las dos cosas cuestan dinero.
 */
import { describe, expect, it } from 'vitest';
import {
  DIAS_DE_GRACIA_POR_DEFECTO,
  accesoHasta,
  accionesDeTransicion,
  capacidades,
  diasHastaElProximoCorte,
  estadoEfectivo,
  evaluarEnvio,
  finDePrueba,
  graciaHasta,
  type Suscripcion,
} from '../src/entitlements.js';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const dias = (n: number) => n * 24 * 60 * 60 * 1000;
const desplazar = (base: Date, ms: number) => new Date(base.getTime() + ms);

const enPrueba: Suscripcion = {
  estadoDeclarado: 'trialing',
  pruebaHasta: new Date('2026-02-01T00:00:00.000Z'),
  periodoHasta: null,
  diasDeGracia: DIAS_DE_GRACIA_POR_DEFECTO,
};

const pagada: Suscripcion = {
  estadoDeclarado: 'active',
  pruebaHasta: new Date('2026-02-01T00:00:00.000Z'),
  periodoHasta: new Date('2026-03-01T00:00:00.000Z'),
  diasDeGracia: DIAS_DE_GRACIA_POR_DEFECTO,
};

describe('el mes de prueba', () => {
  it('durante la prueba se puede todo', () => {
    expect(estadoEfectivo(enPrueba, T0)).toBe('prueba');
    const c = capacidades(enPrueba, T0);
    expect(c.puedeEnviarTexto).toBe(true);
    expect(c.puedeEnviarMedios).toBe(true);
    expect(c.puedeEjecutarBots).toBe(true);
  });

  it('el último instante de la prueba todavía es prueba', () => {
    // El límite exacto es donde viven los errores de esta lógica.
    const unMsAntes = desplazar(enPrueba.pruebaHasta!, -1);
    expect(estadoEfectivo(enPrueba, unMsAntes)).toBe('prueba');
  });

  it('justo al caducar entra en gracia, no en suspensión', () => {
    expect(estadoEfectivo(enPrueba, enPrueba.pruebaHasta!)).toBe('gracia');
  });

  it('en gracia solo se envía texto', () => {
    const enGracia = desplazar(enPrueba.pruebaHasta!, dias(3));
    const c = capacidades(enPrueba, enGracia);
    expect(c.puedeEnviarTexto).toBe(true);
    expect(c.puedeEnviarMedios).toBe(false);
    expect(c.puedeEnviarPlantillas).toBe(false);
  });

  it('la gracia dura exactamente siete días', () => {
    const casiFin = desplazar(enPrueba.pruebaHasta!, dias(7) - 1);
    const justoFin = desplazar(enPrueba.pruebaHasta!, dias(7));
    expect(estadoEfectivo(enPrueba, casiFin)).toBe('gracia');
    expect(estadoEfectivo(enPrueba, justoFin)).toBe('suspendida');
  });

  it('pasada la gracia no se envía nada', () => {
    const suspendida = desplazar(enPrueba.pruebaHasta!, dias(10));
    const c = capacidades(enPrueba, suspendida);
    expect(c.puedeEnviarTexto).toBe(false);
    expect(c.soloLectura).toBe(true);
  });
});

describe('la no renovación de un plan pagado sigue el mismo camino', () => {
  it('mientras el periodo está vigente, todo funciona', () => {
    expect(estadoEfectivo(pagada, new Date('2026-02-15T00:00:00.000Z'))).toBe('activa');
    expect(capacidades(pagada, new Date('2026-02-15T00:00:00.000Z')).puedeEnviarMedios).toBe(true);
  });

  it('el periodo pagado manda sobre la prueba', () => {
    // Si el cliente pagó a mitad de prueba, vale lo que compró. Sin esto, un
    // cliente que paga pronto se quedaría degradado al acabar la prueba pese
    // a estar al día.
    const traslFinDePrueba = new Date('2026-02-10T00:00:00.000Z');
    expect(traslFinDePrueba > pagada.pruebaHasta!).toBe(true);
    expect(estadoEfectivo(pagada, traslFinDePrueba)).toBe('activa');
    expect(accesoHasta(pagada)).toEqual(pagada.periodoHasta);
  });

  it('al no renovar entra en gracia degradada', () => {
    const traslPeriodo = desplazar(pagada.periodoHasta!, dias(2));
    expect(estadoEfectivo(pagada, traslPeriodo)).toBe('gracia');
    const c = capacidades(pagada, traslPeriodo);
    expect(c.puedeEnviarTexto).toBe(true);
    expect(c.puedeEnviarMedios).toBe(false);
  });

  it('y una semana después queda suspendida', () => {
    const traslGracia = desplazar(pagada.periodoHasta!, dias(8));
    expect(estadoEfectivo(pagada, traslGracia)).toBe('suspendida');
  });
});

describe('cancelar no corta a mitad de periodo', () => {
  it('el cliente conserva lo que pagó', () => {
    // Cancelar significa "no renueves", no "córtame ahora". Cortar al
    // cancelar es quedarse con dinero por un servicio no prestado.
    const cancelada: Suscripcion = { ...pagada, estadoDeclarado: 'cancelled' };
    expect(estadoEfectivo(cancelada, new Date('2026-02-15T00:00:00.000Z'))).toBe('activa');
  });

  it('y al llegar el fin sigue el mismo camino que un impago', () => {
    const cancelada: Suscripcion = { ...pagada, estadoDeclarado: 'cancelled' };
    expect(estadoEfectivo(cancelada, desplazar(pagada.periodoHasta!, dias(1)))).toBe('gracia');
    expect(estadoEfectivo(cancelada, desplazar(pagada.periodoHasta!, dias(9)))).toBe('suspendida');
  });
});

describe('el estado se deriva de las fechas, no de la columna', () => {
  it('una columna obsoleta no da acceso de más', () => {
    // La columna `status` la mantiene un job. Si la política confiara en ella,
    // un cliente cuya gracia venció a las 3 de la mañana seguiría enviando
    // hasta que el cron pasara.
    const desactualizada: Suscripcion = {
      estadoDeclarado: 'active', // el job todavía no la ha bajado
      pruebaHasta: null,
      periodoHasta: new Date('2026-01-01T00:00:00.000Z'),
      diasDeGracia: 7,
    };
    expect(estadoEfectivo(desactualizada, new Date('2026-03-01T00:00:00.000Z'))).toBe('suspendida');
  });

  it('sin ninguna fecha, la cuenta está suspendida', () => {
    // Fallar cerrado: una suscripción sin fechas es un estado corrupto, y ante
    // la duda no se envía.
    const rota: Suscripcion = {
      estadoDeclarado: 'active',
      pruebaHasta: null,
      periodoHasta: null,
      diasDeGracia: 7,
    };
    expect(estadoEfectivo(rota, T0)).toBe('suspendida');
  });
});

describe('los días de gracia son por suscripción', () => {
  it('cambiar el valor por defecto no afecta a las suscripciones vivas', () => {
    // Si el plazo fuera una constante leída al evaluar, pasar de 7 a 14 días
    // alargaría la gracia de todos los clientes vivos, retroactivamente.
    const conCatorce: Suscripcion = { ...enPrueba, diasDeGracia: 14 };
    const alDia10 = desplazar(enPrueba.pruebaHasta!, dias(10));
    expect(estadoEfectivo(enPrueba, alDia10)).toBe('suspendida');
    expect(estadoEfectivo(conCatorce, alDia10)).toBe('gracia');
  });

  it('gracia de cero días salta directo a suspensión', () => {
    const sinGracia: Suscripcion = { ...enPrueba, diasDeGracia: 0 };
    expect(estadoEfectivo(sinGracia, enPrueba.pruebaHasta!)).toBe('suspendida');
  });
});

describe('evaluarEnvio', () => {
  const enGracia = desplazar(enPrueba.pruebaHasta!, dias(2));
  const suspendida = desplazar(enPrueba.pruebaHasta!, dias(20));

  it('en gracia deja pasar el texto', () => {
    const d = evaluarEnvio(enPrueba, { tipo: 'texto', origen: 'human' }, enGracia);
    expect(d.permitido).toBe(true);
    expect(d.estado).toBe('gracia');
  });

  it.each(['imagen', 'video', 'audio', 'documento', 'sticker'] as const)(
    'en gracia bloquea %s',
    (tipo) => {
      const d = evaluarEnvio(enPrueba, { tipo, origen: 'human' }, enGracia);
      expect(d.permitido).toBe(false);
      expect(d.motivo).toBe('medios_no_permitidos_en_gracia');
      // El mensaje va a la interfaz: un "no permitido" sin explicación es un
      // ticket de soporte.
      expect(d.mensaje).toMatch(/solo se pueden enviar mensajes de texto/i);
    },
  );

  it('en gracia bloquea plantillas, porque pueden llevar medios en la cabecera', () => {
    const d = evaluarEnvio(enPrueba, { tipo: 'plantilla', origen: 'human' }, enGracia);
    expect(d.permitido).toBe(false);
    expect(d.motivo).toBe('plantillas_no_permitidas_en_gracia');
  });

  it('en gracia los bots están detenidos aunque envíen texto', () => {
    const d = evaluarEnvio(enPrueba, { tipo: 'texto', origen: 'bot' }, enGracia);
    expect(d.permitido).toBe(false);
    expect(d.motivo).toBe('bots_detenidos');
  });

  it('en gracia la IA está detenida', () => {
    // Cuesta dinero nuestro en tokens: gasto sin ingreso.
    const d = evaluarEnvio(enPrueba, { tipo: 'texto', origen: 'ai' }, enGracia);
    expect(d.permitido).toBe(false);
    expect(d.motivo).toBe('ia_detenida');
  });

  it('suspendida no deja pasar ni el texto', () => {
    const d = evaluarEnvio(enPrueba, { tipo: 'texto', origen: 'human' }, suspendida);
    expect(d.permitido).toBe(false);
    expect(d.motivo).toBe('suscripcion_suspendida');
    expect(d.mensaje).toMatch(/exportar tu historial/i);
  });

  it('durante la prueba pasa todo', () => {
    for (const tipo of ['texto', 'imagen', 'video', 'plantilla'] as const) {
      expect(evaluarEnvio(enPrueba, { tipo, origen: 'human' }, T0).permitido).toBe(true);
    }
  });
});

describe('los entrantes se persisten siempre', () => {
  it.each(['prueba', 'gracia', 'suspendida'] as const)(
    'en estado %s se guarda el crudo',
    (esperado) => {
      const momento =
        esperado === 'prueba'
          ? T0
          : esperado === 'gracia'
            ? desplazar(enPrueba.pruebaHasta!, dias(2))
            : desplazar(enPrueba.pruebaHasta!, dias(20));

      expect(estadoEfectivo(enPrueba, momento)).toBe(esperado);
      // Meta no sabe nada de nuestra facturación. Rechazar sus webhooks
      // perdería los mensajes del cliente para siempre y puede llevar a Meta a
      // desactivar el webhook.
      expect(capacidades(enPrueba, momento).persisteEntrantesEnCrudo).toBe(true);
    },
  );

  it('pero solo se muestran mientras no esté suspendida', () => {
    const enGracia = desplazar(enPrueba.pruebaHasta!, dias(2));
    const suspendida = desplazar(enPrueba.pruebaHasta!, dias(20));
    expect(capacidades(enPrueba, enGracia).muestraEntrantes).toBe(true);
    expect(capacidades(enPrueba, suspendida).muestraEntrantes).toBe(false);
  });
});

describe('avisos', () => {
  it('cuenta los días que faltan para el corte', () => {
    // Un cliente que se entera de que le cortaron cuando intenta responder a
    // alguien es un cliente que se va.
    const aQuinceDias = new Date('2026-01-17T00:00:00.000Z');
    expect(diasHastaElProximoCorte(enPrueba, aQuinceDias)).toBe(15);
  });

  it('en gracia cuenta hacia la suspensión, no hacia el fin de prueba', () => {
    const enGracia = desplazar(enPrueba.pruebaHasta!, dias(2));
    expect(diasHastaElProximoCorte(enPrueba, enGracia)).toBe(5);
  });

  it('suspendida ya no tiene siguiente corte', () => {
    const suspendida = desplazar(enPrueba.pruebaHasta!, dias(20));
    expect(diasHastaElProximoCorte(enPrueba, suspendida)).toBeNull();
  });
});

describe('finDePrueba', () => {
  it('un mes natural, no treinta días', () => {
    expect(finDePrueba(new Date('2026-01-15T10:00:00.000Z')).toISOString()).toBe(
      '2026-02-15T10:00:00.000Z',
    );
  });

  it('el 31 de enero cae en el último día de febrero, no se desborda a marzo', () => {
    // setMonth desbordaría a marzo. Es el clásico bug de fechas que regala una
    // semana gratis a quien se registra a fin de mes.
    const fin = finDePrueba(new Date('2026-01-31T00:00:00.000Z'));
    expect(fin.getUTCMonth()).toBe(1);
    expect(fin.getUTCDate()).toBe(28);
  });
});

describe('graciaHasta', () => {
  it('es el fin de acceso más los días de gracia', () => {
    expect(graciaHasta(enPrueba)).toEqual(desplazar(enPrueba.pruebaHasta!, dias(7)));
  });

  it('sin fin de acceso no hay gracia', () => {
    expect(graciaHasta({ ...enPrueba, pruebaHasta: null, periodoHasta: null })).toBeNull();
  });
});

describe('desconexion de canales al suspender', () => {
  const enGracia = desplazar(enPrueba.pruebaHasta!, dias(2));
  const suspendida = desplazar(enPrueba.pruebaHasta!, dias(20));

  it('en prueba y en gracia los canales siguen conectados', () => {
    expect(capacidades(enPrueba, T0).canalesConectados).toBe(true);
    expect(capacidades(enPrueba, enGracia).canalesConectados).toBe(true);
  });

  it('al suspender se desconectan', () => {
    // Desconectar y no rechazar webhooks: rechazarlos provoca reintentos de
    // Meta y, sostenido, puede llevar a que desactive nuestro webhook.
    expect(capacidades(enPrueba, suspendida).canalesConectados).toBe(false);
  });
});

describe('acciones de transicion', () => {
  it('de gracia a suspendida hay que desconectar y avisar', () => {
    expect(accionesDeTransicion('gracia', 'suspendida')).toEqual([
      'desconectar_canales',
      'avisar_suspension',
    ]);
  });

  it('de activa a gracia se paran bots e IA', () => {
    const acciones = accionesDeTransicion('activa', 'gracia');
    expect(acciones).toContain('detener_bots');
    expect(acciones).toContain('detener_ia');
    expect(acciones).toContain('avisar_degradacion');
    // Los canales NO se tocan: en gracia se sigue atendiendo.
    expect(acciones).not.toContain('desconectar_canales');
  });

  it('al pagar desde suspension se reconecta todo', () => {
    const acciones = accionesDeTransicion('suspendida', 'activa');
    expect(acciones).toEqual([
      'reconectar_canales',
      'reanudar_bots',
      'reanudar_ia',
      'avisar_reactivacion',
    ]);
  });

  it('quedarse en el mismo estado no dispara nada', () => {
    // El job de mantenimiento pasa cada hora sobre todas las suscripciones.
    // Sin esto, reenviaria el aviso de suspension cada hora.
    expect(accionesDeTransicion('gracia', 'gracia')).toEqual([]);
  });

  it('de prueba a activa no molesta al cliente con un aviso', () => {
    // Pagar durante la prueba no es una "reactivacion": nunca se corto nada.
    expect(accionesDeTransicion('prueba', 'activa')).toEqual([]);
  });
});

describe('finDePrueba: casos de borde de calendario', () => {
  it('el 31 de marzo cae en el 30 de abril', () => {
    expect(finDePrueba(new Date('2026-03-31T12:00:00.000Z')).toISOString()).toBe(
      '2026-04-30T12:00:00.000Z',
    );
  });

  it('en anio bisiesto el 31 de enero cae en el 29 de febrero', () => {
    expect(finDePrueba(new Date('2028-01-31T00:00:00.000Z')).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });

  it('conserva la hora exacta', () => {
    // El corte es a la hora del alta, no a medianoche: dar hasta medianoche
    // regala horas, cortar a medianoche las quita.
    expect(finDePrueba(new Date('2026-01-15T18:42:07.123Z')).toISOString()).toBe(
      '2026-02-15T18:42:07.123Z',
    );
  });

  it('diciembre cruza de anio', () => {
    expect(finDePrueba(new Date('2026-12-15T00:00:00.000Z')).toISOString()).toBe(
      '2027-01-15T00:00:00.000Z',
    );
  });
});

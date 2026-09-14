/**
 * Cotizar una estancia.
 *
 * Cada caso es un error que se come dinero en silencio: cobrar la noche de
 * salida, aplicar la tarifa del primer día a toda la estancia, o darle a un
 * cliente un total con una noche a cero.
 */
import { describe, expect, it } from 'vitest';
import { cotizarEstancia, type PeticionDeCotizacion } from '../src/tarifas.js';

const base = (extra: Partial<PeticionDeCotizacion> = {}): PeticionDeCotizacion => ({
  entrada: '2026-07-27',
  salida: '2026-07-30',
  personas: 2,
  capacidad: 4,
  precioBase: 20_000, // S/ 200
  moneda: 'PEN',
  tarifas: [],
  ...extra,
});

const tarifa = (
  id: string,
  desde: string,
  hasta: string,
  precio: number,
  extra: { minNoches?: number; dias?: number[] | null } = {},
) => ({
  id,
  nombre: id,
  desde,
  hasta,
  precio,
  minNoches: extra.minNoches ?? 1,
  dias: extra.dias ?? null,
});

describe('las noches', () => {
  it('entrar el 27 y salir el 30 son tres noches: el día de salida no se cobra', () => {
    const c = cotizarEstancia(base());
    expect(c.noches).toBe(3);
    expect(c.detalle.map((n) => n.fecha)).toEqual(['2026-07-27', '2026-07-28', '2026-07-29']);
    expect(c.total).toBe(60_000);
  });

  it('salir el mismo día o antes no es una estancia', () => {
    expect(cotizarEstancia(base({ salida: '2026-07-27' })).problemas[0]?.codigo).toBe('sin_noches');
    expect(cotizarEstancia(base({ salida: '2026-07-20' })).problemas[0]?.codigo).toBe('sin_noches');
  });

  it('el 31 de febrero no existe, aunque Date lo convierta en 3 de marzo', () => {
    const c = cotizarEstancia(base({ entrada: '2027-02-31', salida: '2027-03-05' }));
    expect(c.problemas[0]?.codigo).toBe('fechas_invalidas');
    expect(c.completa).toBe(false);
  });

  it('cruzar fin de mes y fin de año no pierde noches', () => {
    const c = cotizarEstancia(base({ entrada: '2026-12-30', salida: '2027-01-02' }));
    expect(c.detalle.map((n) => n.fecha)).toEqual(['2026-12-30', '2026-12-31', '2027-01-01']);
  });

  it('tres meses es el tope de una cotización', () => {
    const c = cotizarEstancia(base({ entrada: '2026-01-01', salida: '2026-06-01' }));
    expect(c.problemas[0]?.codigo).toBe('estancia_demasiado_larga');
  });
});

describe('qué tarifa manda', () => {
  it('se cotiza noche a noche: una estancia a caballo de dos temporadas cobra cada una a su precio', () => {
    const c = cotizarEstancia(
      base({
        entrada: '2026-07-26',
        salida: '2026-07-29',
        tarifas: [tarifa('Fiestas Patrias', '2026-07-27', '2026-07-30', 45_000)],
      }),
    );
    // 26: base; 27 y 28: Fiestas Patrias.
    expect(c.detalle.map((n) => n.precio)).toEqual([20_000, 45_000, 45_000]);
    expect(c.detalle[0]!.tarifa).toBeNull();
    expect(c.total).toBe(110_000);
  });

  it('si dos tarifas se pisan, gana la de rango más corto: la específica', () => {
    const c = cotizarEstancia(
      base({
        entrada: '2026-07-28',
        salida: '2026-07-29',
        tarifas: [
          tarifa('Temporada alta', '2026-07-01', '2026-08-31', 30_000),
          tarifa('Fiestas Patrias', '2026-07-27', '2026-07-30', 45_000),
        ],
      }),
    );
    expect(c.detalle[0]).toMatchObject({ tarifa: 'Fiestas Patrias', precio: 45_000 });
  });

  it('el orden de creación NO decide entre rangos distintos', () => {
    // Creada primero la corta: tiene que seguir ganando.
    const c = cotizarEstancia(
      base({
        entrada: '2026-07-28',
        salida: '2026-07-29',
        tarifas: [
          tarifa('Fiestas Patrias', '2026-07-27', '2026-07-30', 45_000),
          tarifa('Temporada alta', '2026-07-01', '2026-08-31', 30_000),
        ],
      }),
    );
    expect(c.detalle[0]!.tarifa).toBe('Fiestas Patrias');
  });

  it('a igual rango gana la creada después: es la corrección de la otra', () => {
    const c = cotizarEstancia(
      base({
        entrada: '2026-07-28',
        salida: '2026-07-29',
        tarifas: [
          tarifa('Verano (vieja)', '2026-07-01', '2026-07-31', 30_000),
          tarifa('Verano (corregida)', '2026-07-01', '2026-07-31', 32_000),
        ],
      }),
    );
    expect(c.detalle[0]!.tarifa).toBe('Verano (corregida)');
  });

  it('una tarifa de fin de semana solo toca viernes y sábado', () => {
    // 2026-07-24 es viernes.
    const c = cotizarEstancia(
      base({
        entrada: '2026-07-23',
        salida: '2026-07-27',
        tarifas: [tarifa('Fin de semana', '2026-01-01', '2026-12-31', 28_000, { dias: [5, 6] })],
      }),
    );
    // jueves base, viernes y sábado fin de semana, domingo base
    expect(c.detalle.map((n) => n.precio)).toEqual([20_000, 28_000, 28_000, 20_000]);
  });
});

describe('lo que no se puede dar por bueno', () => {
  it('una noche sin tarifa ni precio base no vale cero: es un problema y la cotización no está completa', () => {
    const c = cotizarEstancia(
      base({
        precioBase: null,
        tarifas: [tarifa('Solo el 27', '2026-07-27', '2026-07-27', 45_000)],
      }),
    );
    expect(c.completa).toBe(false);
    expect(c.problemas.filter((p) => p.codigo === 'noche_sin_precio').map((p) => p.fecha)).toEqual([
      '2026-07-28',
      '2026-07-29',
    ]);
  });

  it('el mínimo de noches avisa, pero la cifra sigue siendo real', () => {
    const c = cotizarEstancia(
      base({
        entrada: '2026-07-28',
        salida: '2026-07-29',
        tarifas: [tarifa('Fiestas Patrias', '2026-07-27', '2026-07-30', 45_000, { minNoches: 2 })],
      }),
    );
    expect(c.problemas[0]?.codigo).toBe('minimo_de_noches');
    expect(c.completa).toBe(true);
    expect(c.total).toBe(45_000);
  });

  it('más personas de las que caben se avisa', () => {
    const c = cotizarEstancia(base({ personas: 6, capacidad: 4 }));
    expect(c.problemas.some((p) => p.codigo === 'excede_capacidad')).toBe(true);
  });
});

describe('la fecha de hoy', () => {
  it('una entrada en el pasado se avisa, pero la cifra sigue siendo real', () => {
    const c = cotizarEstancia(
      base({ entrada: '2026-07-27', salida: '2026-07-30', hoy: '2026-09-14' }),
    );
    expect(c.problemas.map((p) => p.codigo)).toEqual(['entrada_pasada']);
    expect(c.completa).toBe(true);
    expect(c.total).toBe(60_000);
  });

  it('sin decirle qué día es, no avisa: el dominio no mira el reloj', () => {
    expect(cotizarEstancia(base()).problemas).toEqual([]);
  });

  it('entrar hoy no es entrar en el pasado', () => {
    expect(cotizarEstancia(base({ hoy: '2026-07-27' })).problemas).toEqual([]);
  });
});

describe('servicios', () => {
  it('cada unidad multiplica por lo suyo: estancia, noche o persona y noche', () => {
    const c = cotizarEstancia(
      base({
        personas: 3,
        servicios: [
          { id: 's1', nombre: 'Limpieza final', precio: 3_000, unidad: 'por_estancia' },
          { id: 's2', nombre: 'Cochera', precio: 1_000, unidad: 'por_noche' },
          { id: 's3', nombre: 'Desayuno', precio: 1_500, unidad: 'por_persona_noche' },
        ],
      }),
    );
    expect(c.servicios.map((s) => [s.nombre, s.cantidad, s.total])).toEqual([
      ['Limpieza final', 1, 3_000],
      ['Cochera', 3, 3_000],
      // 3 personas × 3 noches: nueve desayunos, no uno.
      ['Desayuno', 9, 13_500],
    ]);
    expect(c.total).toBe(60_000 + 3_000 + 3_000 + 13_500);
  });
});

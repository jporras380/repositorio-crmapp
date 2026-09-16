/**
 * Validación de plantillas HSM. Lo que se prueba es la diferencia entre lo
 * que Meta rechaza SIEMPRE (error: no se gasta un intento) y lo que suele
 * rechazar (aviso: se advierte y se deja probar).
 */
import { describe, expect, it } from 'vitest';
import {
  componentesDePlantilla,
  validarPlantilla,
  type BorradorDePlantilla,
} from '../src/plantillas.js';

const BASE: BorradorDePlantilla = {
  nombre: 'confirmacion_reserva',
  idioma: 'es',
  categoria: 'UTILITY',
  cuerpo: 'Hola {{1}}, confirmamos tu reserva del {{2}} en El Paraíso.',
  ejemplos: ['Rosa', '12 de julio'],
};

const codigos = (p: BorradorDePlantilla) => validarPlantilla(p).map((x) => x.codigo);

describe('validarPlantilla', () => {
  it('una plantilla correcta no tiene nada que decir', () => {
    expect(validarPlantilla(BASE)).toEqual([]);
  });

  it('el nombre con mayúsculas o espacios es error: Meta lo rechaza siempre', () => {
    expect(codigos({ ...BASE, nombre: 'Confirmación Reserva' })).toContain('nombre_invalido');
  });

  it('variables sin ejemplo son error, no aviso', () => {
    const p = validarPlantilla({ ...BASE, ejemplos: ['Rosa'] });
    expect(p[0]).toMatchObject({ nivel: 'error', codigo: 'faltan_ejemplos' });
  });

  it('las variables van desde {{1}} y sin saltos', () => {
    expect(codigos({ ...BASE, cuerpo: 'Hola {{2}}', ejemplos: ['Rosa'] })).toContain(
      'variables_desordenadas',
    );
  });

  it('un enlace acortado solo avisa', () => {
    const p = validarPlantilla({ ...BASE, cuerpo: 'Reserva aquí: bit.ly/xyz' });
    expect(p).toEqual([
      {
        nivel: 'aviso',
        codigo: 'enlace_acortado',
        mensaje: expect.stringContaining('acortados'),
      },
    ]);
  });

  it('una variable al principio del cuerpo avisa', () => {
    expect(
      codigos({ ...BASE, cuerpo: '{{1}}, tu reserva está lista', ejemplos: ['Rosa'] }),
    ).toContain('variable_en_el_borde');
  });

  it('contenido promocional declarado como utilidad avisa de que puede costar dinero', () => {
    const p = validarPlantilla({
      ...BASE,
      cuerpo: 'Aprovecha nuestro descuento de julio',
      ejemplos: [],
    });
    expect(p.map((x) => x.codigo)).toContain('promocional_como_utility');
    expect(p.every((x) => x.nivel === 'aviso')).toBe(true);
  });

  it('los botones y los textos tienen límites', () => {
    expect(codigos({ ...BASE, botones: ['a', 'b', 'c', 'd'] })).toContain('demasiados_botones');
    expect(codigos({ ...BASE, botones: ['   '] })).toContain('boton_invalido');
    expect(codigos({ ...BASE, pie: 'x'.repeat(61) })).toContain('pie_largo');
  });
});

describe('componentesDePlantilla', () => {
  it('arma lo que pide Meta: BODY con body_text como array de arrays', () => {
    expect(componentesDePlantilla(BASE)).toEqual([
      {
        type: 'BODY',
        text: BASE.cuerpo,
        example: { body_text: [['Rosa', '12 de julio']] },
      },
    ]);
  });

  it('encabezado, pie y botones de respuesta rápida en su sitio', () => {
    expect(
      componentesDePlantilla({
        ...BASE,
        cuerpo: 'Tu reserva está confirmada.',
        encabezado: 'El Paraíso',
        pie: 'Barranca, Perú',
        botones: ['Ver detalles', 'Cancelar'],
        ejemplos: [],
      }),
    ).toEqual([
      { type: 'HEADER', format: 'TEXT', text: 'El Paraíso' },
      { type: 'BODY', text: 'Tu reserva está confirmada.' },
      { type: 'FOOTER', text: 'Barranca, Perú' },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Ver detalles' },
          { type: 'QUICK_REPLY', text: 'Cancelar' },
        ],
      },
    ]);
  });
});

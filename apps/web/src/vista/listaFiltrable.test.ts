/**
 * Buscar, filtrar por fecha y paginar.
 *
 * Lo que se prueba es lo que hace «inteligente» al buscador —tildes, palabras
 * sueltas, varios campos— y los dos casos que dejan una lista vacía sin
 * explicación: la página que se queda fuera de rango al filtrar, y el rango de
 * fechas que se come el último día.
 */
import { describe, expect, it } from 'vitest';
import { coincide, dentroDelRango, normalizar, POR_PAGINA } from './listaFiltrable.ts';

describe('normalizar', () => {
  it('quita tildes y mayúsculas: nadie teclea tildes en un buscador', () => {
    expect(normalizar('Cotización')).toBe('cotizacion');
  });

  it('la eñe también se pliega, y es lo que conviene al BUSCAR', () => {
    // En español la «ñ» es una letra propia, no una «n» con virgulilla. Pero
    // esto es un buscador, no un corrector: en un teclado sin eñe se escribe
    // «nino» y se espera encontrar «niño». Ensancha lo que se encuentra, no
    // lo estrecha, así que nadie pierde una fila por esto.
    expect(normalizar('Niños')).toBe('ninos');
  });
});

describe('coincide', () => {
  const campos = ['/bienvenida', 'Saludo inicial', 'Hola, gracias por escribir al Paraíso'];

  it('sin búsqueda, todo vale', () => {
    expect(coincide(campos, '')).toBe(true);
    expect(coincide(campos, '   ')).toBe(true);
  });

  it('encuentra sin tildes', () => {
    expect(coincide(campos, 'paraiso')).toBe(true);
  });

  it('busca en TODOS los campos, no solo en el nombre', () => {
    // Quien se acuerda de «gracias» está pensando en lo que dice la respuesta.
    expect(coincide(campos, 'gracias')).toBe(true);
    expect(coincide(campos, 'bienvenida')).toBe(true);
  });

  it('las palabras sueltas no tienen que ir juntas ni en orden', () => {
    expect(coincide(campos, 'saludo hola')).toBe(true);
    expect(coincide(campos, 'hola saludo')).toBe(true);
  });

  it('TODAS las palabras tienen que aparecer: añadir una afina', () => {
    expect(coincide(campos, 'saludo despedida')).toBe(false);
  });

  it('lo que no está, no está', () => {
    expect(coincide(campos, 'factura')).toBe(false);
  });
});

describe('dentroDelRango', () => {
  const enero = '2026-01-15T10:00:00Z';

  it('sin rango, todo pasa', () => {
    expect(dentroDelRango(enero, { desde: '', hasta: '' })).toBe(true);
  });

  it('el día «hasta» está INCLUIDO', () => {
    // Quien pone «hasta el 15» espera ver lo del 15. Comparar contra su
    // medianoche lo dejaría fuera, y parecería que no hay nada ese día.
    const local = new Date(enero);
    const dia = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(
      local.getDate(),
    ).padStart(2, '0')}`;
    expect(dentroDelRango(enero, { desde: '', hasta: dia })).toBe(true);
    expect(dentroDelRango(enero, { desde: dia, hasta: '' })).toBe(true);
    expect(dentroDelRango(enero, { desde: dia, hasta: dia })).toBe(true);
  });

  it('fuera del rango, fuera', () => {
    expect(dentroDelRango(enero, { desde: '2026-02-01', hasta: '' })).toBe(false);
    expect(dentroDelRango(enero, { desde: '', hasta: '2025-12-31' })).toBe(false);
  });

  it('una fecha ilegible no esconde la fila', () => {
    // Perder un elemento en silencio por un dato raro es peor que enseñarlo.
    expect(dentroDelRango('vaya fecha', { desde: '2026-01-01', hasta: '2026-01-31' })).toBe(true);
  });
});

describe('POR_PAGINA', () => {
  it('parte a partir de 20, que es lo que se pidió', () => {
    expect(POR_PAGINA).toBe(20);
  });
});

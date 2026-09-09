import { describe, expect, it } from 'vitest';
import { leerRuta } from './ruta.ts';

describe('leerRuta', () => {
  it('bandeja por defecto, con o sin conversación', () => {
    expect(leerRuta('')).toEqual({ pantalla: 'bandeja', conversacionId: null });
    expect(leerRuta('#c=abc')).toEqual({ pantalla: 'bandeja', conversacionId: 'abc' });
  });
  it('ajustes con sección válida; una desconocida cae en canales', () => {
    expect(leerRuta('#ajustes/uso')).toEqual({ pantalla: 'ajustes', seccion: 'uso' });
    expect(leerRuta('#ajustes')).toEqual({ pantalla: 'ajustes', seccion: 'canales' });
    expect(leerRuta('#ajustes/nada')).toEqual({ pantalla: 'ajustes', seccion: 'canales' });
  });
});

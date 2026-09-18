/**
 * La preferencia de apariencia.
 *
 * Lo que se prueba es que nada de lo que venga del navegador pueda dejar la
 * pantalla ilegible, y que lo que está por defecto **no escriba atributo** —
 * de eso depende que se siga respetando lo que pide el sistema operativo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aplicarApariencia,
  arrancarApariencia,
  guardarApariencia,
  leerApariencia,
  POR_DEFECTO,
  sistemaPideMenosTransparencia,
} from './apariencia.ts';

const raiz = () => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  raiz().removeAttribute('data-theme');
  raiz().removeAttribute('data-vidrio');
});

describe('leerApariencia', () => {
  it('sin nada guardado, lo de siempre', () => {
    expect(leerApariencia()).toEqual(POR_DEFECTO);
  });

  it('devuelve lo guardado', () => {
    guardarApariencia({ tema: 'oscuro', vidrio: 'cristal' });
    expect(leerApariencia()).toEqual({ tema: 'oscuro', vidrio: 'cristal' });
  });

  it('un valor inventado NO se aplica: sale lo de siempre', () => {
    localStorage.setItem('crmapp.apariencia', JSON.stringify({ tema: 'fucsia', vidrio: 'humo' }));
    expect(leerApariencia()).toEqual(POR_DEFECTO);
  });

  it('con la mitad guardada, la otra mitad es la de siempre', () => {
    localStorage.setItem('crmapp.apariencia', JSON.stringify({ tema: 'claro' }));
    expect(leerApariencia()).toEqual({ tema: 'claro', vidrio: POR_DEFECTO.vidrio });
  });

  it('un JSON roto no rompe nada', () => {
    localStorage.setItem('crmapp.apariencia', '{esto no es json');
    expect(leerApariencia()).toEqual(POR_DEFECTO);
  });

  it('sin almacenamiento —navegación privada— tampoco', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    expect(leerApariencia()).toEqual(POR_DEFECTO);
    vi.restoreAllMocks();
  });
});

describe('aplicarApariencia', () => {
  it('lo elegido se escribe en <html>', () => {
    aplicarApariencia({ tema: 'oscuro', vidrio: 'cristal' });
    expect(raiz().getAttribute('data-theme')).toBe('dark');
    expect(raiz().getAttribute('data-vidrio')).toBe('cristal');
  });

  it('«claro» y «oscuro» usan los nombres que entiende el CSS', () => {
    aplicarApariencia({ tema: 'claro', vidrio: 'vidrio' });
    expect(raiz().getAttribute('data-theme')).toBe('light');
  });

  it('en automático NO hay atributo de tema: manda el sistema', () => {
    aplicarApariencia({ tema: 'oscuro', vidrio: 'vidrio' });
    aplicarApariencia({ tema: 'auto', vidrio: 'vidrio' });
    expect(raiz().hasAttribute('data-theme')).toBe(false);
  });

  it('el vidrio por defecto TAMPOCO escribe atributo', () => {
    // De esto depende que «menos transparencia» del sistema siga mandando en
    // quien nunca tocó este ajuste. Si aquí se escribiera el atributo, la
    // preferencia de accesibilidad quedaría tapada para todo el mundo.
    aplicarApariencia({ tema: 'auto', vidrio: 'cristal' });
    aplicarApariencia({ tema: 'auto', vidrio: 'vidrio' });
    expect(raiz().hasAttribute('data-vidrio')).toBe(false);
  });
});

describe('guardarApariencia', () => {
  it('guarda y aplica a la vez', () => {
    guardarApariencia({ tema: 'oscuro', vidrio: 'solido' });
    expect(raiz().getAttribute('data-vidrio')).toBe('solido');
    expect(leerApariencia().tema).toBe('oscuro');
  });

  it('si no se puede guardar, al menos se ve aplicado', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('cuota');
    });
    expect(() => guardarApariencia({ tema: 'claro', vidrio: 'solido' })).not.toThrow();
    expect(raiz().getAttribute('data-theme')).toBe('light');
    vi.restoreAllMocks();
  });
});

describe('arrancarApariencia', () => {
  it('deja el documento como quedó la última vez', () => {
    guardarApariencia({ tema: 'oscuro', vidrio: 'cristal' });
    raiz().removeAttribute('data-theme');
    raiz().removeAttribute('data-vidrio');

    arrancarApariencia();
    expect(raiz().getAttribute('data-theme')).toBe('dark');
    expect(raiz().getAttribute('data-vidrio')).toBe('cristal');
  });
});

describe('sistemaPideMenosTransparencia', () => {
  it('sin matchMedia no revienta: dice que no', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => {
      throw new Error('no existe');
    });
    expect(sistemaPideMenosTransparencia()).toBe(false);
    vi.restoreAllMocks();
  });
});

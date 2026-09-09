import { beforeEach, describe, expect, it } from 'vitest';
import { acotar, guardarPaneles, leerPaneles, LIMITES, POR_DEFECTO } from './paneles.ts';

beforeEach(() => localStorage.clear());

describe('acotar', () => {
  it('respeta mínimo y máximo, y redondea', () => {
    expect(acotar(10, LIMITES.lista)).toBe(LIMITES.lista.min);
    expect(acotar(9999, LIMITES.lista)).toBe(LIMITES.lista.max);
    expect(acotar(300.4, LIMITES.lista)).toBe(300);
  });
  it('un valor imposible vuelve al normal, no rompe la bandeja', () => {
    expect(acotar(Number.NaN, LIMITES.ficha)).toBe(LIMITES.ficha.por);
    expect(acotar(Number.POSITIVE_INFINITY, LIMITES.ficha)).toBe(LIMITES.ficha.por);
  });
});

describe('leerPaneles', () => {
  it('sin nada guardado, el reparto por defecto', () => {
    expect(leerPaneles()).toEqual(POR_DEFECTO);
  });

  it('recuerda lo guardado', () => {
    guardarPaneles({ anchoLista: 400, anchoFicha: 260, listaAbierta: false, fichaAbierta: false });
    expect(leerPaneles()).toEqual({
      anchoLista: 400,
      anchoFicha: 260,
      listaAbierta: false,
      fichaAbierta: false,
    });
  });

  it('un ancho guardado fuera de rango se acota en vez de dejar un panel inservible', () => {
    localStorage.setItem(
      'crmapp.paneles.v1',
      JSON.stringify({ anchoLista: 20, anchoFicha: 4000, listaAbierta: true, fichaAbierta: true }),
    );
    const p = leerPaneles();
    expect(p.anchoLista).toBe(LIMITES.lista.min);
    expect(p.anchoFicha).toBe(LIMITES.ficha.max);
  });

  it('JSON roto o versión vieja: valores por defecto, sin excepción', () => {
    localStorage.setItem('crmapp.paneles.v1', '{esto no es json');
    expect(leerPaneles()).toEqual(POR_DEFECTO);
  });
});

import { describe, expect, it } from 'vitest';
import { diaDeMensaje, horaCorta, inicial, ventana } from './tiempo.ts';

const ahora = new Date('2026-09-09T12:00:00Z');

describe('ventana', () => {
  it('abierta con horas y minutos', () => {
    expect(ventana('2026-09-09T15:20:00Z', ahora)).toEqual({
      tono: 'abierta',
      texto: '3 h 20 min',
    });
  });
  it('por cerrar bajo dos horas, solo minutos bajo una', () => {
    expect(ventana('2026-09-09T13:30:00Z', ahora)).toEqual({
      tono: 'por-cerrar',
      texto: '1 h 30 min',
    });
    expect(ventana('2026-09-09T12:45:00Z', ahora)).toEqual({ tono: 'por-cerrar', texto: '45 min' });
  });
  it('cerrada o inexistente', () => {
    expect(ventana('2026-09-09T11:59:00Z', ahora).tono).toBe('cerrada');
    expect(ventana(null, ahora)).toEqual({ tono: 'cerrada', texto: 'Sin ventana' });
  });
});

describe('horaCorta', () => {
  it('hoy → hora; ayer → "ayer"; lejos → día y mes', () => {
    expect(horaCorta('2026-09-09T09:05:00Z', ahora)).toMatch(/\d{2}:\d{2}/);
    expect(horaCorta('2026-09-08T09:05:00Z', ahora)).toBe('ayer');
    expect(horaCorta('2026-08-12T09:05:00Z', ahora)).toMatch(/12/);
  });
});

describe('diaDeMensaje', () => {
  it('hoy, ayer y fecha completa; el año solo si es otro', () => {
    expect(diaDeMensaje('2026-09-09T12:30:00Z', ahora)).toBe('Hoy');
    expect(diaDeMensaje('2026-09-08T12:00:00Z', ahora)).toBe('Ayer');
    expect(diaDeMensaje('2026-08-12T09:05:00Z', ahora)).toContain('agosto');
    expect(diaDeMensaje('2026-08-12T09:05:00Z', ahora)).not.toContain('2026');
    expect(diaDeMensaje('2025-08-12T09:05:00Z', ahora)).toContain('2025');
  });
});

describe('inicial', () => {
  it('nombre, luego handle, luego ?', () => {
    expect(inicial('ana pérez', null)).toBe('A');
    expect(inicial(null, 'lucho')).toBe('L');
    expect(inicial(null, null)).toBe('?');
  });
});

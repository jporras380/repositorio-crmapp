/**
 * Horario de atención. Lo que se prueba es lo que decide si un cliente recibe
 * el aviso de fuera de horario: la hora es la DEL HOTEL, el borde del cierre,
 * el día cerrado y el horario partido.
 */
import { describe, expect, it } from 'vitest';
import { estaAbierto, momentoLocal, validarHorario, type Horario } from '../src/horario.js';

const LIMA = 'America/Lima'; // UTC−5, sin horario de verano
const HOTEL: Horario = {
  '1': [
    ['09:00', '13:00'],
    ['15:00', '20:00'],
  ],
  '2': [['09:00', '20:00']],
  '6': [['09:00', '13:00']],
};

describe('estaAbierto', () => {
  it('usa la hora del hotel, no la del servidor', () => {
    // Martes 10:00 en Lima son las 15:00 UTC. A las 10:00 UTC en Lima son las
    // 5 de la mañana: cerrado.
    expect(estaAbierto(new Date('2026-09-15T15:00:00Z'), HOTEL, LIMA)).toBe(true);
    expect(estaAbierto(new Date('2026-09-15T10:00:00Z'), HOTEL, LIMA)).toBe(false);
  });

  it('la hora de cierre ya está cerrada; la de apertura, abierta', () => {
    // Martes: 09:00 y 20:00 hora de Lima.
    expect(estaAbierto(new Date('2026-09-15T14:00:00Z'), HOTEL, LIMA)).toBe(true);
    expect(estaAbierto(new Date('2026-09-16T01:00:00Z'), HOTEL, LIMA)).toBe(false);
  });

  it('respeta el horario partido: cerrado a la hora del almuerzo', () => {
    // Lunes 14:00 en Lima, entre los dos tramos.
    expect(estaAbierto(new Date('2026-09-14T19:00:00Z'), HOTEL, LIMA)).toBe(false);
    expect(estaAbierto(new Date('2026-09-14T21:00:00Z'), HOTEL, LIMA)).toBe(true);
  });

  it('un día que no aparece está cerrado, y un horario vacío no es 24/7', () => {
    // Domingo (día 7): no está en el horario.
    expect(estaAbierto(new Date('2026-09-20T16:00:00Z'), HOTEL, LIMA)).toBe(false);
    expect(estaAbierto(new Date('2026-09-15T15:00:00Z'), {}, LIMA)).toBe(false);
  });

  it('una zona horaria desconocida devuelve null: no se supone nada', () => {
    expect(estaAbierto(new Date(), HOTEL, 'Marte/Olympus')).toBeNull();
    expect(momentoLocal(new Date(), 'Marte/Olympus')).toBeNull();
  });

  it('con horario de verano manda la zona, no un desfase fijo', () => {
    const madrid = 'Europe/Madrid';
    const h: Horario = { '3': [['09:00', '18:00']] };
    // Miércoles 08:30 UTC: en Madrid son 10:30 en verano y 09:30 en invierno.
    expect(estaAbierto(new Date('2026-07-15T08:30:00Z'), h, madrid)).toBe(true);
    // Miércoles 07:30 UTC en enero: 08:30 en Madrid, todavía cerrado.
    expect(estaAbierto(new Date('2026-01-14T07:30:00Z'), h, madrid)).toBe(false);
  });
});

describe('validarHorario', () => {
  it('acepta un horario normal', () => {
    expect(validarHorario(HOTEL)).toEqual([]);
  });

  it('un tramo que termina antes de empezar es un error, no «cruza la medianoche»', () => {
    expect(validarHorario({ '1': [['22:00', '02:00']] })).toEqual([
      { tipo: 'tramo_al_reves', dia: '1', tramo: ['22:00', '02:00'] },
    ]);
  });

  it('avisa de horas imposibles, días que no existen y tramos que se pisan', () => {
    expect(validarHorario({ '1': [['09:00', '25:00']] })).toEqual([
      { tipo: 'hora_invalida', dia: '1', valor: '25:00' },
    ]);
    expect(validarHorario({ '8': [] })).toEqual([{ tipo: 'dia_invalido', dia: '8' }]);
    expect(
      validarHorario({
        '1': [
          ['09:00', '14:00'],
          ['13:00', '18:00'],
        ],
      }),
    ).toEqual([{ tipo: 'tramos_se_solapan', dia: '1' }]);
  });
});

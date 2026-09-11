/**
 * CSV.
 *
 * Los casos de aquí no son inventados: son los archivos que llegan de verdad
 * —Excel en español, BOM, saltos de Windows, comas dentro de comillas— y
 * cada uno de ellos rompe un `split(',')` sin decir nada.
 */
import { describe, expect, it } from 'vitest';
import { clave, escribirCsv, leerCsv, separadorDe } from '../src/csv.js';

describe('separadorDe', () => {
  it('reconoce el punto y coma del Excel en español', () => {
    expect(separadorDe('nombre;telefono;correo\nAna;+51999;a@b.c')).toBe(';');
  });

  it('y la coma del resto del mundo', () => {
    expect(separadorDe('nombre,telefono\nAna,+51999')).toBe(',');
  });

  it('no cuenta los separadores que van dentro de comillas', () => {
    // Si contara el punto y coma de dentro, elegiría el separador equivocado
    // y el archivo entero saldría en una sola columna.
    expect(separadorDe('nombre,observacion\nAna,"viene con niños; pide cuna"')).toBe(',');
  });
});

describe('leerCsv', () => {
  it('lee cabeceras y filas', () => {
    const t = leerCsv('nombre,telefono\nAna,+51999111222\nLuis,+51988');
    expect(t.cabeceras).toEqual(['nombre', 'telefono']);
    expect(t.filas).toEqual([
      ['Ana', '+51999111222'],
      ['Luis', '+51988'],
    ]);
  });

  it('respeta las comas y los saltos de línea dentro de comillas', () => {
    const t = leerCsv('nombre,nota\nAna,"pide cuna, y desayuno\nsin gluten"');
    expect(t.filas).toEqual([['Ana', 'pide cuna, y desayuno\nsin gluten']]);
  });

  it('las comillas dobles son una comilla', () => {
    const t = leerCsv('nombre,nota\nAna,"dijo ""sin ventana"""');
    expect(t.filas[0]![1]).toBe('dijo "sin ventana"');
  });

  it('se traga el BOM y los saltos de Windows sin dejar rastro', () => {
    const t = leerCsv('﻿nombre,telefono\r\nAna,+51999\r\n');
    expect(t.cabeceras).toEqual(['nombre', 'telefono']);
    expect(t.filas).toEqual([['Ana', '+51999']]);
  });

  it('una fila corta se rellena en vez de perderse', () => {
    // Un campo final vacío que el exportador se comió no puede costar un cliente.
    const t = leerCsv('nombre,telefono,correo\nAna,+51999');
    expect(t.filas).toEqual([['Ana', '+51999', '']]);
  });

  it('las líneas en blanco no son clientes', () => {
    const t = leerCsv('nombre\nAna\n\n\nLuis\n');
    expect(t.filas).toEqual([['Ana'], ['Luis']]);
  });
});

describe('escribirCsv', () => {
  it('entrecomilla solo lo que lo necesita', () => {
    const salida = escribirCsv(
      ['nombre', 'nota'],
      [
        ['Ana', 'pide cuna, temprano'],
        ['Luis', 'sin nota'],
      ],
    );
    expect(salida).toBe('nombre,nota\r\nAna,"pide cuna, temprano"\r\nLuis,sin nota');
  });

  it('lo que se escribe se vuelve a leer igual', () => {
    const filas = [
      ['Ana Quispe', 'dijo "sin ventana", y con cuna'],
      ['Luis', 'dos\nlíneas'],
      ['  bordes  ', ''],
    ];
    const ida = escribirCsv(['nombre', 'nota'], filas, ';');
    const vuelta = leerCsv(ida, ';');
    // Los espacios de los bordes sobreviven al viaje porque van entrecomillados,
    // pero `leerCsv` los recorta al importar: es lo correcto para un nombre.
    expect(vuelta.filas[0]).toEqual(filas[0]);
    expect(vuelta.filas[1]).toEqual(filas[1]);
    expect(vuelta.filas[2]).toEqual(['bordes', '']);
  });
});

describe('clave', () => {
  it('«Teléfono», «telefono» y «TELEFONO » son la misma columna', () => {
    expect(clave('Teléfono')).toBe('telefono');
    expect(clave('TELEFONO ')).toBe('telefono');
    expect(clave('Correo electrónico')).toBe('correoelectronico');
  });
});

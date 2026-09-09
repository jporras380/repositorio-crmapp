import { describe, expect, it } from 'vitest';
import {
  calcularExpiracion,
  expiracionTrasMensaje,
  tiempoRestante,
  ventanaAbierta,
  type PoliticaDeVentana,
} from '../src/ventanas.js';

const WHATSAPP: PoliticaDeVentana = {
  duracionHoras: 24,
  salienteReinicia: false,
  entradaGratuitaHoras: 72,
};
const SIN_VENTANA: PoliticaDeVentana = { duracionHoras: null, salienteReinicia: false };

const T0 = new Date('2026-01-01T10:00:00.000Z');
const horas = (n: number) => n * 60 * 60 * 1000;
const mas = (d: Date, ms: number) => new Date(d.getTime() + ms);

describe('calculo de la ventana', () => {
  it('24 horas desde el ultimo entrante', () => {
    expect(calcularExpiracion(WHATSAPP, T0)).toEqual(mas(T0, horas(24)));
  });

  it('sin entrante no hay ventana', () => {
    // Una conversacion que abrimos nosotros no tiene ventana abierta: solo se
    // puede iniciar con plantilla.
    expect(calcularExpiracion(WHATSAPP, null)).toBeNull();
  });

  it('la entrada gratuita da 72 horas', () => {
    // Click-to-WhatsApp o boton de pagina.
    expect(calcularExpiracion(WHATSAPP, T0, 'entrada_gratuita')).toEqual(mas(T0, horas(72)));
  });

  it('un canal sin ventana devuelve null', () => {
    expect(calcularExpiracion(SIN_VENTANA, T0)).toBeNull();
  });
});

describe('la ventana abierta', () => {
  const expira = mas(T0, horas(24));

  it('esta abierta hasta el ultimo instante', () => {
    expect(ventanaAbierta(expira, mas(expira, -1))).toBe(true);
  });

  it('y cerrada justo al cumplirse', () => {
    expect(ventanaAbierta(expira, expira)).toBe(false);
  });

  it('sin ventana cuenta como ABIERTA, no como cerrada', () => {
    // Tratar "el canal no tiene ventana" como cerrada bloquearia un canal que
    // no tiene la restriccion. Es el error facil de cometer.
    expect(ventanaAbierta(null, T0)).toBe(true);
  });
});

describe('tiempo restante', () => {
  it('cuenta hacia abajo', () => {
    expect(tiempoRestante(mas(T0, horas(24)), mas(T0, horas(20)))).toBe(horas(4));
  });

  it('no baja de cero', () => {
    expect(tiempoRestante(T0, mas(T0, horas(5)))).toBe(0);
  });

  it('null cuando no hay ventana', () => {
    expect(tiempoRestante(null, T0)).toBeNull();
  });
});

describe('quien reinicia la ventana', () => {
  it('en WhatsApp la reinicia el ENTRANTE', () => {
    const nueva = mas(T0, horas(10));
    expect(expiracionTrasMensaje(WHATSAPP, 'inbound', nueva, mas(T0, horas(24)))).toEqual(
      mas(nueva, horas(24)),
    );
  });

  it('en WhatsApp un SALIENTE no la reinicia', () => {
    // La regla que mas se malinterpreta. Codificarla al reves hace que el
    // sistema crea que puede enviar cuando ya no puede, y el error solo
    // aparece cuando Meta rechaza el envio.
    const original = mas(T0, horas(24));
    expect(expiracionTrasMensaje(WHATSAPP, 'outbound', mas(T0, horas(10)), original)).toEqual(
      original,
    );
  });

  it('un canal donde el saliente si reinicia se comporta distinto', () => {
    const politica: PoliticaDeVentana = { duracionHoras: 24, salienteReinicia: true };
    const momento = mas(T0, horas(10));
    expect(expiracionTrasMensaje(politica, 'outbound', momento, mas(T0, horas(24)))).toEqual(
      mas(momento, horas(24)),
    );
  });

  it('responder despues de que cerrara no la reabre', () => {
    // Sin esto, un envio con plantilla fuera de ventana reabriria la ventana y
    // permitiria seguir con texto libre gratis.
    const cerrada = mas(T0, horas(24));
    const tarde = mas(T0, horas(30));
    expect(expiracionTrasMensaje(WHATSAPP, 'outbound', tarde, cerrada)).toEqual(cerrada);
    expect(ventanaAbierta(cerrada, tarde)).toBe(false);
  });
});

/**
 * Registro de adaptadores.
 *
 * El nucleo pide un adaptador por canal y no importa ninguno directamente. Es
 * lo que permite que un cuarto canal sea un alta aqui y no un cambio en el
 * nucleo, y lo que hace cumplible la guarda de arquitectura que prohibe
 * importar `channels/whatsapp` desde fuera de este paquete.
 */
import type { Canal, ChannelAdapter } from './adaptador.js';

export class CanalNoRegistrado extends Error {
  constructor(canal: string, disponibles: string[]) {
    super(
      `No hay adaptador registrado para "${canal}". ` +
        `Disponibles: ${disponibles.join(', ') || 'ninguno'}.`,
    );
    this.name = 'CanalNoRegistrado';
  }
}

export class RegistroDeCanales {
  readonly #adaptadores = new Map<Canal, ChannelAdapter>();

  registrar(adaptador: ChannelAdapter): this {
    this.#adaptadores.set(adaptador.canal, adaptador);
    return this;
  }

  /**
   * Lanza si el canal no esta registrado, en vez de devolver undefined.
   *
   * Un `undefined` aqui se propaga y estalla mas tarde, lejos de la causa. El
   * mensaje incluye los canales disponibles porque el fallo tipico es un
   * adaptador que no se registro al arrancar.
   */
  obtener(canal: Canal): ChannelAdapter {
    const a = this.#adaptadores.get(canal);
    if (!a) throw new CanalNoRegistrado(canal, [...this.#adaptadores.keys()]);
    return a;
  }

  tiene(canal: Canal): boolean {
    return this.#adaptadores.has(canal);
  }

  get canales(): Canal[] {
    return [...this.#adaptadores.keys()];
  }
}

/**
 * Tests del contrato de canal.
 *
 * Prueban el CONTRATO, no una implementacion concreta: la validacion contra
 * capacidades, el registro, y que el sandbox se comporte como un canal de
 * verdad — incluido saber fallar.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { calcularExpiracion, ventanaAbierta } from '@crmapp/core';
import {
  AdaptadorSandbox,
  CanalNoRegistrado,
  RegistroDeCanales,
  validarContraCapacidades,
  type ErrorDeCanal,
} from '../src/index.js';

const T0 = new Date('2026-01-01T10:00:00.000Z');
let canal: AdaptadorSandbox;

beforeEach(() => {
  canal = new AdaptadorSandbox({ ahora: () => T0 });
});

const destino = { externalUserId: 'wa:34600111222', channelAccountId: 'ca-1' };

describe('envio basico', () => {
  it('devuelve un identificador externo y lo registra', async () => {
    const r = await canal.sendText({ ...destino, texto: 'hola' });
    expect(r.externalMessageId).toMatch(/^sandbox\.whatsapp\./);
    expect(r.estado).toBe('sent');
    expect(canal.enviados).toHaveLength(1);
  });

  it('los identificadores no se repiten', async () => {
    // Es la clave de idempotencia (ADR-006): si se repitieran, el segundo
    // mensaje se tomaria por duplicado y se descartaria.
    for (let i = 0; i < 50; i++) await canal.sendText({ ...destino, texto: `n${i}` });
    const ids = new Set(canal.enviados.map((e) => e.externalMessageId));
    expect(ids.size).toBe(50);
  });

  it('el identificador simulado se distingue de uno real', async () => {
    // Prefijo sandbox. para que sea imposible confundirlo si acaba en la base
    // por error.
    const r = await canal.sendText({ ...destino, texto: 'x' });
    expect(r.externalMessageId.startsWith('sandbox.')).toBe(true);
  });

  it('no devuelve delivered: eso lo confirma un webhook posterior', async () => {
    const r = await canal.sendText({ ...destino, texto: 'x' });
    expect(['sent', 'queued']).toContain(r.estado);
  });
});

describe('validacion contra capacidades', () => {
  it('rechaza un medio que pasa del limite, y dice cual es', async () => {
    // El mensaje de Meta cuando un video pasa de tamano no dice el limite.
    const grande = Buffer.alloc(6 * 1024 * 1024);
    await expect(
      canal.sendMedia({
        ...destino,
        tipo: 'imagen',
        origen: { tipo: 'buffer', datos: grande, mime: 'image/jpeg' },
      }),
    ).rejects.toThrow(/límite de whatsapp para "imagen" es/i);
  });

  it('acepta un medio dentro del limite', async () => {
    const ok = Buffer.alloc(1024);
    const r = await canal.sendMedia({
      ...destino,
      tipo: 'imagen',
      origen: { tipo: 'buffer', datos: ok, mime: 'image/jpeg' },
    });
    expect(r.externalMessageId).toBeTruthy();
  });

  it('rechaza un texto mas largo del maximo', async () => {
    await expect(canal.sendText({ ...destino, texto: 'a'.repeat(5000) })).rejects.toThrow(
      /límite de whatsapp es 4096/i,
    );
  });

  it('rechaza comentarios en un canal que no los soporta', async () => {
    // El nucleo pregunta capacidades; si aun asi lo intenta, falla claro.
    await expect(
      canal.replyToComment({
        channelAccountId: 'ca-1',
        comentarioId: 'c1',
        texto: 'gracias',
        modo: 'publica',
      }),
    ).rejects.toThrow(/no admite comentarios/i);
  });

  it('validarContraCapacidades funciona sin adaptador', () => {
    // Es una funcion pura: el nucleo puede validar antes de encolar nada.
    const caps = canal.capacidades();
    expect(validarContraCapacidades(caps, { tipo: 'texto', longitudTexto: 10 })).toBeNull();
    const error = validarContraCapacidades(caps, { tipo: 'imagen', bytes: 99 * 1024 * 1024 });
    expect(error?.tipo).toBe('medio_demasiado_grande');
    expect(error?.reintentable).toBe(false);
  });
});

describe('errores: lo que decide el worker', () => {
  it('un limite de tasa es reintentable y dice cuanto esperar', async () => {
    canal.programarFallo({ tipo: 'limite_de_tasa', reintentable: true });
    try {
      await canal.sendText({ ...destino, texto: 'x' });
      expect.unreachable('deberia haber fallado');
    } catch (e) {
      const error = e as ErrorDeCanal;
      expect(error.tipo).toBe('limite_de_tasa');
      expect(error.reintentable).toBe(true);
      expect(error.reintentarEnSegundos).toBe(30);
    }
  });

  it('un token invalido NO es reintentable', async () => {
    // Reintentarlo cinco veces no lo arregla: sigue invalido. Es lo que separa
    // el backoff de la cola muerta.
    canal.programarFallo({ tipo: 'token_invalido', reintentable: false });
    await expect(canal.sendText({ ...destino, texto: 'x' })).rejects.toMatchObject({
      reintentable: false,
    });
  });

  it('el fallo programado se consume y no contamina el envio siguiente', async () => {
    canal.programarFallo({ tipo: 'proveedor_no_disponible', reintentable: true });
    await expect(canal.sendText({ ...destino, texto: 'a' })).rejects.toThrow();
    await expect(canal.sendText({ ...destino, texto: 'b' })).resolves.toBeTruthy();
  });
});

describe('plantillas', () => {
  it('no deja enviar una plantilla que no esta aprobada', async () => {
    const conRechazada = new AdaptadorSandbox({
      ahora: () => T0,
      plantillas: [
        {
          nombre: 'promo',
          idioma: 'es',
          estado: 'rechazada',
          categoriaEfectiva: 'MARKETING',
          motivoDeRechazo: 'contenido promocional declarado como utilidad',
          calidad: null,
          externalId: 'tpl-1',
        },
      ],
    });
    await expect(
      conRechazada.sendTemplate({ ...destino, nombre: 'promo', idioma: 'es', parametros: [] }),
    ).rejects.toThrow(/estado "rechazada"/);
  });

  it('syncTemplates devuelve el motivo del rechazo', async () => {
    // Es lo unico que permite corregir una plantilla rechazada.
    const con = new AdaptadorSandbox({
      plantillas: [
        {
          nombre: 'p',
          idioma: 'es',
          estado: 'rechazada',
          categoriaEfectiva: 'MARKETING',
          motivoDeRechazo: 'enlaces acortados',
          calidad: null,
          externalId: 't',
        },
      ],
    });
    const [p] = await con.syncTemplates();
    expect(p!.motivoDeRechazo).toBe('enlaces acortados');
  });

  it('la categoria efectiva viene del proveedor, no de nosotros', async () => {
    // Es la que determina el costo por mensaje.
    const con = new AdaptadorSandbox({
      plantillas: [
        {
          nombre: 'p',
          idioma: 'es',
          estado: 'aprobada',
          categoriaEfectiva: 'MARKETING',
          motivoDeRechazo: null,
          calidad: 'GREEN',
          externalId: 't',
        },
      ],
    });
    const [p] = await con.syncTemplates();
    expect(p!.categoriaEfectiva).toBe('MARKETING');
  });
});

describe('politica de ventana', () => {
  it('el adaptador la declara y core la aplica', async () => {
    // La division que importa: el adaptador sabe que su ventana dura 24 horas,
    // el nucleo sabe como se calcula una expiracion. Ninguno sabe lo del otro.
    const politica = canal.politicaDeVentana();
    const expira = calcularExpiracion(politica, T0);
    expect(expira).toEqual(new Date(T0.getTime() + 24 * 3_600_000));
    expect(ventanaAbierta(expira, new Date(T0.getTime() + 23 * 3_600_000))).toBe(true);
    expect(ventanaAbierta(expira, new Date(T0.getTime() + 25 * 3_600_000))).toBe(false);
  });
});

describe('registro de canales', () => {
  it('devuelve el adaptador del canal pedido', () => {
    const registro = new RegistroDeCanales().registrar(canal);
    expect(registro.obtener('whatsapp')).toBe(canal);
    expect(registro.canales).toEqual(['whatsapp']);
  });

  it('lanza con un mensaje util si el canal no esta registrado', () => {
    // El fallo tipico es un adaptador que no se registro al arrancar, asi que
    // el mensaje lista los disponibles.
    const registro = new RegistroDeCanales().registrar(canal);
    expect(() => registro.obtener('instagram')).toThrow(CanalNoRegistrado);
    expect(() => registro.obtener('instagram')).toThrow(/Disponibles: whatsapp/);
  });

  it('convive con varios canales', () => {
    const registro = new RegistroDeCanales()
      .registrar(canal)
      .registrar(new AdaptadorSandbox({ canal: 'instagram' }));
    expect(registro.canales.sort()).toEqual(['instagram', 'whatsapp']);
    expect(registro.tiene('tiktok')).toBe(false);
  });
});

describe('fetchMedia', () => {
  it('descarga los bytes', async () => {
    const m = await canal.fetchMedia('media-1', 'ca-1');
    expect(m.bytes).toBe(m.datos.length);
    expect(m.datos.toString()).toContain('media-1');
  });
});

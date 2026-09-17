/**
 * El hilo.
 *
 * Lo que se prueba aquí es **quién dijo cada cosa**, que es la pregunta diaria
 * de un equipo que atiende a varias manos: si el hilo no lo dice, nadie sabe
 * quién le prometió qué al cliente.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Api } from '../../api/cliente.ts';
import type { Mensaje, ResumenDeConversacion } from '../../api/tipos.ts';
import { Hilo } from './Hilo.tsx';

afterEach(cleanup);

const conversacion: ResumenDeConversacion = {
  id: 'c1',
  canal: 'whatsapp',
  estado: 'open',
  tipo: 'dm',
  publicacionId: null,
  contacto: { id: 'p1', nombre: 'Rosa', handle: null, telefono: null, usuario: null },
  agenteId: null,
  noLeidos: 0,
  ultimoEntranteEn: null,
  ultimoSalienteEn: null,
  ventanaExpiraEn: new Date(Date.now() + 3_600_000).toISOString(),
  ventanaAbierta: true,
  etiquetas: [],
  vistaPrevia: null,
  atencion: 'nueva',
  aplazadaHasta: null,
  relevo: null,
};

let n = 0;
function mensaje(m: Partial<Mensaje>): Mensaje {
  return {
    id: `m${++n}`,
    direccion: 'outbound',
    tipo: 'text',
    texto: 'hola',
    estado: 'sent',
    origen: 'human',
    generado_por_ia: false,
    autor_id: null,
    autor: null,
    autor_foto_id: null,
    creado_en: new Date('2026-09-16T15:00:00Z').toISOString(),
    error: null,
    medio_id: null,
    medio_estado: null,
    medio_nombre: null,
    modo_comentario: null,
    ...m,
  };
}

/** La API devuelve del más nuevo al más antiguo; el hilo los da la vuelta. */
function pintar(mensajes: Mensaje[]) {
  const api = {
    mensajes: vi.fn().mockResolvedValue({ items: [...mensajes].reverse(), siguienteCursor: null }),
    urlDeMedio: vi.fn().mockResolvedValue({ url: 'blob:cara', expiraEnSegundos: 300, mime: null }),
    iaAjustes: vi.fn().mockResolvedValue({ activa: false }),
    respuestasRapidas: vi.fn().mockResolvedValue([]),
    limitesDeMedios: vi.fn().mockResolvedValue({
      mimesPermitidos: [],
      tamanoMaximo: 1,
      porCanal: {},
    }),
  } as unknown as Api;
  render(
    <Hilo
      api={api}
      conversacion={conversacion}
      fichaAbierta={false}
      alAlternarFicha={vi.fn()}
      alVolver={vi.fn()}
      alCambiar={vi.fn()}
    />,
  );
}

describe('Hilo', () => {
  it('dice quién escribió del lado del hotel', async () => {
    pintar([
      mensaje({ direccion: 'inbound', origen: 'contact', texto: '¿Tienen sitio?' }),
      mensaje({ texto: 'Sí, le confirmo', autor: 'Marta', autor_id: 'u1' }),
    ]);
    expect(await screen.findByText('Marta')).toBeTruthy();
  });

  it('dos agentes seguidos NO se confunden en uno', async () => {
    pintar([
      mensaje({ texto: 'Le confirmo el bungalow', autor: 'Marta', autor_id: 'u1' }),
      mensaje({ texto: 'Y el desayuno va incluido', autor: 'Luis', autor_id: 'u2' }),
    ]);
    // Agrupar por dirección escondía el nombre del segundo, y el hilo decía
    // que había hablado una sola persona.
    expect(await screen.findByText('Marta')).toBeTruthy();
    expect(screen.getByText('Luis')).toBeTruthy();
  });

  it('el mismo agente seguido se dice una vez: repetirlo es ruido', async () => {
    pintar([
      mensaje({ texto: 'Le confirmo', autor: 'Marta', autor_id: 'u1' }),
      mensaje({ texto: 'Y el desayuno', autor: 'Marta', autor_id: 'u1' }),
      mensaje({ texto: 'Gracias', autor: 'Marta', autor_id: 'u1' }),
    ]);
    expect(await screen.findAllByText('Marta')).toHaveLength(1);
  });

  it('lo del bot se dice «Bot», y lo entrante no lleva autor', async () => {
    pintar([
      mensaje({ direccion: 'inbound', origen: 'contact', texto: '¿Precio?' }),
      mensaje({ texto: 'Desde S/ 180', origen: 'bot' }),
    ]);
    expect(await screen.findByText('Bot')).toBeTruthy();
  });

  it('quien ya no está en el equipo deja su mensaje, sin fingir que no lo escribió nadie', async () => {
    pintar([mensaje({ texto: 'Se lo reservo', autor: null, autor_id: 'u9' })]);
    expect(await screen.findByText('Un agente')).toBeTruthy();
  });

  it('un documento se enseña con su nombre, no como «Abrir documento»', async () => {
    const api = {
      mensajes: vi.fn().mockResolvedValue({
        items: [
          mensaje({
            direccion: 'inbound',
            origen: 'contact',
            tipo: 'document',
            texto: null,
            medio_id: 'md1',
            medio_estado: 'stored',
            medio_nombre: 'boleta_reserva.pdf',
          }),
        ],
        siguienteCursor: null,
      }),
      urlDeMedio: vi
        .fn()
        .mockResolvedValue({ url: 'blob:x', expiraEnSegundos: 300, mime: 'application/pdf' }),
      iaAjustes: vi.fn().mockResolvedValue({ activa: false }),
      respuestasRapidas: vi.fn().mockResolvedValue([]),
      limitesDeMedios: vi
        .fn()
        .mockResolvedValue({ mimesPermitidos: [], tamanoMaximo: 1, porCanal: {} }),
    } as unknown as Api;
    render(
      <Hilo
        api={api}
        conversacion={conversacion}
        fichaAbierta={false}
        alAlternarFicha={vi.fn()}
        alVolver={vi.fn()}
        alCambiar={vi.fn()}
      />,
    );
    expect(await screen.findByText('boleta_reserva.pdf')).toBeTruthy();
  });

  it('la cara del agente sale en lo que SALE, y una sola vez por tanda', async () => {
    pintar([
      mensaje({ texto: 'Le confirmo', autor: 'Marta', autor_id: 'u1', autor_foto_id: 'f1' }),
      mensaje({ texto: 'Y el desayuno', autor: 'Marta', autor_id: 'u1', autor_foto_id: 'f1' }),
      mensaje({ direccion: 'inbound', origen: 'contact', texto: 'Gracias' }),
    ]);
    await screen.findByText('Le confirmo');
    // Una cara para las dos burbujas de Marta; lo entrante no lleva ninguna,
    // porque de quien escribe ya hay avatar en la cabecera.
    expect(document.querySelectorAll('.avatarAutor')).toHaveLength(1);
  });

  it('dos agentes seguidos llevan cada uno su cara', async () => {
    pintar([
      mensaje({ texto: 'Yo contesto', autor: 'Marta', autor_id: 'u1', autor_foto_id: 'f1' }),
      mensaje({ texto: 'Y yo también', autor: 'Luis', autor_id: 'u2', autor_foto_id: 'f2' }),
    ]);
    await screen.findByText('Yo contesto');
    expect(document.querySelectorAll('.avatarAutor')).toHaveLength(2);
  });

  it('sin foto, la cara es la inicial del nombre', async () => {
    pintar([mensaje({ texto: 'Sin foto', autor: 'Marta', autor_id: 'u1', autor_foto_id: null })]);
    await screen.findByText('Sin foto');
    expect(document.querySelector('.avatarAutor')?.textContent).toBe('M');
  });
});

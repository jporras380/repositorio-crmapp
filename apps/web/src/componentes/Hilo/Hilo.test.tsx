/**
 * El hilo.
 *
 * Lo que se prueba aquí es **quién dijo cada cosa**, que es la pregunta diaria
 * de un equipo que atiende a varias manos: si el hilo no lo dice, nadie sabe
 * quién le prometió qué al cliente.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
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
  equipoId: null,
  noLeidos: 0,
  ultimoEntranteEn: null,
  ultimoSalienteEn: null,
  ventanaExpiraEn: new Date(Date.now() + 3_600_000).toISOString(),
  ventanaAbierta: true,
  etiquetas: [],
  vistaPrevia: null,
  atencion: 'nueva',
  aplazadaHasta: null,
  enEspera: false,
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
function pintar(mensajes: Mensaje[], extra: Record<string, unknown> = {}, conv = conversacion) {
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
    ponerEnEspera: vi.fn().mockResolvedValue(undefined),
    cambiarEstado: vi.fn().mockResolvedValue(undefined),
    ...extra,
  } as unknown as Api;
  const alCambiar = vi.fn();
  render(
    <Hilo
      api={api}
      conversacion={conv}
      fichaAbierta={false}
      alAlternarFicha={vi.fn()}
      alVolver={vi.fn()}
      alCambiar={alCambiar}
    />,
  );
  return { api, alCambiar };
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

/**
 * Las dos salidas (0036).
 *
 * Lo que se prueba es que se distingan: las dos quitan la conversación de
 * pendientes, pero solo una deja que el bot vuelva a hablarle. Confundirlas
 * significa que un cliente al que se decidió no contestar reciba un saludo
 * automático al día siguiente.
 */
describe('Hilo · poner en espera y marcar resuelto', () => {
  it('ofrece las dos, con lo que hace cada una a la vista', async () => {
    pintar([mensaje({ texto: 'Hola' })]);
    const espera = await screen.findByRole('button', { name: 'Poner en espera' });
    expect(espera.getAttribute('title')).toContain('el bot deja de contestarle');
    expect(screen.getByRole('button', { name: 'Marcar resuelto' }).getAttribute('title')).toContain(
      'el bot podrá atenderle',
    );
  });

  it('poner en espera se lo pide al servidor y refresca la bandeja', async () => {
    const { api, alCambiar } = pintar([mensaje({ texto: 'Hola' })]);
    await userEvent.click(await screen.findByRole('button', { name: 'Poner en espera' }));
    expect(api.ponerEnEspera).toHaveBeenCalledWith('c1', true);
    expect(alCambiar).toHaveBeenCalled();
  });

  it('ya en espera, el botón la quita y se dice que el bot está callado', async () => {
    const { api } = pintar([mensaje({ texto: 'Hola' })], {}, { ...conversacion, enEspera: true });
    expect(await screen.findByText(/El bot no le contesta/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Quitar de espera' }));
    expect(api.ponerEnEspera).toHaveBeenCalledWith('c1', false);
  });

  it('marcar resuelto cierra la conversación', async () => {
    const { api } = pintar([mensaje({ texto: 'Hola' })]);
    await userEvent.click(await screen.findByRole('button', { name: 'Marcar resuelto' }));
    expect(api.cambiarEstado).toHaveBeenCalledWith('c1', 'closed');
  });

  it('una ya cerrada no se ofrece cerrar otra vez, pero sí ponerse en espera', async () => {
    pintar([mensaje({ texto: 'Hola' })], {}, { ...conversacion, estado: 'closed' });
    await screen.findByRole('button', { name: 'Poner en espera' });
    expect(screen.queryByRole('button', { name: 'Marcar resuelto' })).toBeNull();
  });

  it('si el servidor falla, se dice y no se finge que salió bien', async () => {
    const { alCambiar } = pintar([mensaje({ texto: 'Hola' })], {
      ponerEnEspera: vi
        .fn()
        .mockRejectedValue(new ErrorDeApi(409, 'no_se_pudo', 'Esa conversación ya no existe.')),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Poner en espera' }));
    expect((await screen.findByRole('alert')).textContent).toContain('ya no existe');
    expect(alCambiar).not.toHaveBeenCalled();
  });
});

/**
 * El globo de sin leer.
 *
 * Abrir un hilo NO lo apaga, y eso es una decisión: en una bandeja compartida
 * abrir es MIRAR —ver de qué va, comprobar si es para uno—, y el globo es lo
 * único que le dice al equipo que ahí queda algo por atender.
 */
describe('Hilo · abrir no marca como leído', () => {
  it('entrar a un hilo con globo no lo apaga', async () => {
    const { api, alCambiar } = pintar(
      [mensaje({ texto: 'Hola' })],
      {},
      {
        ...conversacion,
        noLeidos: 3,
      },
    );
    await screen.findByText('Hola');
    // Ni por un endpoint propio ni de rebote refrescando la lista: mirar no
    // cambia nada en el servidor.
    expect((api as unknown as Record<string, unknown>).marcarLeida).toBeUndefined();
    expect(alCambiar).not.toHaveBeenCalled();
  });

  it('se apaga con un gesto: poner en espera', async () => {
    const { api } = pintar([mensaje({ texto: 'Hola' })], {}, { ...conversacion, noLeidos: 3 });
    await userEvent.click(await screen.findByRole('button', { name: 'Poner en espera' }));
    // El contador lo apaga el servidor dentro del mismo gesto; aquí basta con
    // que el gesto llegue.
    expect(api.ponerEnEspera).toHaveBeenCalledWith('c1', true);
  });
});

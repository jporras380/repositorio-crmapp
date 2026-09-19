/**
 * El informe del periodo.
 *
 * Se prueba lo que cambia cómo se lee: que cambiar de periodo pida otro
 * informe, que la conversión se diga sobre su cohorte («2 de las 5»), y que
 * la mediana venga acompañada del p90 en vez de una media.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Api } from '../../api/cliente.ts';
import type { InformeDelPeriodo } from '../../api/tipos.ts';
import { Informe } from './Informe.tsx';

afterEach(cleanup);

const INFORME: InformeDelPeriodo = {
  periodo: { clave: '7d', desde: '2026-03-03T12:00:00Z', hasta: '2026-03-10T12:00:00Z' },
  conversaciones: {
    nuevas: 4,
    porCanal: [
      { canal: 'whatsapp', nuevas: 3 },
      { canal: 'instagram', nuevas: 1 },
    ],
    atencionAhora: {
      nueva: 2,
      por_responder: 1,
      esperando_cliente: 3,
      seguimiento: 0,
      en_espera: 0,
      cerrada: 5,
    },
  },
  respuesta: { medianaSegundos: 600, p90Segundos: 3000, medidas: 3 },
  agentes: [
    { id: 'u1', nombre: 'Ana', asignadasAbiertas: 4, porResponder: 1, respuestasEnviadas: 12 },
  ],
  clientesNuevos: 4,
  reservas: {
    generadas: 3,
    confirmadas: 2,
    canceladas: 1,
    porMoneda: [{ moneda: 'PEN', confirmado: 150_000, cobrado: 60_000 }],
  },
  embudo: { consultas: 5, conReserva: 2, perdidas: 1 },
};

function pintar(informe = vi.fn().mockResolvedValue(INFORME)) {
  render(<Informe api={{ informe } as unknown as Api} />);
  return informe;
}

describe('Informe', () => {
  it('abre con los últimos 7 días y cambia de periodo pidiendo otro informe', async () => {
    const informe = pintar();
    await waitFor(() => expect(informe).toHaveBeenCalledWith('7d'));
    await userEvent.click(screen.getByRole('tab', { name: '30 días' }));
    await waitFor(() => expect(informe).toHaveBeenLastCalledWith('30d'));
  });

  it('la conversión se dice sobre su cohorte, no como un porcentaje suelto', async () => {
    pintar();
    expect(await screen.findByText('40 %')).toBeTruthy();
    expect(screen.getByText(/2 de las 5 consultas que entraron en el periodo/)).toBeTruthy();
  });

  it('la primera respuesta es mediana con su p90, no una media', async () => {
    pintar();
    expect(await screen.findByText('10 min')).toBeTruthy();
    expect(screen.getByText('50 min')).toBeTruthy();
    expect(screen.getByText(/Mediana y no media/)).toBeTruthy();
  });

  it('con pocas conversaciones medidas lo dice: una mediana de una sola no es tendencia', async () => {
    pintar(
      vi.fn().mockResolvedValue({
        ...INFORME,
        respuesta: { medianaSegundos: 213, p90Segundos: 213, medidas: 1 },
      }),
    );
    expect(await screen.findByText(/Solo una conversación medida/)).toBeTruthy();
  });

  it('sin consultas no inventa una conversión de 0 %', async () => {
    pintar(
      vi
        .fn()
        .mockResolvedValue({ ...INFORME, embudo: { consultas: 0, conReserva: 0, perdidas: 0 } }),
    );
    await screen.findByText('Conversaciones nuevas');
    await waitFor(() => expect(screen.queryByText('0 %')).toBeNull());
  });

  it('por agente, lo que le toca responder se destaca', async () => {
    pintar();
    expect(await screen.findByText('Ana')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
  });
});

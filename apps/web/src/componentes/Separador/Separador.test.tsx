import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LIMITES } from '../../estado/paneles.ts';
import { Separador } from './Separador.tsx';

afterEach(cleanup);

function pintar(extra: Partial<Parameters<typeof Separador>[0]> = {}) {
  const alMover = vi.fn();
  const alFijar = vi.fn();
  const alAlternar = vi.fn();
  render(
    <Separador
      etiqueta="lista de conversaciones"
      controla="panel-lista"
      valor={LIMITES.lista.por}
      limites={LIMITES.lista}
      lado="inicio"
      abierto={true}
      alMover={alMover}
      alFijar={alFijar}
      alAlternar={alAlternar}
      {...extra}
    />,
  );
  return { alMover, alFijar, alAlternar };
}

describe('Separador', () => {
  it('se redimensiona con el teclado y guarda solo el valor final', async () => {
    const { alMover, alFijar } = pintar();
    const asa = screen.getByRole('separator');
    asa.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(alMover).toHaveBeenCalledWith(LIMITES.lista.por + 24);
    expect(alFijar).toHaveBeenCalledWith(LIMITES.lista.por + 24);
    expect(asa.getAttribute('aria-valuenow')).toBe(String(LIMITES.lista.por + 24));
  });

  it('no deja estrechar el panel más allá del mínimo', async () => {
    const { alFijar } = pintar({ valor: LIMITES.lista.min + 8 });
    screen.getByRole('separator').focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(alFijar).toHaveBeenCalledWith(LIMITES.lista.min);
  });

  it('el panel de la derecha crece al revés: la flecha izquierda lo ensancha', async () => {
    const { alFijar } = pintar({ lado: 'fin', limites: LIMITES.ficha, valor: LIMITES.ficha.por });
    screen.getByRole('separator').focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(alFijar).toHaveBeenCalledWith(LIMITES.ficha.por + 24);
  });

  it('doble clic devuelve el ancho normal', async () => {
    const { alFijar } = pintar({ valor: LIMITES.lista.max });
    await userEvent.dblClick(screen.getByRole('separator'));
    expect(alFijar).toHaveBeenCalledWith(LIMITES.lista.por);
  });

  it('plegado: no hay asa que arrastrar, pero sí cómo volver a abrirlo', async () => {
    const { alAlternar } = pintar({ abierto: false });
    expect(screen.queryByRole('separator')).toBeNull();
    const boton = screen.getByRole('button');
    expect(boton.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(boton);
    expect(alAlternar).toHaveBeenCalledOnce();
  });
});

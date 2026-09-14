import { useCallback, useEffect, useState } from 'react';
import type { Api } from '../../api/cliente.ts';
import type { CatalogoDeHotel, ResumenDeReserva } from '../../api/tipos.ts';
import { irA } from '../../estado/ruta.ts';
import { importe } from '../../vista/dinero.ts';
import { Cotizador } from '../hotel/Cotizador.tsx';
import { ESTADO_DE_RESERVA } from '../reservas/etiquetas.ts';
import estilos from './ReservaDeConversacion.module.css';

interface Props {
  api: Api;
  conversacionId: string;
}

/**
 * La reserva, dentro de la conversación.
 *
 * Es el criterio de éxito 10 del encargo y la razón de que esté AQUÍ y no en
 * la pantalla de Reservas: el huésped pide la reserva en el chat, y obligar al
 * agente a salir de la conversación para crearla es exactamente lo que la
 * bandeja única existe para evitar.
 *
 * Muestra primero si ya hay reserva —lo segundo que pregunta cualquiera que
 * abre un hilo— y solo después ofrece crear otra. El formulario es el propio
 * cotizador con un botón más: una segunda forma de pedir el precio acabaría
 * dando otro.
 *
 * El catálogo se carga al abrir el formulario, no con cada conversación: la
 * mayoría de hilos que se abren no terminan en reserva.
 */
export function ReservaDeConversacion({ api, conversacionId }: Props) {
  const [reservas, setReservas] = useState<ResumenDeReserva[] | null>(null);
  const [catalogo, setCatalogo] = useState<CatalogoDeHotel | null>(null);
  const [abierto, setAbierto] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      setReservas(await api.reservas({ conversacionId }));
    } catch {
      setReservas([]);
    }
  }, [api, conversacionId]);

  useEffect(() => {
    setAbierto(false);
    void cargar();
  }, [cargar]);

  async function abrir() {
    setAbierto(true);
    if (!catalogo) {
      try {
        setCatalogo(await api.hotel());
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo cargar el hotel.');
      }
    }
  }

  return (
    <section className={estilos.bloque} aria-label="Reserva">
      <h3 className={estilos.titulo}>Reserva</h3>

      {reservas && reservas.length > 0 && (
        <ul className={estilos.lista}>
          {reservas.map((r) => (
            <li key={r.id}>
              <button
                className={estilos.reserva}
                onClick={() => irA({ pantalla: 'reservas', reservaId: r.id })}
              >
                <span className={estilos.reservaTipo}>
                  {r.tipo} · {r.entrada} → {r.salida}
                </span>
                <span className={`${estilos.estado} ${estilos[`estado_${r.estado}`] ?? ''}`}>
                  {ESTADO_DE_RESERVA[r.estado]}
                </span>
                <span className={estilos.importe}>{importe(r.total, r.moneda)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {reservas && reservas.length === 0 && !abierto && (
        <p className={estilos.pista}>Esta conversación todavía no tiene reserva.</p>
      )}

      {error && <p className={estilos.error}>{error}</p>}

      {abierto ? (
        catalogo ? (
          <div className={estilos.formulario}>
            <Cotizador
              api={api}
              tipos={catalogo.tipos}
              servicios={catalogo.servicios}
              alReservar={async (d) => {
                const r = await api.crearReserva({
                  conversacionId,
                  tipoId: d.tipoId,
                  entrada: d.entrada,
                  salida: d.salida,
                  personas: d.personas,
                  ...(d.servicios.length ? { servicios: d.servicios } : {}),
                  ...(d.aceptarAvisos ? { aceptarAvisos: true } : {}),
                });
                setAbierto(false);
                await cargar();
                irA({ pantalla: 'reservas', reservaId: r.id });
              }}
            />
            <button className={estilos.cancelar} onClick={() => setAbierto(false)}>
              Cancelar
            </button>
          </div>
        ) : (
          <p className={estilos.pista}>Cargando habitaciones…</p>
        )
      ) : (
        <button className={estilos.crear} onClick={() => void abrir()}>
          {reservas && reservas.length > 0 ? 'Crear otra reserva' : 'Crear reserva'}
        </button>
      )}
    </section>
  );
}

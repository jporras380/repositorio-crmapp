import { useCallback, useEffect, useMemo, useState } from 'react';
import { crearApi } from '../../api/cliente.ts';
import type {
  CatalogoDeHotel,
  DetalleDeReserva,
  ResumenDeReserva,
  Sesion,
  Yo,
} from '../../api/tipos.ts';
import { Barra } from '../../componentes/Barra/Barra.tsx';
import { FichaDeReserva } from '../../componentes/reservas/FichaDeReserva.tsx';
import { ESTADO_DE_RESERVA } from '../../componentes/reservas/etiquetas.ts';
import { irA } from '../../estado/ruta.ts';
import { importe } from '../../vista/dinero.ts';
import estilos from './Reservas.module.css';

interface Props {
  sesion: Sesion;
  reservaId: string | null;
  alSalir: () => void;
}

function hoy(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Vistas que se usan en recepción. «Próximas» es la de por defecto: es la que se abre cada mañana. */
const VISTAS = [
  { id: 'proximas', texto: 'Próximas', filtros: () => ({ desde: hoy() }) },
  { id: 'pendientes', texto: 'Por confirmar', filtros: () => ({ estado: 'pendiente' }) },
  { id: 'en_casa', texto: 'En casa', filtros: () => ({ estado: 'en_casa' }) },
  { id: 'todas', texto: 'Todas', filtros: () => ({}) },
] as const;

/**
 * Reservas.
 *
 * La lista va ordenada por fecha de ENTRADA, no de creación: en recepción la
 * pregunta es «quién llega», no «qué se vendió último». Lo pendiente de pago
 * se ve en la misma fila porque es lo segundo que se pregunta.
 *
 * Aquí no se crean reservas: se crean desde la conversación, que es donde el
 * huésped las pide y donde queda enganchada su oportunidad del embudo.
 */
export function Reservas({ sesion, reservaId, alSalir }: Props) {
  const api = useMemo(() => crearApi(sesion.token), [sesion.token]);
  const [yo, setYo] = useState<Yo | null>(null);
  const [vista, setVista] = useState<(typeof VISTAS)[number]['id']>('proximas');
  const [items, setItems] = useState<ResumenDeReserva[]>([]);
  const [detalle, setDetalle] = useState<DetalleDeReserva | null>(null);
  const [catalogo, setCatalogo] = useState<CatalogoDeHotel | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      const f = VISTAS.find((v) => v.id === vista)!.filtros();
      setItems(await api.reservas(f));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudieron cargar las reservas.');
    } finally {
      setCargando(false);
    }
  }, [api, vista]);

  useEffect(() => {
    api
      .yo()
      .then(setYo)
      .catch(() => undefined);
    api
      .hotel()
      .then(setCatalogo)
      .catch(() => undefined);
  }, [api]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  useEffect(() => {
    if (!reservaId) {
      setDetalle(null);
      return;
    }
    api
      .reserva(reservaId)
      .then(setDetalle)
      .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo abrir la reserva.'));
  }, [api, reservaId]);

  const habitaciones = catalogo?.tipos.find((t) => t.id === detalle?.tipoId)?.habitaciones ?? [];

  return (
    <div className={estilos.pantalla}>
      <Barra yo={yo} activa="reservas" alSalir={alSalir} />

      <main className={estilos.centro}>
        <header className={`glass ${estilos.barra}`}>
          <h1 className={estilos.titulo}>Reservas</h1>
          <div className={estilos.vistas} role="tablist" aria-label="Vista">
            {VISTAS.map((v) => (
              <button
                key={v.id}
                role="tab"
                aria-selected={vista === v.id}
                className={`${estilos.vista} ${vista === v.id ? estilos.vistaActiva : ''}`}
                onClick={() => setVista(v.id)}
              >
                {v.texto}
              </button>
            ))}
          </div>
          <p className={estilos.pista}>
            Las reservas se crean desde la conversación con el huésped.
          </p>
        </header>

        {error && <p className={estilos.error}>{error}</p>}

        <div className={estilos.cuerpo}>
          <div className={`glass ${estilos.tabla}`}>
            {cargando && <p className={estilos.vacio}>Cargando…</p>}
            {!cargando && items.length === 0 && (
              <p className={estilos.vacio}>No hay reservas en esta vista.</p>
            )}
            {items.length > 0 && (
              <table className={estilos.rejilla}>
                <thead>
                  <tr>
                    <th>Entrada</th>
                    <th>Huésped</th>
                    <th>Habitación</th>
                    <th>Noches</th>
                    <th>Estado</th>
                    <th className={estilos.derecha}>Total</th>
                    <th className={estilos.derecha}>Pendiente</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => {
                    const pendiente = Math.max(0, r.total - r.pagado);
                    return (
                      <tr
                        key={r.id}
                        className={r.id === reservaId ? estilos.elegida : ''}
                        onClick={() => irA({ pantalla: 'reservas', reservaId: r.id })}
                      >
                        <td className={estilos.numero}>{r.entrada}</td>
                        <td>
                          <button className={estilos.abrir}>
                            {r.contacto.nombre ?? 'Huésped'}
                          </button>
                        </td>
                        <td>
                          {r.tipo}
                          {r.habitacion ? (
                            <span className={estilos.secundario}> · {r.habitacion}</span>
                          ) : (
                            <span className={estilos.sinAsignar}> · sin asignar</span>
                          )}
                        </td>
                        <td className={estilos.numero}>{r.noches}</td>
                        <td>
                          <span
                            className={`${estilos.estado} ${estilos[`estado_${r.estado}`] ?? ''}`}
                          >
                            {ESTADO_DE_RESERVA[r.estado]}
                          </span>
                        </td>
                        <td className={`${estilos.numero} ${estilos.derecha}`}>
                          {importe(r.total, r.moneda)}
                        </td>
                        <td
                          className={`${estilos.numero} ${estilos.derecha} ${
                            pendiente > 0 && r.estado !== 'cancelada' ? estilos.debe : ''
                          }`}
                        >
                          {r.estado === 'cancelada' ? '—' : importe(pendiente, r.moneda)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {detalle && (
            <FichaDeReserva
              api={api}
              reserva={detalle}
              habitaciones={habitaciones}
              alCambiar={(r) => {
                setDetalle(r);
                void cargar();
              }}
              alCerrar={() => irA({ pantalla: 'reservas', reservaId: null })}
            />
          )}
        </div>
      </main>
    </div>
  );
}

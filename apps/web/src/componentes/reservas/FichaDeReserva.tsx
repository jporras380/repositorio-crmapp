import { useState } from 'react';
import type { Api } from '../../api/cliente.ts';
import type {
  AccionDeReserva,
  DetalleDeReserva,
  Habitacion,
  MetodoDePago,
} from '../../api/tipos.ts';
import { irA } from '../../estado/ruta.ts';
import { aCentimos, importe } from '../../vista/dinero.ts';
import { ESTADO_DE_RESERVA } from './etiquetas.ts';
import estilos from './FichaDeReserva.module.css';

interface Props {
  api: Api;
  reserva: DetalleDeReserva;
  /** Habitaciones del tipo reservado, para asignar una concreta. */
  habitaciones: Habitacion[];
  alCambiar: (r: DetalleDeReserva) => void;
  alCerrar: () => void;
}

const ACCION: Record<AccionDeReserva, { texto: string; tono: 'primario' | 'peligro' }> = {
  confirmar: { texto: 'Confirmar reserva', tono: 'primario' },
  llegar: { texto: 'Registrar llegada', tono: 'primario' },
  salir: { texto: 'Registrar salida', tono: 'primario' },
  cancelar: { texto: 'Cancelar', tono: 'peligro' },
};

const METODOS: { valor: MetodoDePago; texto: string }[] = [
  { valor: 'efectivo', texto: 'Efectivo' },
  { valor: 'yape', texto: 'Yape' },
  { valor: 'plin', texto: 'Plin' },
  { valor: 'transferencia', texto: 'Transferencia' },
  { valor: 'tarjeta', texto: 'Tarjeta' },
  { valor: 'otro', texto: 'Otro' },
];

/**
 * La ficha de una reserva.
 *
 * **Los botones de estado los decide el servidor.** Se pintan las `acciones`
 * que devuelve la API y ninguna más: si la web decidiera qué transiciones
 * existen, un día ofrecería «cancelar» a alguien que ya está en la habitación.
 *
 * **Cancelar pide confirmación; confirmar, no.** Confirmar se deshace
 * cancelando; cancelar no se deshace nunca.
 *
 * **Las líneas no se editan.** Son lo que se cotizó y lo que se le dijo al
 * cliente. Cambiar de fechas es cancelar y crear otra, y las dos quedan.
 */
export function FichaDeReserva({ api, reserva, habitaciones, alCambiar, alCerrar }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [cancelando, setCancelando] = useState(false);
  const [pago, setPago] = useState({ importe: '', metodo: 'yape' as MetodoDePago, referencia: '' });

  async function hacer(f: () => Promise<DetalleDeReserva>) {
    setOcupado(true);
    setError(null);
    try {
      alCambiar(await f());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar.');
    } finally {
      setOcupado(false);
    }
  }

  const estado = ESTADO_DE_RESERVA[reserva.estado];

  return (
    <aside
      className={`glass ${estilos.ficha}`}
      aria-label={`Reserva de ${reserva.contacto.nombre ?? ''}`}
    >
      <header className={estilos.cabecera}>
        <div>
          <h2 className={estilos.titulo}>{reserva.contacto.nombre ?? 'Huésped'}</h2>
          <p className={estilos.subtitulo}>
            {reserva.tipo} · {reserva.entrada} → {reserva.salida} · {reserva.noches} noche(s) ·{' '}
            {reserva.personas} persona(s)
          </p>
        </div>
        <button className={estilos.cerrar} onClick={alCerrar} aria-label="Cerrar la reserva">
          ×
        </button>
      </header>

      <p className={`${estilos.estado} ${estilos[`estado_${reserva.estado}`] ?? ''}`}>{estado}</p>

      {error && <p className={estilos.error}>{error}</p>}

      {reserva.acciones.length > 0 && (
        <div className={estilos.acciones}>
          {reserva.acciones.map((a) =>
            a === 'cancelar' && cancelando ? (
              <span key={a} className={estilos.confirmar}>
                ¿Cancelar la reserva? No se deshace.
                <button
                  className={estilos.peligro}
                  disabled={ocupado}
                  onClick={() =>
                    void hacer(async () => {
                      const r = await api.moverReserva(reserva.id, 'cancelar');
                      setCancelando(false);
                      return r;
                    })
                  }
                >
                  Sí, cancelar
                </button>
                <button className={estilos.secundario} onClick={() => setCancelando(false)}>
                  No
                </button>
              </span>
            ) : (
              <button
                key={a}
                className={ACCION[a].tono === 'peligro' ? estilos.secundario : estilos.primario}
                disabled={ocupado}
                onClick={() =>
                  a === 'cancelar'
                    ? setCancelando(true)
                    : void hacer(() => api.moverReserva(reserva.id, a))
                }
              >
                {ACCION[a].texto}
              </button>
            ),
          )}
        </div>
      )}

      {/* --- Habitación -------------------------------------------------------- */}
      <section className={estilos.bloque} aria-label="Habitación">
        <h3 className={estilos.bloqueTitulo}>Habitación</h3>
        <select
          className={estilos.control}
          value={reserva.habitacionId ?? ''}
          disabled={ocupado || reserva.estado === 'cancelada' || reserva.estado === 'finalizada'}
          aria-label="Habitación asignada"
          onChange={(e) =>
            void hacer(() => api.asignarHabitacion(reserva.id, e.target.value || null))
          }
        >
          <option value="">Sin asignar todavía</option>
          {habitaciones.map((h) => (
            <option key={h.id} value={h.id}>
              {h.nombre}
              {h.estado !== 'disponible' ? ` (${h.estado.replace(/_/g, ' ')})` : ''}
            </option>
          ))}
        </select>
        {reserva.solapes.length > 0 && (
          <div className={estilos.solape} role="alert">
            Esta habitación ya está reservada esas noches:
            <ul>
              {reserva.solapes.map((s) => (
                <li key={s.id}>
                  <button
                    className={estilos.enlace}
                    onClick={() => irA({ pantalla: 'reservas', reservaId: s.id })}
                  >
                    {s.contacto ?? 'Otro huésped'} · {s.entrada} → {s.salida}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* --- Importe ----------------------------------------------------------- */}
      <section className={estilos.bloque} aria-label="Importe">
        <h3 className={estilos.bloqueTitulo}>Lo que se cotizó</h3>
        <table className={estilos.lineas}>
          <tbody>
            {reserva.lineas.map((l, i) => (
              <tr key={i} className={l.tipo === 'descuento' ? estilos.descuento : ''}>
                <td>{l.noche ?? l.descripcion}</td>
                <td className={estilos.detalle}>
                  {l.noche ? l.descripcion : l.cantidad > 1 ? `× ${l.cantidad}` : ''}
                </td>
                <td className={estilos.cifra}>{importe(l.total, reserva.moneda)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>Total</td>
              <td className={estilos.cifra}>{importe(reserva.saldo.total, reserva.moneda)}</td>
            </tr>
          </tfoot>
        </table>
      </section>

      {/* --- Pagos ------------------------------------------------------------- */}
      <section className={estilos.bloque} aria-label="Pagos">
        <h3 className={estilos.bloqueTitulo}>Pagos</h3>
        <dl className={estilos.saldo}>
          <div>
            <dt>Pagado</dt>
            <dd>{importe(reserva.saldo.pagado, reserva.moneda)}</dd>
          </div>
          <div className={reserva.saldo.pendiente > 0 ? estilos.pendiente : ''}>
            <dt>Pendiente</dt>
            <dd>{importe(reserva.saldo.pendiente, reserva.moneda)}</dd>
          </div>
          {reserva.saldo.aFavor > 0 && (
            <div className={estilos.aFavor}>
              <dt>A favor del huésped</dt>
              <dd>{importe(reserva.saldo.aFavor, reserva.moneda)}</dd>
            </div>
          )}
        </dl>
        <ul className={estilos.pagos}>
          {reserva.pagos.map((p) => (
            <li key={p.id}>
              <span>{METODOS.find((m) => m.valor === p.metodo)?.texto}</span>
              <span className={estilos.detalle}>
                {new Date(p.pagadoEn).toLocaleDateString('es-PE')}
                {p.referencia ? ` · ${p.referencia}` : ''}
              </span>
              <span className={estilos.cifra}>{importe(p.importe, reserva.moneda)}</span>
            </li>
          ))}
        </ul>
        {reserva.estado !== 'cancelada' && (
          <form
            className={estilos.nuevoPago}
            onSubmit={(e) => {
              e.preventDefault();
              const cents = aCentimos(pago.importe);
              if (cents <= 0) return;
              void hacer(async () => {
                const r = await api.registrarPago(reserva.id, {
                  importe: cents,
                  metodo: pago.metodo,
                  ...(pago.referencia.trim() ? { referencia: pago.referencia.trim() } : {}),
                });
                setPago({ importe: '', metodo: pago.metodo, referencia: '' });
                return r;
              });
            }}
          >
            <input
              className={estilos.control}
              inputMode="decimal"
              placeholder={
                reserva.saldo.pendiente > 0
                  ? `Pendiente ${importe(reserva.saldo.pendiente, reserva.moneda)}`
                  : 'Importe'
              }
              aria-label="Importe del pago"
              value={pago.importe}
              onChange={(e) => setPago({ ...pago, importe: e.target.value })}
            />
            <select
              className={estilos.control}
              aria-label="Método de pago"
              value={pago.metodo}
              onChange={(e) => setPago({ ...pago, metodo: e.target.value as MetodoDePago })}
            >
              {METODOS.map((m) => (
                <option key={m.valor} value={m.valor}>
                  {m.texto}
                </option>
              ))}
            </select>
            <input
              className={estilos.control}
              placeholder="Nº de operación"
              aria-label="Referencia del pago"
              value={pago.referencia}
              onChange={(e) => setPago({ ...pago, referencia: e.target.value })}
            />
            <button className={estilos.primario} disabled={ocupado || !pago.importe.trim()}>
              Registrar pago
            </button>
          </form>
        )}
      </section>

      {/* --- Historial --------------------------------------------------------- */}
      <section className={estilos.bloque} aria-label="Historial">
        <h3 className={estilos.bloqueTitulo}>Historial</h3>
        <ol className={estilos.historial}>
          {reserva.historial.map((h, i) => (
            <li key={i}>
              <span>{HISTORIAL[h.tipo] ?? h.tipo}</span>
              <span className={estilos.detalle}>
                {h.actor ?? 'Sistema'} · {new Date(h.en).toLocaleString('es-PE')}
              </span>
            </li>
          ))}
        </ol>
        {reserva.conversacionId && (
          <button
            className={estilos.enlace}
            onClick={() => irA({ pantalla: 'bandeja', conversacionId: reserva.conversacionId })}
          >
            Abrir la conversación
          </button>
        )}
      </section>
    </aside>
  );
}

const HISTORIAL: Record<string, string> = {
  creada: 'Reserva creada',
  confirmar: 'Confirmada',
  llegar: 'Llegó el huésped',
  salir: 'Salió el huésped',
  cancelar: 'Cancelada',
  pago: 'Pago registrado',
  habitacion: 'Habitación cambiada',
};

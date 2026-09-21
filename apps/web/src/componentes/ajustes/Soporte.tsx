import { useCallback, useEffect, useState } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { PermisoDeSoporte } from '../../api/tipos.ts';
import { ChatDeSoporte } from './ChatDeSoporte.tsx';
import { hace } from '../../vista/tiempo.ts';
import { faltan } from '../../vista/tiempo.ts';
import estilos from './ajustes.module.css';

/**
 * Quién de soporte puede mirar tu cuenta, y hasta cuándo.
 *
 * ## Por qué esta pantalla existe
 *
 * Cuando alguien escribe «no me llegan los mensajes», el soporte necesita ver
 * la bandeja para contestar. Eso son conversaciones de huéspedes, con sus
 * teléfonos y sus fechas, así que **no se entra sin permiso**: soporte pide
 * diciendo para qué, y aquí se abre o no se abre.
 *
 * El plazo lo elige quien abre la puerta. Se puede cerrar antes en cualquier
 * momento, y todo lo que pasa queda en el registro de la cuenta.
 *
 * ## Lo que soporte NO puede hacer aunque entre
 *
 * Escribir. Ni un mensaje, ni un cambio. No es una promesa de esta pantalla:
 * el permiso de base de datos con el que entra no tiene escritura.
 */

interface Props {
  api: Api;
  /** Solo owner o admin deciden; el resto del equipo mira. */
  gestor: boolean;
}

/** Lo que se puede elegir al abrir. Un día es una jornada de soporte. */
const PLAZOS = [1, 4, 8, 24];

export function Soporte({ api, gestor }: Props) {
  const [permisos, setPermisos] = useState<PermisoDeSoporte[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      setPermisos(await api.permisosDeSoporte());
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo cargar.');
    }
  }, [api]);
  useEffect(() => void cargar(), [cargar]);

  async function hacer(id: string, accion: () => Promise<PermisoDeSoporte[]>) {
    setOcupado(id);
    setError(null);
    try {
      setPermisos(await accion());
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo.');
    } finally {
      setOcupado(null);
    }
  }

  const pendientes = (permisos ?? []).filter((p) => p.estado === 'pendiente');
  const activos = (permisos ?? []).filter((p) => p.estado === 'activo');
  const pasados = (permisos ?? []).filter((p) => p.estado === 'terminado');

  return (
    <section className={estilos.seccion}>
      <header className={estilos.cabecera}>
        <div>
          <h2 className={estilos.titulo}>Soporte técnico</h2>
          <p className={estilos.descripcion}>
            Escríbenos por aquí y te respondemos en este mismo hilo. Si hace falta mirar tu bandeja,
            soporte te lo pedirá abajo y lo decides tú.
          </p>
        </div>
      </header>

      {error && (
        <p className={`${estilos.aviso} ${estilos.aviso_error}`} role="alert">
          {error}
        </p>
      )}

      {/* El chat va primero: es lo que se viene a hacer aquí. El permiso de
          acceso se decide DESPUÉS, y normalmente porque soporte lo pidió en
          esta misma conversación. */}
      <ChatDeSoporte api={api} />

      <h3 className={estilos.tarjetaTitulo}>Acceso a tu bandeja</h3>
      <p className={estilos.descripcion}>
        Para ver qué falla, soporte necesita mirar tu bandeja. No puede entrar sin que tú abras, el
        acceso caduca solo, y mientras dura <strong>no puede escribir nada</strong>: ni un mensaje,
        ni un cambio.
      </p>

      {permisos && permisos.length === 0 && (
        <p className={estilos.vacio}>Nadie ha pedido entrar a tu cuenta.</p>
      )}

      {pendientes.map((p) => (
        <article key={p.id} className={estilos.formulario}>
          <p className={estilos.tarjetaTitulo}>
            {p.pedidoPor ?? 'Soporte'} pide entrar · {hace(p.pedidoEn) ?? 'ahora'}
          </p>
          {/* El motivo en grande: es lo único que hay para decidir. */}
          <p className={estilos.descripcion}>«{p.motivo}»</p>

          {gestor ? (
            <div className={estilos.formularioAcciones}>
              <button
                className={estilos.peligro}
                disabled={ocupado === p.id}
                onClick={() => void hacer(p.id, () => api.revocarSoporte(p.id))}
              >
                Rechazar
              </button>
              {/* El plazo se elige al abrir, no se pide en un campo: cuatro
                  botones se responden sin pensar, y un campo vacío invita a
                  escribir 999. */}
              {PLAZOS.map((horas) => (
                <button
                  key={horas}
                  className={estilos.primario}
                  disabled={ocupado === p.id}
                  onClick={() => void hacer(p.id, () => api.aprobarSoporte(p.id, horas))}
                >
                  Dejar {horas} {horas === 1 ? 'hora' : 'horas'}
                </button>
              ))}
            </div>
          ) : (
            <p className={estilos.descripcion}>Solo el dueño o un administrador puede responder.</p>
          )}
        </article>
      ))}

      {activos.map((p) => (
        <article key={p.id} className={estilos.formulario}>
          <p className={`${estilos.tarjetaTitulo} ${estilos.activo}`}>
            {p.pedidoPor ?? 'Soporte'} está viendo tu cuenta
          </p>
          <p className={estilos.descripcion}>
            «{p.motivo}» · termina{' '}
            {faltan(p.expiraEn) === 'hoy' ? 'hoy' : (faltan(p.expiraEn) ?? 'pronto')}
          </p>
          {gestor && (
            <div className={estilos.formularioAcciones}>
              <button
                className={estilos.peligro}
                disabled={ocupado === p.id}
                onClick={() => void hacer(p.id, () => api.revocarSoporte(p.id))}
              >
                Cerrar el acceso ahora
              </button>
            </div>
          )}
        </article>
      ))}

      {pasados.length > 0 && (
        <>
          <h3 className={estilos.tarjetaTitulo}>Accesos anteriores</h3>
          <div className={estilos.tarjetas}>
            {pasados.map((p) => (
              <article key={p.id} className={estilos.tarjeta}>
                <div>
                  <p className={estilos.tarjetaTitulo}>{p.pedidoPor ?? 'Soporte'}</p>
                  <p className={estilos.tarjetaDetalle}>
                    {p.motivo} · {hace(p.pedidoEn) ?? 'ahora'}
                    {/* Distinguir «se abrió» de «no se abrió» es el registro
                        que protege al cliente: no todas las peticiones se
                        concedieron. */}
                    {p.aprobadoEn ? '' : ' · no se abrió'}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

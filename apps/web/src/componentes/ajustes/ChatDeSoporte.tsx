import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { MensajeDeSoporte } from '../../api/tipos.ts';
import { horaDeMensaje, diaDeMensaje } from '../../vista/tiempo.ts';
import estilos from './ChatDeSoporte.module.css';

/**
 * Hablar con soporte técnico desde dentro del CRM.
 *
 * ## Qué reemplaza
 *
 * Escribir por WhatsApp a un número personal. Eso pierde el historial, deja a
 * todo el mundo sin saber qué se respondió, y hace que quien atiende no tenga
 * delante ni el plan ni el estado de los canales de esa cuenta. Aquí está
 * donde ya se está trabajando, y quien contesta ve la cuenta al lado.
 *
 * ## Por qué cualquiera del equipo puede escribir
 *
 * El que se topa con el problema es quien lo cuenta. Obligar a avisar al dueño
 * para poder reportarlo solo garantiza que no se reporte.
 *
 * ## Por qué abrir el hilo SÍ lo marca como leído
 *
 * Es lo contrario de la bandeja, y a propósito: allí «leído» es una decisión
 * sobre el trabajo de un equipo, y aquí es tu propia conversación con quien
 * te vende el producto. No hay nada que decidir.
 */

interface Props {
  api: Api;
  /** Una cuenta concreta: lo usa la consola del operador para responder. */
  tenantId?: string | undefined;
}

export function ChatDeSoporte({ api, tenantId }: Props) {
  const [mensajes, setMensajes] = useState<MensajeDeSoporte[] | null>(null);
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fondo = useRef<HTMLDivElement>(null);

  const cargar = useCallback(async () => {
    try {
      setMensajes(tenantId ? await api.hiloDeSoporteDe(tenantId) : await api.mensajesDeSoporte());
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo cargar la conversación.');
    }
  }, [api, tenantId]);
  useEffect(() => void cargar(), [cargar]);

  // Al fondo, como cualquier chat: lo último es lo que importa.
  useEffect(() => {
    fondo.current?.scrollIntoView({ block: 'end' });
  }, [mensajes]);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    const cuerpo = texto.trim();
    if (!cuerpo) return;
    setEnviando(true);
    setError(null);
    try {
      setMensajes(
        tenantId
          ? await api.responderASoporte(tenantId, cuerpo)
          : await api.escribirASoporte(cuerpo),
      );
      setTexto('');
    } catch (err) {
      setError(err instanceof ErrorDeApi ? err.message : 'No se pudo enviar.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className={estilos.chat}>
      <div className={estilos.hilo} role="log" aria-label="Conversación con soporte">
        {mensajes?.length === 0 && (
          <p className={estilos.vacio}>
            {tenantId
              ? 'Esta cuenta no ha escrito todavía.'
              : 'Cuéntanos qué te pasa y te respondemos por aquí.'}
          </p>
        )}
        {(mensajes ?? []).map((m, i) => {
          const anterior = mensajes![i - 1];
          const dia = diaDeMensaje(m.creadoEn);
          return (
            <div key={m.id}>
              {/* El día solo cuando cambia: en un hilo que dura semanas, sin
                  esto no se sabe si algo se dijo ayer o en marzo. */}
              {(!anterior || diaDeMensaje(anterior.creadoEn) !== dia) && (
                <p className={estilos.dia}>{dia}</p>
              )}
              <Burbuja m={m} propio={tenantId ? m.deLaPlataforma : !m.deLaPlataforma} />
            </div>
          );
        })}
        <div ref={fondo} />
      </div>

      {error && (
        <p className={estilos.error} role="alert">
          {error}
        </p>
      )}

      <form className={estilos.compositor} onSubmit={enviar}>
        <label className="visually-hidden" htmlFor="mensaje-de-soporte">
          Mensaje para soporte
        </label>
        <textarea
          id="mensaje-de-soporte"
          className={estilos.entrada}
          rows={2}
          maxLength={4000}
          value={texto}
          placeholder={tenantId ? 'Responder…' : 'Escribe qué te pasa…'}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            // Enter envía; Mayús+Enter salta de línea. Es lo que hace el
            // teclado de cualquiera que use esto todo el día.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void enviar(e as unknown as FormEvent);
            }
          }}
        />
        <button type="submit" className={estilos.enviar} disabled={enviando || !texto.trim()}>
          {enviando ? 'Enviando…' : 'Enviar'}
        </button>
      </form>
    </div>
  );
}

function Burbuja({ m, propio }: { m: MensajeDeSoporte; propio: boolean }) {
  return (
    <div className={`${estilos.fila} ${propio ? estilos.filaPropia : ''}`}>
      <div className={`${estilos.burbuja} ${propio ? estilos.burbujaPropia : ''}`}>
        {/* Quién lo escribió: en una cuenta con varios agentes, «alguien dijo»
            no sirve para entender qué pasó. */}
        <p className={estilos.autor}>
          {m.deLaPlataforma ? `${m.autor ?? 'Soporte'} · soporte` : (m.autor ?? 'Tu equipo')}
        </p>
        <p className={estilos.cuerpo}>{m.cuerpo}</p>
        <p className={estilos.hora}>{horaDeMensaje(m.creadoEn)}</p>
      </div>
    </div>
  );
}

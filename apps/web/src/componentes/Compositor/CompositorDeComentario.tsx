import { useState, type KeyboardEvent } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { Mensaje, ResumenDeConversacion } from '../../api/tipos.ts';
import estilos from './Compositor.module.css';

interface Props {
  api: Api;
  conversacion: ResumenDeConversacion;
  /** Lo ya enviado en el hilo: dice si la privada está gastada. */
  mensajes: Mensaje[];
  alEnviado: () => void;
}

/**
 * Responder a un comentario. Dos acciones con consecuencias distintas, y por
 * eso son dos botones y no un desplegable:
 *
 * - **En privado** abre un mensaje directo con quien comentó. Es donde se
 *   captura el lead y es el camino principal (igual que en Kommo). Solo se
 *   puede una vez por comentario: si se gasta en un saludo, no hay segunda.
 * - **En público** cuelga la respuesta del propio comentario y la ve
 *   cualquiera.
 *
 * Que el privado falle es corriente: mucha gente tiene los mensajes cerrados.
 * No es una avería, así que se explica en tono normal y se ofrece el público.
 */
export function CompositorDeComentario({ api, conversacion, mensajes, alEnviado }: Props) {
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<{ mensaje: string; sugerirPublico: boolean } | null>(null);
  /**
   * Ya se gastó la privada en este hilo. Lo dice el servidor —cada mensaje
   * trae si fue pública o privada—, no una cuenta hecha aquí: la web pinta,
   * no decide.
   */
  const privadaGastada = mensajes.some(
    (m) => m.direccion === 'outbound' && m.modo_comentario === 'privada' && m.estado !== 'failed',
  );

  async function responder(modo: 'privada' | 'publica') {
    const t = texto.trim();
    if (!t || enviando) return;
    setEnviando(true);
    setError(null);
    try {
      await api.enviar(conversacion.id, { tipo: 'comment_reply', modo, texto: t });
      setTexto('');
      alEnviado();
    } catch (e) {
      if (e instanceof ErrorDeApi) {
        // El proveedor rechaza el privado cuando la persona no acepta
        // mensajes, o cuando ya se envió uno por ese comentario.
        const cerrado =
          modo === 'privada' &&
          ['canal_destinatario_invalido', 'canal_rechazado_por_proveedor'].includes(e.codigo);
        setError({
          mensaje: cerrado
            ? 'Esta persona no acepta mensajes privados, o ya le enviaste uno por este comentario.'
            : e.message,
          sugerirPublico: cerrado,
        });
      } else {
        setError({ mensaje: 'No se pudo enviar. Revisa tu conexión.', sugerirPublico: false });
      }
    } finally {
      setEnviando(false);
    }
  }

  function teclas(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void responder('privada');
    }
  }

  return (
    <div className={estilos.compositor}>
      <p className={estilos.nota}>
        Comentario público. Responder en privado abre un mensaje directo y solo se puede una vez.
      </p>

      {error && (
        <div className={estilos.aviso} role="alert">
          <p>{error.mensaje}</p>
          {error.sugerirPublico && (
            <div className={estilos.sugeridas}>
              <button
                type="button"
                className={estilos.sugerida}
                onClick={() => void responder('publica')}
                disabled={enviando}
              >
                Responder en el comentario
              </button>
            </div>
          )}
        </div>
      )}

      <div className={estilos.caja}>
        <textarea
          className={estilos.area}
          rows={1}
          placeholder="Escribe tu respuesta"
          value={texto}
          disabled={enviando}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={teclas}
          aria-label="Respuesta al comentario"
        />
        {/*
          Se avisa ANTES, no después: gastar la única privada en un «ahora te
          contesto» no se deshace, y el agente no tiene por qué saberse las
          reglas de Meta de memoria.
        */}
        <p className={estilos.avisoPrivada}>
          {privadaGastada
            ? 'La respuesta privada de este comentario ya se usó. Queda la pública.'
            : 'La respuesta privada es una sola por comentario, y no se recupera.'}
        </p>
        <div className={estilos.dosAcciones}>
          <button
            type="button"
            className={estilos.publica}
            onClick={() => void responder('publica')}
            disabled={enviando || !texto.trim()}
            title="Se publica bajo el comentario y la ve cualquiera"
          >
            En público
          </button>
          <button
            type="button"
            className={estilos.enviar}
            onClick={() => void responder('privada')}
            disabled={enviando || !texto.trim() || privadaGastada}
            title={
              privadaGastada
                ? 'Ya enviaste la única respuesta privada de este comentario'
                : 'Abre un mensaje directo con quien comentó. Solo se puede una vez.'
            }
          >
            {enviando ? 'Enviando…' : 'En privado'}
          </button>
        </div>
      </div>
    </div>
  );
}

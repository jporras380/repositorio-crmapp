import { useCallback, useEffect, useState } from 'react';
import type { Api } from '../../api/cliente.ts';
import type { NotaInterna } from '../../api/tipos.ts';
import { diaDeMensaje, horaDeMensaje } from '../../vista/tiempo.ts';
import estilos from './Notas.module.css';

interface Props {
  api: Api;
  conversacionId: string;
  userId: string;
}

/**
 * Notas internas de la conversación.
 *
 * **No son mensajes y por eso no están en el hilo.** Viven en la ficha, con
 * otro color y bajo un título que lo dice: «solo lo ve el equipo». La
 * alternativa —mezclarlas en el hilo con una marca— convierte un descuido
 * visual en un mensaje enviado al cliente, y ese error no se puede deshacer.
 *
 * Se borran solo por quien las escribió. Reescribir lo que dijo un compañero
 * no es una función, es un problema.
 */
export function Notas({ api, conversacionId, userId }: Props) {
  const [notas, setNotas] = useState<NotaInterna[]>([]);
  const [texto, setTexto] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      setNotas(await api.notas(conversacionId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudieron cargar las notas.');
    }
  }, [api, conversacionId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function anotar() {
    const cuerpo = texto.trim();
    if (!cuerpo) return;
    setOcupado(true);
    try {
      await api.anotar(conversacionId, cuerpo);
      setTexto('');
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar la nota.');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <section className={estilos.notas} aria-label="Notas internas">
      <h3 className={estilos.titulo}>
        Notas internas <span className={estilos.aviso}>solo las ve el equipo</span>
      </h3>

      <div className={estilos.escribir}>
        <textarea
          className={estilos.campo}
          rows={2}
          placeholder="Pidió cuna, confirmar con limpieza…"
          aria-label="Nueva nota interna"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/⌘+Enter guarda. Enter a secas hace párrafo: una nota suele
            // tener dos líneas y perderla por un Enter de más molesta.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void anotar();
          }}
        />
        <button
          className={estilos.boton}
          disabled={!texto.trim() || ocupado}
          onClick={() => void anotar()}
        >
          Anotar
        </button>
      </div>

      {error && <p className={estilos.error}>{error}</p>}

      <ul className={estilos.lista}>
        {notas.map((n) => (
          <li key={n.id} className={estilos.nota}>
            <p className={estilos.cuerpo}>{n.cuerpo}</p>
            <p className={estilos.firma}>
              {n.autor ?? 'Alguien'} · {diaDeMensaje(n.creadaEn)} {horaDeMensaje(n.creadaEn)}
              {n.autorId === userId && (
                <button
                  className={estilos.borrar}
                  aria-label="Borrar la nota"
                  onClick={async () => {
                    await api.borrarNota(n.id);
                    await cargar();
                  }}
                >
                  Borrar
                </button>
              )}
            </p>
          </li>
        ))}
        {notas.length === 0 && <li className={estilos.vacio}>Sin notas todavía.</li>}
      </ul>
    </section>
  );
}

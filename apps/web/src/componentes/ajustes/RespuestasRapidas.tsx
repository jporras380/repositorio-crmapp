import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { RespuestaRapida } from '../../api/tipos.ts';
import estilos from './ajustes.module.css';

interface Props {
  api: Api;
  gestor: boolean;
}

export function RespuestasRapidas({ api, gestor }: Props) {
  const [lista, setLista] = useState<RespuestaRapida[] | null>(null);
  const [editando, setEditando] = useState<RespuestaRapida | 'nueva' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      setLista(await api.respuestasRapidas());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudieron cargar.');
    }
  }, [api]);
  useEffect(() => void cargar(), [cargar]);

  async function archivar(r: RespuestaRapida) {
    if (!confirm(`¿Archivar ${r.atajo}? Los mensajes ya enviados no cambian.`)) return;
    try {
      await api.archivarRapida(r.id);
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo archivar.');
    }
  }

  return (
    <section className={estilos.seccion}>
      <header className={estilos.cabecera}>
        <div>
          <h2 className={estilos.titulo}>Respuestas rápidas</h2>
          <p className={estilos.descripcion}>
            Textos que el equipo repite. En el compositor se escriben con «/» y el atajo. Solo salen
            con la ventana abierta: para escribir primero, usa una plantilla.
          </p>
        </div>
        {gestor && editando === null && (
          <button className={estilos.primario} onClick={() => setEditando('nueva')}>
            Nueva respuesta
          </button>
        )}
      </header>

      {error && (
        <p className={`${estilos.aviso} ${estilos.aviso_error}`} role="alert">
          {error}
        </p>
      )}

      {editando !== null && (
        <Formulario
          api={api}
          inicial={editando === 'nueva' ? null : editando}
          alCancelar={() => setEditando(null)}
          alGuardar={async () => {
            setEditando(null);
            await cargar();
          }}
        />
      )}

      {lista && lista.length === 0 && editando === null && (
        <p className={estilos.vacio}>Todavía no hay respuestas rápidas.</p>
      )}

      <div className={estilos.tarjetas}>
        {lista?.map((r) => (
          <article key={r.id} className={estilos.tarjeta}>
            <span className={estilos.estado}>{r.atajo}</span>
            <div>
              <p className={estilos.tarjetaTitulo}>{r.titulo}</p>
              <p className={estilos.tarjetaDetalle}>
                {r.cuerpo || '(sin texto)'}
                {r.medioId ? ' · con adjunto' : ''} · v{r.version}
              </p>
            </div>
            {gestor && (
              <div className={estilos.acciones}>
                <button className={estilos.secundario} onClick={() => setEditando(r)}>
                  Editar
                </button>
                <button className={estilos.peligro} onClick={() => void archivar(r)}>
                  Archivar
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function Formulario({
  api,
  inicial,
  alCancelar,
  alGuardar,
}: {
  api: Api;
  inicial: RespuestaRapida | null;
  alCancelar: () => void;
  alGuardar: () => Promise<void>;
}) {
  const [atajo, setAtajo] = useState(inicial?.atajo ?? '/');
  const [titulo, setTitulo] = useState(inicial?.titulo ?? '');
  const [cuerpo, setCuerpo] = useState(inicial?.cuerpo ?? '');
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setGuardando(true);
    setError(null);
    try {
      if (inicial) await api.editarRapida(inicial.id, { atajo, titulo, cuerpo });
      else await api.crearRapida({ atajo, titulo, cuerpo });
      await alGuardar();
    } catch (err) {
      setError(err instanceof ErrorDeApi ? err.message : 'No se pudo guardar.');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <form className={estilos.formulario} onSubmit={guardar}>
      <div className={estilos.campos}>
        <label className={estilos.campo}>
          <span>Atajo</span>
          <input
            required
            value={atajo}
            onChange={(e) => setAtajo(e.target.value.toLowerCase())}
            pattern="^/[a-z0-9_-]{1,30}$"
            title="Empieza por / y usa letras, números, guion o guion bajo"
          />
          <span className={estilos.ayuda}>Con barra, sin espacios: /gracias, /horario</span>
        </label>
        <label className={estilos.campo}>
          <span>Título</span>
          <input
            required
            maxLength={80}
            value={titulo}
            onChange={(e) => setTitulo(e.target.value)}
          />
        </label>
      </div>
      <label className={estilos.campo}>
        <span>Texto</span>
        <textarea maxLength={4096} value={cuerpo} onChange={(e) => setCuerpo(e.target.value)} />
      </label>
      {error && (
        <p className={`${estilos.aviso} ${estilos.aviso_error}`} role="alert">
          {error}
        </p>
      )}
      <div className={estilos.formularioAcciones}>
        <button type="button" className={estilos.secundario} onClick={alCancelar}>
          Cancelar
        </button>
        <button type="submit" className={estilos.primario} disabled={guardando}>
          {guardando ? 'Guardando…' : inicial ? 'Guardar cambios' : 'Crear respuesta'}
        </button>
      </div>
    </form>
  );
}

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Api } from '../../api/cliente.ts';
import estilos from './NombreDelContacto.module.css';

interface Props {
  api: Api;
  contactoId: string;
  nombre: string | null;
  handle: string | null;
  /** Tras guardar: la lista de la bandeja tiene que enseñar el nombre nuevo. */
  alGuardar: () => void;
}

/**
 * El nombre del contacto, editable donde se atiende.
 *
 * Es el nombre de la PERSONA (`contacts.display_name`), no el perfil de
 * WhatsApp: los mensajes siguientes no lo pisan, así que sirve para recordar
 * de qué se trató («Rosa · reserva julio»). El número o el @usuario siguen
 * debajo, que es lo que dice a quién se escribe.
 */
export function NombreDelContacto({ api, contactoId, nombre, handle, alGuardar }: Props) {
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState(nombre ?? '');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const campo = useRef<HTMLInputElement>(null);

  // Otra conversación, otro contacto: no se arrastra una edición a medias.
  useEffect(() => {
    setEditando(false);
    setValor(nombre ?? '');
    setError(null);
  }, [contactoId, nombre]);

  useEffect(() => {
    if (editando) campo.current?.select();
  }, [editando]);

  async function guardar(e: FormEvent) {
    e.preventDefault();
    const limpio = valor.trim();
    if (limpio === (nombre ?? '')) {
      setEditando(false);
      return;
    }
    setGuardando(true);
    setError(null);
    try {
      // Vacío = sin nombre propio: la bandeja vuelve a enseñar el número o @usuario.
      await api.editarCliente(contactoId, { nombre: limpio || null });
      setEditando(false);
      alGuardar();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar el nombre.');
    } finally {
      setGuardando(false);
    }
  }

  if (editando) {
    return (
      <form className={estilos.formulario} onSubmit={guardar}>
        <label className="visually-hidden" htmlFor={`nombre-${contactoId}`}>
          Nombre del contacto
        </label>
        <input
          id={`nombre-${contactoId}`}
          ref={campo}
          className={estilos.campo}
          value={valor}
          maxLength={120}
          placeholder={handle ?? 'Nombre'}
          onChange={(e) => setValor(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setEditando(false);
              setValor(nombre ?? '');
            }
          }}
        />
        <div className={estilos.acciones}>
          <button
            type="button"
            className={estilos.secundario}
            onClick={() => {
              setEditando(false);
              setValor(nombre ?? '');
            }}
          >
            Cancelar
          </button>
          <button type="submit" className={estilos.primario} disabled={guardando}>
            {guardando ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
        {error && (
          <p className={estilos.error} role="alert">
            {error}
          </p>
        )}
      </form>
    );
  }

  return (
    <div className={estilos.vista}>
      <h2 className={estilos.nombre}>{nombre ?? handle ?? 'Sin nombre'}</h2>
      <button
        type="button"
        className={estilos.editar}
        onClick={() => setEditando(true)}
        title="Cambiar el nombre"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" className={estilos.icono}>
          <path d="M11.5 2.5l2 2L6 12l-2.8.8L4 10z" />
        </svg>
        <span className="visually-hidden">Cambiar el nombre</span>
      </button>
    </div>
  );
}

import { useEffect, useState, type FormEvent } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { AjustesDeIa } from '../../api/tipos.ts';
import estilos from './ajustes.module.css';

interface Props {
  api: Api;
  gestor: boolean;
}

const NOMBRE_DE_MODELO: Record<string, string> = {
  'claude-opus-5': 'Claude Opus 5 — mejores respuestas',
  'claude-sonnet-5': 'Claude Sonnet 5 — equilibrio entre calidad y costo',
  'claude-haiku-4-5': 'Claude Haiku 4.5 — la más rápida y económica',
};

/**
 * Ajustes → IA. La IA redacta borradores y un agente los revisa y envía:
 * nunca contesta sola. Usa la clave de API del propio hotel, que se verifica
 * con Anthropic al guardarla y no se vuelve a mostrar.
 */
export function Ia({ api, gestor }: Props) {
  const [ajustes, setAjustes] = useState<AjustesDeIa | null>(null);
  const [modelo, setModelo] = useState('');
  const [instrucciones, setInstrucciones] = useState('');
  const [clave, setClave] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  function aplicar(a: AjustesDeIa) {
    setAjustes(a);
    setModelo(a.modelo);
    setInstrucciones(a.instrucciones);
  }

  useEffect(() => {
    api
      .iaAjustes()
      .then(aplicar)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'No se pudieron cargar los ajustes de IA.'),
      );
  }, [api]);

  async function guardar(cambios: Parameters<Api['guardarIa']>[0], hecho: string) {
    setGuardando(true);
    setError(null);
    setAviso(null);
    try {
      aplicar(await api.guardarIa(cambios));
      setClave('');
      setAviso(hecho);
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo guardar.');
    } finally {
      setGuardando(false);
    }
  }

  async function borrarClave() {
    if (!confirm('¿Borrar la clave? La IA se desactivará hasta que guardes otra.')) return;
    setGuardando(true);
    setError(null);
    try {
      aplicar(await api.borrarClaveIa());
      setAviso('Clave borrada. La IA está desactivada.');
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo borrar la clave.');
    } finally {
      setGuardando(false);
    }
  }

  function enviarFormulario(e: FormEvent) {
    e.preventDefault();
    void guardar(
      {
        modelo,
        instrucciones,
        ...(clave.trim() ? { clave: clave.trim() } : {}),
      },
      clave.trim() ? 'Clave verificada con Anthropic y guardada.' : 'Ajustes guardados.',
    );
  }

  return (
    <section className={estilos.seccion}>
      <header className={estilos.cabecera}>
        <div>
          <h2 className={estilos.titulo}>IA asistida</h2>
          <p className={estilos.descripcion}>
            En cada conversación, «Sugerir con IA» escribe un borrador de respuesta con el catálogo
            del hotel. El agente lo revisa, lo corrige y lo envía él: la IA nunca contesta sola. Se
            usa la clave de Anthropic del hotel, así que el consumo se paga en esa cuenta.
          </p>
        </div>
        {ajustes && (
          <span
            className={`${estilos.estado} ${ajustes.activa ? estilos.estado_ok : ''}`}
            role="status"
          >
            {ajustes.activa ? 'Activada' : 'Desactivada'}
          </span>
        )}
      </header>

      {error && (
        <p className={`${estilos.aviso} ${estilos.aviso_error}`} role="alert">
          {error}
        </p>
      )}
      {aviso && <p className={`${estilos.aviso} ${estilos.aviso_ok}`}>{aviso}</p>}

      {ajustes && !gestor && (
        <p className={estilos.vacio}>
          {ajustes.activa
            ? 'La IA está activada para tu equipo. Pide a un administrador cualquier cambio.'
            : 'La IA está desactivada. Un administrador puede activarla aquí.'}
        </p>
      )}

      {ajustes && gestor && (
        <form className={estilos.formulario} onSubmit={enviarFormulario}>
          <div className={estilos.campos}>
            <label className={estilos.campo}>
              <span>Clave de API de Anthropic</span>
              <input
                type="password"
                autoComplete="off"
                placeholder={
                  ajustes.tieneClave ? 'Guardada · escribe otra para cambiarla' : 'sk-ant-…'
                }
                value={clave}
                onChange={(e) => setClave(e.target.value)}
              />
              <span className={estilos.ayuda}>
                Se crea en console.anthropic.com → API Keys. Se comprueba al guardar y no se vuelve
                a mostrar.
              </span>
            </label>
            <label className={estilos.campo}>
              <span>Modelo</span>
              <select value={modelo} onChange={(e) => setModelo(e.target.value)}>
                {ajustes.modelosDisponibles.map((m) => (
                  <option key={m} value={m}>
                    {NOMBRE_DE_MODELO[m] ?? m}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className={estilos.campo}>
            <span>Instrucciones para la IA (opcional)</span>
            <textarea
              rows={5}
              maxLength={8000}
              placeholder="Ej.: Tuteamos al cliente. Check-in desde las 14:00 y check-out hasta las 12:00. Aceptamos Yape, Plin y efectivo. Mascotas no."
              value={instrucciones}
              onChange={(e) => setInstrucciones(e.target.value)}
            />
            <span className={estilos.ayuda}>
              Tono, horarios y políticas. Las habitaciones, capacidades y tarifas base se añaden
              solas desde el catálogo del hotel.
            </span>
          </label>
          <div className={estilos.formularioAcciones}>
            {ajustes.tieneClave && (
              <button
                type="button"
                className={estilos.peligro}
                onClick={() => void borrarClave()}
                disabled={guardando}
              >
                Borrar clave
              </button>
            )}
            <button
              type="button"
              className={estilos.secundario}
              disabled={guardando || (!ajustes.tieneClave && !clave.trim())}
              onClick={() =>
                void guardar(
                  {
                    activa: !ajustes.activa,
                    ...(clave.trim() ? { clave: clave.trim() } : {}),
                  },
                  ajustes.activa ? 'IA desactivada.' : 'IA activada para todo el equipo.',
                )
              }
            >
              {ajustes.activa ? 'Desactivar IA' : 'Activar IA'}
            </button>
            <button type="submit" className={estilos.primario} disabled={guardando}>
              {guardando ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

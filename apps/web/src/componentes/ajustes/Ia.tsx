import { useEffect, useState, type FormEvent } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { AjustesDeIa, Proveedor } from '../../api/tipos.ts';
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
  const [proveedor, setProveedor] = useState<Proveedor>('anthropic');
  const [modelo, setModelo] = useState('');
  const [instrucciones, setInstrucciones] = useState('');
  const [clave, setClave] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  function aplicar(a: AjustesDeIa) {
    setAjustes(a);
    setProveedor(a.proveedor);
    setModelo(a.modelo);
    setInstrucciones(a.instrucciones);
  }

  /** Los datos del proveedor que se está mirando: nombre, modelos y aviso. */
  const datos = ajustes?.proveedores.find((p) => p.id === proveedor);

  /**
   * Cambiar de proveedor en la pantalla, sin guardar todavía.
   *
   * El modelo salta al primero del nuevo: «claude-opus-5» no existe en Google,
   * y dejarlo escrito invitaría a guardar una pareja imposible.
   */
  function cambiarProveedor(nuevo: Proveedor) {
    setProveedor(nuevo);
    const d = ajustes?.proveedores.find((p) => p.id === nuevo);
    setModelo(d?.modelos[0] ?? '');
    setClave('');
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
    if (
      !confirm(`¿Borrar la clave de ${datos?.nombre}? La IA se desactivará hasta que guardes otra.`)
    )
      return;
    setGuardando(true);
    setError(null);
    try {
      aplicar(await api.borrarClaveIa(proveedor));
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
        proveedor,
        modelo,
        instrucciones,
        ...(clave.trim() ? { clave: clave.trim() } : {}),
      },
      clave.trim()
        ? `Clave verificada con ${datos?.nombre ?? 'el proveedor'} y guardada.`
        : 'Ajustes guardados.',
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
            elige el proveedor —Claude, Gemini, GPT o Grok— y usa la clave del propio hotel, así que
            el consumo se paga en esa cuenta.
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
          <label className={estilos.campo}>
            <span>Quién redacta</span>
            <select
              value={proveedor}
              onChange={(e) => cambiarProveedor(e.target.value as Proveedor)}
            >
              {ajustes.proveedores.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre}
                  {/* Se dice cuáles ya tienen clave: cambiar de proveedor y
                      volver no debería obligar a ir a buscarla otra vez. */}
                  {ajustes.proveedoresConClave.includes(p.id) ? ' · clave guardada' : ''}
                </option>
              ))}
            </select>
            <span className={estilos.ayuda}>
              Todos van con la clave del propio hotel: el consumo se paga en esa cuenta, no aquí.
            </span>
          </label>

          {/* El aviso del proveedor, cuando lo hay. Antes del campo de la
              clave a propósito: se lee mientras se decide, no después de
              haberla pegado. */}
          {datos?.aviso && (
            <p className={`${estilos.aviso} ${estilos.aviso_error}`} role="alert">
              {datos.aviso}
            </p>
          )}

          <div className={estilos.campos}>
            <label className={estilos.campo}>
              <span>Clave de API de {datos?.nombre ?? 'la IA'}</span>
              <input
                type="password"
                autoComplete="off"
                placeholder={
                  ajustes.proveedoresConClave.includes(proveedor)
                    ? 'Guardada · escribe otra para cambiarla'
                    : 'Pega aquí la clave'
                }
                value={clave}
                onChange={(e) => setClave(e.target.value)}
              />
              <span className={estilos.ayuda}>
                Se crea en {datos?.dondeSacarLaClave}. Se comprueba al guardar y no se vuelve a
                mostrar.
              </span>
            </label>
            <label className={estilos.campo}>
              <span>Modelo</span>
              {/*
                Un desplegable con sugerencias Y campo escribible: los nombres
                de modelo cambian cada pocos meses, y una lista cerrada
                obligaría a esperar una versión del CRM para usar el de ayer.
                Al guardar, el proveedor confirma si existe.
              */}
              <input
                list="modelos-de-ia"
                value={modelo}
                onChange={(e) => setModelo(e.target.value)}
                placeholder={datos?.modelos[0]}
              />
              <datalist id="modelos-de-ia">
                {(datos?.modelos ?? []).map((m) => (
                  <option key={m} value={m}>
                    {NOMBRE_DE_MODELO[m] ?? m}
                  </option>
                ))}
              </datalist>
              <span className={estilos.ayuda}>
                Los sugeridos salen al escribir. Puedes poner otro: se comprueba al guardar.
              </span>
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
            {ajustes.proveedoresConClave.includes(proveedor) && (
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
              disabled={
                guardando || (!ajustes.proveedoresConClave.includes(proveedor) && !clave.trim())
              }
              onClick={() =>
                void guardar(
                  {
                    activa: !ajustes.activa,
                    proveedor,
                    modelo,
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

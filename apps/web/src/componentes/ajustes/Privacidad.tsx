import { useEffect, useState } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { PlazoDeRetencion, Privacidad as DatosDePrivacidad } from '../../api/tipos.ts';
import compartidos from './ajustes.module.css';
import estilos from './Privacidad.module.css';

interface Props {
  api: Api;
}

/** `null` es «siempre», y va primero: es lo que hay si nadie toca nada. */
const OPCIONES: [PlazoDeRetencion | null, string][] = [
  [null, 'Siempre'],
  [12, '1 año'],
  [24, '2 años'],
  [36, '3 años'],
  [60, '5 años'],
];

const cifra = (n: number) => n.toLocaleString('es-PE');

/**
 * Ajustes → Privacidad: cuánto tiempo se guardan los mensajes (0052).
 *
 * Es la única pantalla del producto que programa un borrado sin vuelta, y
 * por eso tres cosas:
 *
 * 1. Cada plazo dice **cuántos mensajes caerían hoy**: «2 años» no dice nada,
 *    «se borran 3.412 mensajes» sí.
 * 2. Guardar un plazo que borra algo **pide confirmación** con esa cifra.
 * 3. Solo el propietario la cambia; el resto la ve, para saber qué pasa con
 *    su historial.
 */
export function Privacidad({ api }: Props) {
  const [datos, setDatos] = useState<DatosDePrivacidad | null>(null);
  const [elegido, setElegido] = useState<PlazoDeRetencion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    api
      .privacidad()
      .then((d) => {
        setDatos(d);
        setElegido(d.retencionMeses);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'No se pudo cargar la privacidad.'),
      );
  }, [api]);

  async function guardar() {
    if (!datos) return;
    const caerian = elegido === null ? 0 : datos.caerianConCadaPlazo[elegido];
    if (
      caerian > 0 &&
      !confirm(
        `Esta noche se borrarán ${cifra(caerian)} mensajes con más de ${etiqueta(elegido)}, ` +
          'con sus fotos, audios y documentos. No se puede deshacer. ¿Seguir?',
      )
    ) {
      return;
    }
    setGuardando(true);
    setError(null);
    setAviso(null);
    try {
      const d = await api.guardarPrivacidad(elegido);
      setDatos(d);
      setElegido(d.retencionMeses);
      setAviso(
        d.retencionMeses === null
          ? 'Guardado: los mensajes se guardan siempre.'
          : `Guardado: se borran solos los mensajes con más de ${etiqueta(d.retencionMeses)}.`,
      );
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo guardar.');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <section className={compartidos.seccion}>
      <header className={compartidos.cabecera}>
        <div>
          <h2 className={compartidos.titulo}>Cuánto se guardan los mensajes</h2>
          <p className={compartidos.descripcion}>
            Los mensajes más viejos que el plazo se borran solos cada noche, con sus fotos, audios y
            documentos. Las boletas, los vouchers de pago y los adjuntos del chat de soporte no se
            tocan. Lo borrado no se puede recuperar.
          </p>
        </div>
        {datos?.puedeCambiar && (
          <button
            className={compartidos.primario}
            disabled={guardando || elegido === datos.retencionMeses}
            onClick={() => void guardar()}
          >
            {guardando ? 'Guardando…' : 'Guardar'}
          </button>
        )}
      </header>

      {error && (
        <p className={`${compartidos.aviso} ${compartidos.aviso_error}`} role="alert">
          {error}
        </p>
      )}
      {aviso && <p className={`${compartidos.aviso} ${compartidos.aviso_ok}`}>{aviso}</p>}

      {datos && (
        <fieldset className={estilos.opciones} disabled={!datos.puedeCambiar}>
          <legend className="visually-hidden">Plazo</legend>
          {OPCIONES.map(([plazo, nombre]) => {
            const caerian = plazo === null ? 0 : datos.caerianConCadaPlazo[plazo];
            return (
              <label
                key={nombre}
                className={`${estilos.opcion} ${elegido === plazo ? estilos.opcionElegida : ''}`}
              >
                <input
                  type="radio"
                  name="retencion"
                  checked={elegido === plazo}
                  onChange={() => setElegido(plazo)}
                />
                <span className={estilos.nombre}>{nombre}</span>
                <span className={caerian > 0 ? estilos.caen : estilos.detalle}>
                  {plazo === null
                    ? 'No se borra nada'
                    : caerian > 0
                      ? `Hoy se borrarían ${cifra(caerian)} mensajes`
                      : 'Hoy no se borraría ninguno'}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}

      {datos && !datos.puedeCambiar && (
        <p className={`${compartidos.aviso} ${compartidos.aviso_info}`} role="status">
          Solo el propietario de la cuenta puede cambiarlo.
        </p>
      )}
    </section>
  );
}

function etiqueta(meses: PlazoDeRetencion | null): string {
  return OPCIONES.find(([p]) => p === meses)?.[1] ?? `${meses} meses`;
}

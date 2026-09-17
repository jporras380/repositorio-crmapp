import { useEffect, useRef, useState } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import estilos from './Aplazar.module.css';

/**
 * Aplazar una conversación: «esto lo veo luego».
 *
 * La pieza existía entera en el servidor desde la bandeja original —endpoint,
 * `snoozed_until`, estado de atención «seguimiento» y hasta la insignia
 * «Aplazada» en la lista— y **no había ningún botón que la llamara**. Se podía
 * ver una conversación aplazada y no se podía aplazar ninguna.
 *
 * ## Por qué plazos fijos y no un calendario
 *
 * Quien atiende una recepción no quiere elegir día y hora: quiere quitarse
 * algo de encima ahora y que vuelva luego. Cuatro opciones cubren el día de
 * trabajo, y «mañana» usa la hora de quien mira, que es la que tiene en la
 * cabeza.
 */

/** Plazos, en el orden en que se piensan. `null` en `manana` = caso aparte. */
const PLAZOS: { etiqueta: string; horas: number | null }[] = [
  { etiqueta: 'En 1 hora', horas: 1 },
  { etiqueta: 'En 3 horas', horas: 3 },
  { etiqueta: 'Mañana a las 9:00', horas: null },
];

/** Mañana a las 9:00 en la hora de quien está mirando. */
function mananaALasNueve(ahora = new Date()): Date {
  const d = new Date(ahora);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

interface Props {
  api: Api;
  conversacionId: string;
  /** Instante hasta el que está aplazada, o `null` si no lo está. */
  aplazadaHasta: string | null;
  alCambiar: () => void;
}

export function Aplazar({ api, conversacionId, aplazadaHasta, alCambiar }: Props) {
  const [abierto, setAbierto] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const caja = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) setAbierto(false);
    };
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAbierto(false);
    };
    document.addEventListener('mousedown', fuera);
    document.addEventListener('keydown', tecla);
    return () => {
      document.removeEventListener('mousedown', fuera);
      document.removeEventListener('keydown', tecla);
    };
  }, [abierto]);

  async function aplazar(hasta: Date | null) {
    setOcupado(true);
    setError(null);
    try {
      await api.aplazar(conversacionId, hasta ? hasta.toISOString() : null);
      setAbierto(false);
      alCambiar();
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo aplazar.');
    } finally {
      setOcupado(false);
    }
  }

  const aplazada = aplazadaHasta !== null && new Date(aplazadaHasta) > new Date();

  return (
    <div className={estilos.caja} ref={caja}>
      <button
        className={`${estilos.boton} ${aplazada ? estilos.activo : ''}`}
        aria-expanded={abierto}
        onClick={() => setAbierto((v) => !v)}
        title={
          aplazada
            ? `Aplazada hasta ${new Date(aplazadaHasta!).toLocaleString('es')}`
            : 'Verlo más tarde'
        }
      >
        <span aria-hidden="true">🕒</span>
        <span className={estilos.texto}>{aplazada ? 'Aplazada' : 'Aplazar'}</span>
      </button>

      {abierto && (
        <div className={estilos.menu} role="menu" aria-label="Aplazar la conversación">
          {PLAZOS.map((p) => (
            <button
              key={p.etiqueta}
              role="menuitem"
              className={estilos.opcion}
              disabled={ocupado}
              onClick={() =>
                void aplazar(
                  p.horas === null ? mananaALasNueve() : new Date(Date.now() + p.horas * 3_600_000),
                )
              }
            >
              {p.etiqueta}
            </button>
          ))}
          {/* Quitarlo tiene que estar donde se puso: buscarlo en otro sitio es
              lo que hace que la gente deje de usar estas cosas. */}
          {aplazada && (
            <button
              role="menuitem"
              className={`${estilos.opcion} ${estilos.quitar}`}
              disabled={ocupado}
              onClick={() => void aplazar(null)}
            >
              Volver a verla ahora
            </button>
          )}
          {error && (
            <p className={estilos.error} role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

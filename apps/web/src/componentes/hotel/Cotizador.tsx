import { useEffect, useState } from 'react';
import type { Api } from '../../api/cliente.ts';
import type { Cotizacion, ServicioDeHotel, TipoDeHabitacion } from '../../api/tipos.ts';
import { importe } from '../../vista/dinero.ts';
import estilos from './Cotizador.module.css';

interface Props {
  api: Api;
  tipos: TipoDeHabitacion[];
  servicios: ServicioDeHotel[];
  /** Tipo con el que abrir, si viene elegido de la lista. */
  tipoInicial?: string | null;
}

function hoyMas(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  // Fecha LOCAL: el agente piensa en «mañana en Barranca», no en UTC.
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}

/**
 * El cotizador: tipo, fechas, personas y extras → precio desglosado.
 *
 * **No calcula nada aquí.** Pregunta al servidor, que usa la misma función
 * que usará la reserva. Si la web sumara por su cuenta, el día que cambie una
 * regla —la de qué tarifa manda, por ejemplo— el agente diría un precio y la
 * reserva guardaría otro.
 *
 * **Una cotización incompleta no se disimula.** Si una noche no tiene precio,
 * el total se tacha y se dice por qué: dar esa cifra por teléfono es regalar
 * una noche. Los avisos que no invalidan el precio —mínimo de noches, más
 * personas de las que caben— se ven, pero la cifra sigue siendo real.
 */
export function Cotizador({ api, tipos, servicios, tipoInicial }: Props) {
  const activos = tipos.filter((t) => t.activo);
  const [tipoId, setTipoId] = useState(tipoInicial ?? activos[0]?.id ?? '');
  const [entrada, setEntrada] = useState(hoyMas(1));
  const [salida, setSalida] = useState(hoyMas(3));
  const [personas, setPersonas] = useState(2);
  const [extras, setExtras] = useState<string[]>([]);
  const [cotizacion, setCotizacion] = useState<Cotizacion | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (tipoInicial) setTipoId(tipoInicial);
  }, [tipoInicial]);

  // Recalcula solo al dejar de tocar: una cotización por tecla no aporta nada.
  useEffect(() => {
    if (!tipoId || !entrada || !salida) return;
    let vigente = true;
    const t = setTimeout(async () => {
      try {
        const c = await api.cotizar({
          tipoId,
          entrada,
          salida,
          personas,
          ...(extras.length ? { servicios: extras } : {}),
        });
        if (vigente) {
          setCotizacion(c);
          setError(null);
        }
      } catch (e) {
        if (vigente) setError(e instanceof Error ? e.message : 'No se pudo cotizar.');
      }
    }, 250);
    return () => {
      vigente = false;
      clearTimeout(t);
    };
  }, [api, tipoId, entrada, salida, personas, extras]);

  if (activos.length === 0) {
    return (
      <section className={`glass ${estilos.cotizador}`} aria-label="Cotizador">
        <h2 className={estilos.titulo}>Cotizar una estancia</h2>
        <p className={estilos.pista}>Crea un tipo de habitación para poder cotizar.</p>
      </section>
    );
  }

  const aviso = cotizacion?.problemas ?? [];
  const serviciosActivos = servicios.filter((s) => s.activo);

  return (
    <section className={`glass ${estilos.cotizador}`} aria-label="Cotizador">
      <h2 className={estilos.titulo}>Cotizar una estancia</h2>

      <div className={estilos.campos}>
        <label className={estilos.campo}>
          <span className={estilos.etiqueta}>Habitación</span>
          <select
            className={estilos.control}
            value={tipoId}
            onChange={(e) => setTipoId(e.target.value)}
          >
            {activos.map((t) => (
              <option key={t.id} value={t.id}>
                {t.nombre} · hasta {t.capacidad}
              </option>
            ))}
          </select>
        </label>
        <label className={estilos.campo}>
          <span className={estilos.etiqueta}>Entrada</span>
          <input
            className={estilos.control}
            type="date"
            value={entrada}
            onChange={(e) => setEntrada(e.target.value)}
          />
        </label>
        <label className={estilos.campo}>
          <span className={estilos.etiqueta}>Salida</span>
          <input
            className={estilos.control}
            type="date"
            min={entrada}
            value={salida}
            onChange={(e) => setSalida(e.target.value)}
          />
        </label>
        <label className={estilos.campo}>
          <span className={estilos.etiqueta}>Personas</span>
          <input
            className={estilos.control}
            type="number"
            min={1}
            max={50}
            value={personas}
            onChange={(e) => setPersonas(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
      </div>

      {serviciosActivos.length > 0 && (
        <fieldset className={estilos.extras}>
          <legend className={estilos.etiqueta}>Extras</legend>
          {serviciosActivos.map((s) => (
            <label key={s.id} className={estilos.extra}>
              <input
                type="checkbox"
                checked={extras.includes(s.id)}
                onChange={(e) =>
                  setExtras((x) => (e.target.checked ? [...x, s.id] : x.filter((i) => i !== s.id)))
                }
              />
              {s.nombre}
            </label>
          ))}
        </fieldset>
      )}

      {error && <p className={estilos.error}>{error}</p>}

      {cotizacion && (
        <div className={estilos.resultado} role="status" aria-live="polite">
          <p className={`${estilos.total} ${cotizacion.completa ? '' : estilos.totalIncompleto}`}>
            {importe(cotizacion.total, cotizacion.moneda)}
          </p>
          <p className={estilos.resumen}>
            {cotizacion.noches} noche(s) · {cotizacion.personas} persona(s)
            {cotizacion.completa ? '' : ' · falta el precio de alguna noche'}
          </p>

          {aviso.length > 0 && (
            <ul className={estilos.avisos}>
              {aviso.map((p, i) => (
                <li
                  key={i}
                  className={p.codigo === 'noche_sin_precio' ? estilos.avisoGrave : estilos.aviso}
                >
                  {p.mensaje}
                </li>
              ))}
            </ul>
          )}

          <table className={estilos.desglose}>
            <tbody>
              {cotizacion.detalle.map((n) => (
                <tr key={n.fecha}>
                  <td>{n.fecha}</td>
                  <td className={estilos.tarifa}>{n.tarifa ?? 'Precio base'}</td>
                  <td className={estilos.cifra}>{importe(n.precio, cotizacion.moneda)}</td>
                </tr>
              ))}
              {cotizacion.servicios.map((s) => (
                <tr key={s.nombre}>
                  <td>{s.nombre}</td>
                  <td className={estilos.tarifa}>× {s.cantidad}</td>
                  <td className={estilos.cifra}>{importe(s.total, cotizacion.moneda)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

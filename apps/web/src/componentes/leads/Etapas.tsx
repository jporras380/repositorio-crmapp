import { useState } from 'react';
import type { Api } from '../../api/cliente.ts';
import type { EtapaDeEmbudo, TipoDeEtapa } from '../../api/tipos.ts';
import estilos from './Etapas.module.css';

interface Props {
  api: Api;
  embudoId: string;
  etapas: EtapaDeEmbudo[];
  /** Cuántos leads hay en cada etapa: decide si borrar pregunta destino. */
  totales: Record<string, number>;
  alCerrar: () => void;
  alCambiar: () => void | Promise<void>;
}

const TIPOS: { valor: TipoDeEtapa; texto: string }[] = [
  { valor: 'abierta', texto: 'En curso' },
  { valor: 'ganada', texto: 'Cierra ganando' },
  { valor: 'perdida', texto: 'Cierra perdiendo' },
];

/** Paleta corta y con contraste suficiente en claro y en oscuro. */
const COLORES = [
  '#0A84FF',
  '#5E5CE6',
  '#FF9F0A',
  '#FF375F',
  '#30D158',
  '#64D2FF',
  '#BF5AF2',
  '#8E8E93',
];

/**
 * Administrar las etapas del embudo.
 *
 * Tres decisiones que se notan al usarlo:
 *
 * - **Borrar pregunta a dónde van los leads.** Una etapa con veinte ventas
 *   dentro no se borra con un «¿seguro?»: hay que decir dónde caen. El
 *   servidor lo exige igualmente, así que la interfaz no está adivinando una
 *   regla suya.
 * - **Reordenar con flechas, no arrastrando.** Son cinco o seis filas que se
 *   tocan una vez al mes; el arrastre aquí solo añadiría una forma más de
 *   equivocarse, y con teclado no funcionaría.
 * - **El tipo es un campo aparte del nombre.** «Recojo en tienda» puede ser
 *   una etapa en curso o una venta cerrada según el negocio, y el pronóstico
 *   depende de eso, no de cómo se llame.
 */
export function Etapas({ api, embudoId, etapas, totales, alCerrar, alCambiar }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [borrando, setBorrando] = useState<string | null>(null);
  const [destino, setDestino] = useState('');
  const [nueva, setNueva] = useState('');
  const [ocupado, setOcupado] = useState(false);

  async function conError(f: () => Promise<unknown>) {
    setOcupado(true);
    setError(null);
    try {
      await f();
      await alCambiar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar.');
    } finally {
      setOcupado(false);
    }
  }

  function mover(i: number, salto: -1 | 1) {
    const orden = etapas.map((e) => e.id);
    const j = i + salto;
    if (j < 0 || j >= orden.length) return;
    [orden[i], orden[j]] = [orden[j]!, orden[i]!];
    void conError(() => api.ordenarEtapas(embudoId, orden));
  }

  return (
    <section className={`glass ${estilos.panel}`} aria-label="Etapas del embudo">
      <header className={estilos.cabecera}>
        <div>
          <h2 className={estilos.titulo}>Etapas del embudo</h2>
          <p className={estilos.subtitulo}>
            El nombre lo pones tú; lo que cuenta para el pronóstico es si la etapa está en curso o
            cierra la venta.
          </p>
        </div>
        <button className={estilos.cerrar} onClick={alCerrar}>
          Listo
        </button>
      </header>

      {error && <p className={estilos.error}>{error}</p>}

      <ul className={estilos.lista}>
        {etapas.map((e, i) => (
          <li key={e.id} className={estilos.fila}>
            <span className={estilos.orden}>
              <button
                className={estilos.flecha}
                disabled={i === 0 || ocupado}
                aria-label={`Subir ${e.nombre}`}
                onClick={() => mover(i, -1)}
              >
                ↑
              </button>
              <button
                className={estilos.flecha}
                disabled={i === etapas.length - 1 || ocupado}
                aria-label={`Bajar ${e.nombre}`}
                onClick={() => mover(i, 1)}
              >
                ↓
              </button>
            </span>

            <input
              className={estilos.nombre}
              defaultValue={e.nombre}
              aria-label={`Nombre de la etapa ${e.nombre}`}
              onBlur={(ev) => {
                const nombre = ev.target.value.trim();
                if (nombre && nombre !== e.nombre)
                  void conError(() => api.editarEtapa(e.id, { nombre }));
              }}
            />

            <select
              className={estilos.tipo}
              value={e.tipo}
              aria-label={`Qué significa ${e.nombre}`}
              onChange={(ev) =>
                void conError(() => api.editarEtapa(e.id, { tipo: ev.target.value as TipoDeEtapa }))
              }
            >
              {TIPOS.map((t) => (
                <option key={t.valor} value={t.valor}>
                  {t.texto}
                </option>
              ))}
            </select>

            <span className={estilos.colores}>
              {COLORES.map((c) => (
                <button
                  key={c}
                  className={`${estilos.color} ${e.color === c ? estilos.colorPuesto : ''}`}
                  ref={(n) => n?.style.setProperty('--color', c)}
                  aria-label={`Color ${c} para ${e.nombre}`}
                  aria-pressed={e.color === c}
                  onClick={() => void conError(() => api.editarEtapa(e.id, { color: c }))}
                />
              ))}
            </span>

            <span className={estilos.cuantos}>{totales[e.id] ?? 0}</span>

            {borrando === e.id ? (
              <span className={estilos.borrado}>
                {(totales[e.id] ?? 0) > 0 && (
                  <select
                    className={estilos.tipo}
                    value={destino}
                    aria-label="Mover sus leads a"
                    onChange={(ev) => setDestino(ev.target.value)}
                  >
                    <option value="">¿A qué etapa van?</option>
                    {etapas
                      .filter((o) => o.id !== e.id)
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.nombre}
                        </option>
                      ))}
                  </select>
                )}
                <button
                  className={estilos.borrarSi}
                  disabled={ocupado || ((totales[e.id] ?? 0) > 0 && !destino)}
                  onClick={() =>
                    void conError(async () => {
                      await api.borrarEtapa(e.id, destino || undefined);
                      setBorrando(null);
                      setDestino('');
                    })
                  }
                >
                  Borrar
                </button>
                <button className={estilos.borrarNo} onClick={() => setBorrando(null)}>
                  No
                </button>
              </span>
            ) : (
              <button
                className={estilos.borrar}
                aria-label={`Borrar la etapa ${e.nombre}`}
                disabled={ocupado}
                onClick={() => {
                  setBorrando(e.id);
                  setDestino('');
                }}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>

      <form
        className={estilos.nueva}
        onSubmit={(ev) => {
          ev.preventDefault();
          const nombre = nueva.trim();
          if (!nombre) return;
          void conError(async () => {
            await api.crearEtapa(embudoId, { nombre });
            setNueva('');
          });
        }}
      >
        <input
          className={estilos.nombre}
          placeholder="Añadir una etapa…"
          aria-label="Nombre de la etapa nueva"
          value={nueva}
          onChange={(ev) => setNueva(ev.target.value)}
        />
        <button className={estilos.anadir} disabled={ocupado || !nueva.trim()}>
          Añadir
        </button>
      </form>
    </section>
  );
}

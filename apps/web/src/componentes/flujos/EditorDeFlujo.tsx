import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Api } from '../../api/cliente.ts';
import type {
  DetalleDeFlujo,
  DisparadorDeFlujo,
  Etiqueta,
  GrafoDeFlujo,
  HorarioDeAtencion,
  HorasActivasDeFlujo,
  Miembro,
  NodoDeFlujo,
  ProblemaDeFlujo,
  SimulacionDeFlujo,
} from '../../api/tipos.ts';
import { MapaDelFlujo } from './MapaDelFlujo.tsx';
import { Simulador } from './Simulador.tsx';
import estilos from './EditorDeFlujo.module.css';

interface Props {
  api: Api;
  flujoId: string;
  alCambiar: () => void | Promise<void>;
}

type Tipo = NodoDeFlujo['tipo'];

const NOMBRES: Record<Tipo, string> = {
  mensaje: 'Enviar mensaje',
  esperar_respuesta: 'Esperar respuesta',
  pausa: 'Pausa',
  condicion: 'Según lo que responda',
  etiquetar: 'Poner etiqueta',
  asignar: 'Asignar a alguien',
  relevo: 'Pasar a una persona',
  fin: 'Terminar',
};

/** Cuánto espera el paso, en unidades que una persona escribe sin calcular. */
const UNIDADES: [string, number][] = [
  ['minutos', 60],
  ['horas', 3600],
  ['días', 86_400],
];

/**
 * La pausa se mide en otra escala: sirve para no soltar dos mensajes en el
 * mismo segundo, así que lo normal son segundos y el tope es un día.
 */
const UNIDADES_DE_PAUSA: [string, number][] = [
  ['segundos', 1],
  ['minutos', 60],
  ['horas', 3600],
];

/**
 * Constructor de flujos.
 *
 * **Por qué una columna de pasos y no un lienzo con nodos arrastrables.** Un
 * lienzo libre es mucho más trabajo —posiciones que guardar, aristas que
 * dibujar, zoom, colisiones— y con seis tipos de nodo el resultado sería un
 * diagrama bonito que se lee peor que una lista. La columna se ordena SOLA
 * siguiendo los enlaces desde el inicio, así que el camino principal se lee de
 * arriba abajo y las ramas cuelgan etiquetadas. Si algún día los flujos tienen
 * treinta pasos y tres caminos paralelos, el lienzo se gana su coste; hoy no.
 *
 * **La validación no vive aquí.** La web no puede importar `core` (guarda de
 * arquitectura) y duplicar las reglas sería peor: la comprobación viaja con la
 * simulación, que es la misma llamada al servidor. Lo que ves antes de
 * publicar es literalmente lo que el servidor decidirá al publicar.
 */
export function EditorDeFlujo({ api, flujoId, alCambiar }: Props) {
  const [detalle, setDetalle] = useState<DetalleDeFlujo | null>(null);
  const [nombre, setNombre] = useState('');
  const [grafo, setGrafo] = useState<GrafoDeFlujo | null>(null);
  const [disparadores, setDisparadores] = useState<DisparadorDeFlujo[]>([]);
  const [horasActivas, setHorasActivas] = useState<HorasActivasDeFlujo>('siempre');
  /** Horario del hotel: solo para avisar de que dos voces hablarían a la vez. */
  const [horario, setHorario] = useState<HorarioDeAtencion | null>(null);
  const [etiquetas, setEtiquetas] = useState<Etiqueta[]>([]);
  const [usuarios, setUsuarios] = useState<Miembro[]>([]);
  const [sucio, setSucio] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [simulacion, setSimulacion] = useState<SimulacionDeFlujo | null>(null);
  const [respuestas, setRespuestas] = useState<string[]>([]);
  /** Paso elegido en el mapa. El mapa no edita: selecciona, y la tarjeta edita. */
  const [seleccionado, setSeleccionado] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    void (async () => {
      try {
        const [d, e, u, h] = await Promise.all([
          api.flujo(flujoId),
          api.etiquetas(),
          api.usuarios(),
          // El horario es un extra: si falla, el editor funciona igual y solo
          // se pierde el aviso de las dos voces.
          api.horario().catch(() => null),
        ]);
        if (!vivo) return;
        setDetalle(d);
        setNombre(d.nombre);
        setGrafo(d.grafo);
        setDisparadores(d.disparadores);
        setHorasActivas(d.horasActivas);
        setHorario(h);
        setEtiquetas(e);
        setUsuarios(u);
      } catch (err) {
        if (vivo) setError(err instanceof Error ? err.message : 'No se pudo abrir el flujo.');
      }
    })();
    return () => {
      vivo = false;
    };
  }, [api, flujoId]);

  // La comprobación va con la simulación: una sola llamada, una sola verdad.
  const temporizador = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!grafo) return;
    if (temporizador.current) clearTimeout(temporizador.current);
    temporizador.current = setTimeout(() => {
      api
        .probarFlujo(grafo, respuestas)
        .then(setSimulacion)
        .catch(() => undefined);
    }, 500);
    return () => {
      if (temporizador.current) clearTimeout(temporizador.current);
    };
  }, [api, grafo, respuestas]);

  const cambiarGrafo = useCallback((siguiente: GrafoDeFlujo) => {
    setGrafo(siguiente);
    setSucio(true);
    setAviso(null);
  }, []);

  const problemas: ProblemaDeFlujo[] = simulacion?.problemas ?? detalle?.problemas ?? [];
  const ordenados = useMemo(() => (grafo ? ordenar(grafo) : { camino: [], sueltos: [] }), [grafo]);

  async function hacer(fn: () => Promise<string | null>) {
    setOcupado(true);
    setError(null);
    try {
      const mensaje = await fn();
      setAviso(mensaje);
      await alCambiar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar.');
    } finally {
      setOcupado(false);
    }
  }

  const guardar = () =>
    hacer(async () => {
      if (!grafo) return null;
      await api.guardarFlujo(flujoId, { nombre, grafo, disparadores, horasActivas });
      setSucio(false);
      const d = await api.flujo(flujoId);
      setDetalle(d);
      return 'Guardado como versión nueva.';
    });

  const publicar = () =>
    hacer(async () => {
      if (sucio && grafo) {
        await api.guardarFlujo(flujoId, { nombre, grafo, disparadores, horasActivas });
        setSucio(false);
      }
      const { version } = await api.publicarFlujo(flujoId);
      setDetalle(await api.flujo(flujoId));
      return `Activo con la versión ${version}. Ya responde a lo que entre.`;
    });

  const pausar = () =>
    hacer(async () => {
      await api.pausarFlujo(flujoId);
      setDetalle(await api.flujo(flujoId));
      return 'En pausa. Lo que ya está en curso termina; no arranca nada nuevo.';
    });

  if (error && !detalle) {
    return (
      <p className={`glass ${estilos.error}`} role="alert">
        {error}
      </p>
    );
  }
  if (!detalle || !grafo) return <p className={`glass ${estilos.cargando}`}>Abriendo…</p>;

  const destinos = grafo.nodos.map((n) => ({ id: n.id, etiqueta: resumenDeNodo(n) }));

  return (
    <div className={estilos.editor}>
      <header className={`glass ${estilos.barra}`}>
        <input
          className={estilos.nombre}
          value={nombre}
          aria-label="Nombre del flujo"
          onChange={(e) => {
            setNombre(e.target.value);
            setSucio(true);
          }}
        />
        <span className={`${estilos.estado} ${estilos[`estado_${detalle.estado}`] ?? ''}`}>
          {detalle.estado === 'activo'
            ? `Activo · v${detalle.version}`
            : detalle.estado === 'pausado'
              ? 'En pausa'
              : 'Borrador'}
        </span>
        <div className={estilos.acciones}>
          <button className={estilos.secundario} onClick={guardar} disabled={ocupado || !sucio}>
            Guardar
          </button>
          {detalle.estado === 'activo' ? (
            <button className={estilos.secundario} onClick={pausar} disabled={ocupado}>
              Pausar
            </button>
          ) : (
            <button
              className={estilos.primario}
              onClick={publicar}
              disabled={ocupado || problemas.length > 0}
              title={
                problemas.length > 0 ? 'Corrige los avisos antes de activarlo' : 'Ponerlo a atender'
              }
            >
              Activar
            </button>
          )}
        </div>
      </header>

      {aviso && (
        <p className={`glass ${estilos.aviso}`} role="status">
          {aviso}
        </p>
      )}
      {error && (
        <p className={`glass ${estilos.error}`} role="alert">
          {error}
        </p>
      )}

      <div className={estilos.columnas}>
        <section className={`glass ${estilos.lienzo}`} aria-label="Pasos del flujo">
          {/*
            El mapa enseña la FORMA del flujo —ramas incluidas— y la tarjeta de
            abajo lo edita. Es la decisión de ADR-012: ver como en un lienzo,
            sin pagar el lienzo.
          */}
          <MapaDelFlujo grafo={grafo} seleccionado={seleccionado} alSeleccionar={setSeleccionado} />

          <Disparadores
            valor={disparadores}
            horasActivas={horasActivas}
            horario={horario}
            alCambiar={(d) => {
              setDisparadores(d);
              setSucio(true);
            }}
            alCambiarHoras={(h) => {
              setHorasActivas(h);
              setSucio(true);
            }}
          />

          {problemas.length > 0 && (
            <ul className={estilos.problemas} aria-label="Avisos">
              {problemas.map((p, i) => (
                <li key={i} className={estilos.problema}>
                  {p.mensaje}
                </li>
              ))}
            </ul>
          )}

          <ol className={estilos.pasos}>
            {ordenados.camino.map((nodo, i) => (
              <Paso
                key={nodo.id}
                nodo={nodo}
                indice={i + 1}
                esInicio={nodo.id === grafo.inicio}
                seleccionado={nodo.id === seleccionado}
                destinos={destinos}
                etiquetas={etiquetas}
                usuarios={usuarios}
                problemas={problemas.filter((p) => p.nodoId === nodo.id)}
                alCambiar={(n) => cambiarGrafo(reemplazar(grafo, n))}
                alBorrar={() => cambiarGrafo(borrar(grafo, nodo.id))}
                alInsertar={(tipo) => cambiarGrafo(insertar(grafo, nodo.id, tipo))}
              />
            ))}
          </ol>

          {ordenados.sueltos.length > 0 && (
            <>
              <h3 className={estilos.sueltosTitulo}>Sin conectar</h3>
              <ol className={estilos.pasos}>
                {ordenados.sueltos.map((nodo) => (
                  <Paso
                    key={nodo.id}
                    nodo={nodo}
                    indice={0}
                    esInicio={false}
                    seleccionado={nodo.id === seleccionado}
                    destinos={destinos}
                    etiquetas={etiquetas}
                    usuarios={usuarios}
                    problemas={problemas.filter((p) => p.nodoId === nodo.id)}
                    alCambiar={(n) => cambiarGrafo(reemplazar(grafo, n))}
                    alBorrar={() => cambiarGrafo(borrar(grafo, nodo.id))}
                    alInsertar={(tipo) => cambiarGrafo(insertar(grafo, nodo.id, tipo))}
                  />
                ))}
              </ol>
            </>
          )}
        </section>

        <Simulador
          simulacion={simulacion}
          respuestas={respuestas}
          usuarios={usuarios}
          etiquetas={etiquetas}
          alCambiarRespuestas={setRespuestas}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Un paso
// ---------------------------------------------------------------------------

interface PropsDePaso {
  nodo: NodoDeFlujo;
  indice: number;
  esInicio: boolean;
  seleccionado: boolean;
  destinos: { id: string; etiqueta: string }[];
  etiquetas: Etiqueta[];
  usuarios: Miembro[];
  problemas: ProblemaDeFlujo[];
  alCambiar: (n: NodoDeFlujo) => void;
  alBorrar: () => void;
  alInsertar: (tipo: Tipo) => void;
}

function Paso({
  nodo,
  indice,
  esInicio,
  seleccionado,
  destinos,
  etiquetas,
  usuarios,
  problemas,
  alCambiar,
  alBorrar,
  alInsertar,
}: PropsDePaso) {
  const [abriendo, setAbriendo] = useState(false);
  const otros = destinos.filter((d) => d.id !== nodo.id);
  const tarjeta = useRef<HTMLLIElement>(null);

  // Elegir en el mapa tiene que traer la tarjeta a la vista: si no, pulsar un
  // nodo lejano parece que no hace nada.
  useEffect(() => {
    // `?.` en la función y no solo en el nodo: jsdom no implementa
    // `scrollIntoView`, y no vale la pena que un test se caiga por algo que en
    // un navegador siempre existe.
    if (seleccionado) tarjeta.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [seleccionado]);

  return (
    <li
      ref={tarjeta}
      className={`${estilos.paso} ${problemas.length ? estilos.pasoConAviso : ''} ${
        seleccionado ? estilos.pasoSeleccionado : ''
      }`}
    >
      <div className={estilos.pasoCabecera}>
        <span className={estilos.pasoIndice} aria-hidden="true">
          {esInicio ? '▶' : indice || '·'}
        </span>
        <span className={estilos.pasoTipo}>{NOMBRES[nodo.tipo]}</span>
        {esInicio && <span className={estilos.pasoInicio}>empieza aquí</span>}
        <button className={estilos.borrar} onClick={alBorrar} title="Quitar este paso">
          <span aria-hidden="true">×</span>
          <span className="visually-hidden">Quitar el paso {nodo.id}</span>
        </button>
      </div>

      {nodo.tipo === 'mensaje' && (
        <>
          <textarea
            className={estilos.texto}
            value={nodo.texto}
            rows={2}
            aria-label="Texto del mensaje"
            onChange={(e) => alCambiar({ ...nodo, texto: e.target.value })}
          />
          <Enlace
            etiqueta="Luego"
            valor={nodo.siguiente}
            destinos={otros}
            alCambiar={(v) => alCambiar({ ...nodo, siguiente: v })}
          />
        </>
      )}

      {nodo.tipo === 'esperar_respuesta' && (
        <>
          <Espera
            segundos={nodo.segundos}
            alCambiar={(segundos) => alCambiar({ ...nodo, segundos })}
          />
          <Enlace
            etiqueta="Si responde"
            valor={nodo.siguiente}
            destinos={otros}
            alCambiar={(v) => alCambiar({ ...nodo, siguiente: v })}
          />
          <Enlace
            etiqueta="Si no responde"
            valor={nodo.alExpirar}
            destinos={otros}
            alCambiar={(v) => alCambiar({ ...nodo, alExpirar: v })}
          />
        </>
      )}

      {nodo.tipo === 'pausa' && (
        <>
          <Espera
            etiqueta="Calla durante"
            unidades={UNIDADES_DE_PAUSA}
            segundos={nodo.segundos}
            alCambiar={(segundos) => alCambiar({ ...nodo, segundos })}
          />
          <p className={estilos.pista}>
            Mientras calla no escucha: si el contacto escribe, la pausa sigue su curso.
          </p>
          <Enlace
            etiqueta="Luego"
            valor={nodo.siguiente}
            destinos={otros}
            alCambiar={(v) => alCambiar({ ...nodo, siguiente: v })}
          />
        </>
      )}

      {nodo.tipo === 'condicion' && (
        <>
          {nodo.casos.map((caso, i) => (
            <div key={i} className={estilos.caso}>
              <input
                className={estilos.palabras}
                value={caso.contiene.join(', ')}
                aria-label={`Palabras del caso ${i + 1}`}
                placeholder="sí, claro, me interesa"
                onChange={(e) => {
                  const casos = [...nodo.casos];
                  casos[i] = {
                    contiene: e.target.value
                      .split(',')
                      .map((p) => p.trim())
                      .filter(Boolean),
                    siguiente: caso.siguiente,
                  };
                  alCambiar({ ...nodo, casos });
                }}
              />
              <Enlace
                etiqueta="→"
                valor={caso.siguiente}
                destinos={otros}
                alCambiar={(v) => {
                  const casos = [...nodo.casos];
                  casos[i] = { contiene: caso.contiene, siguiente: v };
                  alCambiar({ ...nodo, casos });
                }}
              />
              <button
                className={estilos.borrarCaso}
                onClick={() => alCambiar({ ...nodo, casos: nodo.casos.filter((_, j) => j !== i) })}
                title="Quitar este caso"
              >
                <span aria-hidden="true">×</span>
                <span className="visually-hidden">Quitar el caso {i + 1}</span>
              </button>
            </div>
          ))}
          <button
            className={estilos.anadirCaso}
            onClick={() =>
              alCambiar({ ...nodo, casos: [...nodo.casos, { contiene: [], siguiente: null }] })
            }
          >
            Añadir caso
          </button>
          <Enlace
            etiqueta="Si no casa ninguno"
            valor={nodo.siNo}
            destinos={otros}
            alCambiar={(v) => alCambiar({ ...nodo, siNo: v })}
          />
        </>
      )}

      {nodo.tipo === 'etiquetar' && (
        <>
          <select
            className={estilos.select}
            value={nodo.etiquetaId}
            aria-label="Etiqueta"
            onChange={(e) => alCambiar({ ...nodo, etiquetaId: e.target.value })}
          >
            <option value="">Elige una etiqueta…</option>
            {etiquetas.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nombre}
              </option>
            ))}
          </select>
          <Enlace
            etiqueta="Luego"
            valor={nodo.siguiente}
            destinos={otros}
            alCambiar={(v) => alCambiar({ ...nodo, siguiente: v })}
          />
        </>
      )}

      {nodo.tipo === 'relevo' && (
        <>
          <input
            className={estilos.palabras}
            value={nodo.motivo}
            maxLength={120}
            aria-label="Por qué hace falta una persona"
            placeholder="Pide hablar con alguien"
            onChange={(e) => alCambiar({ ...nodo, motivo: e.target.value })}
          />
          <p className={estilos.pista}>
            Este motivo lo lee el agente en la bandeja antes de abrir la conversación. El bot
            termina aquí: lo que haya que hacer además —etiquetar, asignar— va antes.
          </p>
        </>
      )}

      {nodo.tipo === 'asignar' && (
        <>
          <select
            className={estilos.select}
            value={nodo.usuarioId}
            aria-label="Persona"
            onChange={(e) => alCambiar({ ...nodo, usuarioId: e.target.value })}
          >
            <option value="">Elige a quién…</option>
            {usuarios.map((u) => (
              <option key={u.id} value={u.id}>
                {u.nombre}
              </option>
            ))}
          </select>
          <Enlace
            etiqueta="Luego"
            valor={nodo.siguiente}
            destinos={otros}
            alCambiar={(v) => alCambiar({ ...nodo, siguiente: v })}
          />
        </>
      )}

      {nodo.tipo === 'fin' && (
        <label className={estilos.casilla}>
          <input
            type="checkbox"
            checked={nodo.cerrarConversacion ?? false}
            onChange={(e) => alCambiar({ ...nodo, cerrarConversacion: e.target.checked })}
          />
          Cerrar la conversación al terminar
        </label>
      )}

      {problemas.map((p, i) => (
        <p key={i} className={estilos.pasoAviso}>
          {p.mensaje}
        </p>
      ))}

      <div className={estilos.insertar}>
        <button
          className={estilos.insertarBoton}
          aria-expanded={abriendo}
          onClick={() => setAbriendo((v) => !v)}
        >
          + Paso aquí debajo
        </button>
        {abriendo && (
          <div className={estilos.menu} role="menu">
            {(Object.keys(NOMBRES) as Tipo[])
              .filter((t) => t !== 'fin')
              .map((t) => (
                <button
                  key={t}
                  role="menuitem"
                  className={estilos.menuItem}
                  onClick={() => {
                    alInsertar(t);
                    setAbriendo(false);
                  }}
                >
                  {NOMBRES[t]}
                </button>
              ))}
          </div>
        )}
      </div>
    </li>
  );
}

function Enlace({
  etiqueta,
  valor,
  destinos,
  alCambiar,
}: {
  etiqueta: string;
  valor: string | null;
  destinos: { id: string; etiqueta: string }[];
  alCambiar: (v: string | null) => void;
}) {
  return (
    <label className={estilos.enlace}>
      <span className={estilos.enlaceEtiqueta}>{etiqueta}</span>
      <select
        className={estilos.select}
        value={valor ?? ''}
        onChange={(e) => alCambiar(e.target.value || null)}
      >
        <option value="">Terminar</option>
        {destinos.map((d) => (
          <option key={d.id} value={d.id}>
            {d.etiqueta}
          </option>
        ))}
      </select>
    </label>
  );
}

function Espera({
  segundos,
  alCambiar,
  etiqueta = 'Espera hasta',
  unidades = UNIDADES,
}: {
  segundos: number;
  alCambiar: (segundos: number) => void;
  etiqueta?: string;
  unidades?: [string, number][];
}) {
  const unidad = unidades
    .slice()
    .reverse()
    .find(([, s]) => segundos % s === 0 && segundos >= s) ??
    unidades[0] ?? ['minutos', 60];
  const cantidad = Math.max(1, Math.round(segundos / (unidad[1] as number)));
  return (
    <div className={estilos.espera}>
      <span className={estilos.enlaceEtiqueta}>{etiqueta}</span>
      <input
        className={estilos.numero}
        type="number"
        min={1}
        value={cantidad}
        aria-label="Cantidad de espera"
        onChange={(e) => alCambiar(Math.max(1, Number(e.target.value)) * (unidad[1] as number))}
      />
      <select
        className={estilos.select}
        value={String(unidad[1])}
        aria-label="Unidad de espera"
        onChange={(e) => alCambiar(cantidad * Number(e.target.value))}
      >
        {unidades.map(([nombre, s]) => (
          <option key={s} value={s}>
            {nombre}
          </option>
        ))}
      </select>
    </div>
  );
}

const HORAS: [HorasActivasDeFlujo, string][] = [
  ['siempre', 'A cualquier hora'],
  ['solo_abierto', 'Solo en horario de atención'],
  ['solo_cerrado', 'Solo fuera de horario'],
];

function Disparadores({
  valor,
  horasActivas,
  horario,
  alCambiar,
  alCambiarHoras,
}: {
  valor: DisparadorDeFlujo[];
  horasActivas: HorasActivasDeFlujo;
  horario: HorarioDeAtencion | null;
  alCambiar: (d: DisparadorDeFlujo[]) => void;
  alCambiarHoras: (h: HorasActivasDeFlujo) => void;
}) {
  const porPalabra = valor.find((d) => d.tipo === 'palabra_clave');
  const alAbrir = valor.some((d) => d.tipo === 'conversacion_abierta');
  // Dos voces a la vez: el aviso automático de «estamos cerrados» y este bot
  // contestarían al MISMO mensaje de madrugada. Es un aviso y no un error
  // porque puede ser lo que se quiere; lo que no puede es pasar sin saberlo.
  const dosVoces = horario?.avisoActivo === true && horasActivas !== 'solo_abierto';
  return (
    <fieldset className={estilos.disparadores}>
      <legend className={estilos.disparadoresTitulo}>Cuándo arranca</legend>
      <label className={estilos.casilla}>
        <input
          type="checkbox"
          checked={alAbrir}
          onChange={(e) =>
            alCambiar(
              e.target.checked
                ? [...valor, { tipo: 'conversacion_abierta' }]
                : valor.filter((d) => d.tipo !== 'conversacion_abierta'),
            )
          }
        />
        Con el primer mensaje de una conversación nueva
      </label>
      <label className={estilos.casilla}>
        <input
          type="checkbox"
          checked={porPalabra !== undefined}
          onChange={(e) =>
            alCambiar(
              e.target.checked
                ? [...valor, { tipo: 'palabra_clave', palabras: [] }]
                : valor.filter((d) => d.tipo !== 'palabra_clave'),
            )
          }
        />
        Cuando escriban alguna de estas palabras
      </label>
      <label className={estilos.casilla}>
        Horas en que puede hablar
        <select
          className={estilos.select}
          value={horasActivas}
          onChange={(e) => alCambiarHoras(e.target.value as HorasActivasDeFlujo)}
        >
          {HORAS.map(([v, texto]) => (
            <option key={v} value={v}>
              {texto}
            </option>
          ))}
        </select>
      </label>
      {dosVoces && (
        <p className={estilos.pista}>
          El aviso automático de «estamos cerrados» está encendido. Fuera de horario, quien escriba
          recibirá ese aviso <strong>y</strong> a este bot: dos voces en el mismo mensaje. Ponlo en
          «Solo en horario de atención», o apaga el aviso en Ajustes → Horario.
        </p>
      )}
      {porPalabra && (
        <input
          className={estilos.palabras}
          value={(porPalabra.palabras ?? []).join(', ')}
          aria-label="Palabras que disparan el flujo"
          placeholder="precio, catálogo, horario"
          onChange={(e) =>
            alCambiar(
              valor.map((d) =>
                d.tipo === 'palabra_clave'
                  ? {
                      tipo: 'palabra_clave',
                      palabras: e.target.value
                        .split(',')
                        .map((p) => p.trim())
                        .filter(Boolean),
                    }
                  : d,
              ),
            )
          }
        />
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Operaciones sobre el grafo (puras, sin estado)
// ---------------------------------------------------------------------------

function resumenDeNodo(n: NodoDeFlujo): string {
  if (n.tipo === 'mensaje') return `«${n.texto.slice(0, 28)}${n.texto.length > 28 ? '…' : ''}»`;
  return NOMBRES[n.tipo];
}

function reemplazar(g: GrafoDeFlujo, nodo: NodoDeFlujo): GrafoDeFlujo {
  return { ...g, nodos: g.nodos.map((n) => (n.id === nodo.id ? nodo : n)) };
}

/**
 * Quitar un paso reengancha lo que apuntaba a él con lo que él apuntaba: si no,
 * cada borrado dejaría el flujo partido en dos y con avisos por todas partes.
 */
function borrar(g: GrafoDeFlujo, id: string): GrafoDeFlujo {
  const fuera = g.nodos.find((n) => n.id === id);
  const heredero = fuera && 'siguiente' in fuera ? (fuera.siguiente ?? null) : null;
  const repuntar = (destino: string | null) => (destino === id ? heredero : destino);
  const nodos = g.nodos
    .filter((n) => n.id !== id)
    .map((n): NodoDeFlujo => {
      if (n.tipo === 'condicion') {
        return {
          ...n,
          casos: n.casos.map((c) => ({ ...c, siguiente: repuntar(c.siguiente) })),
          siNo: repuntar(n.siNo),
        };
      }
      if (n.tipo === 'esperar_respuesta') {
        return { ...n, siguiente: repuntar(n.siguiente), alExpirar: repuntar(n.alExpirar) };
      }
      if (n.tipo === 'fin' || n.tipo === 'relevo') return n;
      return { ...n, siguiente: repuntar(n.siguiente) };
    });
  const inicio = g.inicio === id ? (heredero ?? nodos[0]?.id ?? '') : g.inicio;
  return { inicio, nodos };
}

/** Inserta un paso ENTRE uno y su siguiente: el gesto natural y sin huérfanos. */
function insertar(g: GrafoDeFlujo, despuesDe: string, tipo: Tipo): GrafoDeFlujo {
  const anterior = g.nodos.find((n) => n.id === despuesDe);
  const destino = anterior && 'siguiente' in anterior ? (anterior.siguiente ?? null) : null;
  const id = nuevoId(g);
  const nuevo = crearNodo(id, tipo, destino);
  const nodos = g.nodos.map((n) =>
    n.id === despuesDe && 'siguiente' in n ? ({ ...n, siguiente: id } as NodoDeFlujo) : n,
  );
  return { ...g, nodos: [...nodos, nuevo] };
}

function nuevoId(g: GrafoDeFlujo): string {
  for (let i = g.nodos.length + 1; ; i++) {
    const id = `paso${i}`;
    if (!g.nodos.some((n) => n.id === id)) return id;
  }
}

function crearNodo(id: string, tipo: Tipo, siguiente: string | null): NodoDeFlujo {
  switch (tipo) {
    case 'mensaje':
      return { id, tipo, texto: '', siguiente };
    case 'esperar_respuesta':
      return { id, tipo, segundos: 3600, siguiente, alExpirar: siguiente };
    case 'pausa':
      return { id, tipo, segundos: 5, siguiente };
    case 'condicion':
      return { id, tipo, casos: [{ contiene: [], siguiente }], siNo: siguiente };
    case 'etiquetar':
      return { id, tipo, etiquetaId: '', siguiente };
    case 'asignar':
      return { id, tipo, usuarioId: '', siguiente };
    case 'relevo':
      return { id, tipo, motivo: '' };
    case 'fin':
      return { id, tipo };
  }
}

/**
 * Orden de lectura: recorrido desde el inicio siguiendo los enlaces. El camino
 * principal queda de arriba abajo y lo que no se alcanza cae aparte, donde se
 * ve que sobra.
 */
function ordenar(g: GrafoDeFlujo): { camino: NodoDeFlujo[]; sueltos: NodoDeFlujo[] } {
  const porId = new Map(g.nodos.map((n) => [n.id, n]));
  const vistos = new Set<string>();
  const camino: NodoDeFlujo[] = [];
  const cola = [g.inicio];
  while (cola.length) {
    const id = cola.shift()!;
    if (vistos.has(id)) continue;
    const n = porId.get(id);
    if (!n) continue;
    vistos.add(id);
    camino.push(n);
    for (const s of salidas(n)) if (s) cola.push(s);
  }
  return { camino, sueltos: g.nodos.filter((n) => !vistos.has(n.id)) };
}

function salidas(n: NodoDeFlujo): (string | null)[] {
  if (n.tipo === 'condicion') return [...n.casos.map((c) => c.siguiente), n.siNo];
  if (n.tipo === 'esperar_respuesta') return [n.siguiente, n.alExpirar];
  if (n.tipo === 'fin' || n.tipo === 'relevo') return [];
  return [n.siguiente];
}

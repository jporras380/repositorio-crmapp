import { useMemo } from 'react';
import type { GrafoDeFlujo, NodoDeFlujo } from '../../api/tipos.ts';
import estilos from './MapaDelFlujo.module.css';

interface Props {
  grafo: GrafoDeFlujo;
  seleccionado: string | null;
  alSeleccionar: (id: string) => void;
  /**
   * Miniatura: el mapa se escala para caber entero en vez de desplazarse. En
   * una tarjeta de la galería, una barra de desplazamiento que además no se
   * puede usar es solo un mapa cortado.
   */
  ajustado?: boolean;
}

const ANCHO = 168;
const ALTO = 58;
const HUECO_X = 76;
const HUECO_Y = 18;
const MARGEN = 16;

const NOMBRES: Record<NodoDeFlujo['tipo'], string> = {
  mensaje: 'Mensaje',
  esperar_respuesta: 'Espera',
  condicion: 'Condición',
  etiquetar: 'Etiqueta',
  asignar: 'Asignar',
  fin: 'Fin',
};

interface Caja {
  id: string;
  nodo: NodoDeFlujo;
  x: number;
  y: number;
  suelto: boolean;
}

interface Arista {
  desde: string;
  hasta: string;
  etiqueta: string | null;
}

/**
 * Mapa del flujo: la forma completa, de un vistazo.
 *
 * **No se arrastra y no guarda posiciones.** La disposición se calcula
 * recorriendo el grafo desde el inicio, en capas de izquierda a derecha. Esa
 * es toda la diferencia con un lienzo tipo Kommo, y es deliberada: colocar
 * cajas a mano obligaría a guardar coordenadas dentro del grafo —que ya está
 * en producción, con ejecuciones vivas apuntando a versiones concretas— y a
 * mantener zoom, colisiones y enrutado de aristas para siempre. Lo que aporta
 * un lienzo es ver la forma; eso se consigue calculándola.
 *
 * El mapa NO edita: selecciona. Al pulsar un paso, se edita abajo, en su
 * tarjeta, donde ya funciona.
 */
export function MapaDelFlujo({ grafo, seleccionado, alSeleccionar, ajustado = false }: Props) {
  const { cajas, aristas, ancho, alto } = useMemo(() => disponer(grafo), [grafo]);

  return (
    <div
      className={`${estilos.marco} ${ajustado ? estilos.marcoAjustado : ''}`}
      // La altura se pasa como dato porque ya la sabemos: dejársela a la
      // rejilla no funciona — una fila `auto` con un contenedor que
      // desplaza no toma la altura del contenido y el mapa sale aplastado a
      // diez píxeles. Es lo mismo que se hace con el ancho de las barras del
      // panel: el número es dato, el estilo sigue en el CSS.
      ref={(n) => n?.style.setProperty('--alto-mapa', `${alto}px`)}
    >
      <svg
        className={estilos.lienzo}
        {...(ajustado ? {} : { width: ancho, height: alto })}
        viewBox={`0 0 ${ancho} ${alto}`}
        preserveAspectRatio="xMinYMin meet"
        role="img"
        aria-label="Mapa del flujo"
      >
        <defs>
          <marker
            id="punta"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L8 4 L0 8 z" className={estilos.punta} />
          </marker>
        </defs>

        {aristas.map((a, i) => {
          const desde = cajas.find((c) => c.id === a.desde);
          const hasta = cajas.find((c) => c.id === a.hasta);
          if (!desde || !hasta) return null;
          const { d, mx, my } = trazo(desde, hasta);
          return (
            <g key={i} className={estilos.arista}>
              <path d={d} markerEnd="url(#punta)" className={estilos.linea} />
              {a.etiqueta && (
                <text x={mx} y={my} className={estilos.etiquetaArista} textAnchor="middle">
                  {a.etiqueta}
                </text>
              )}
            </g>
          );
        })}

        {cajas.map((c) => (
          <g
            key={c.id}
            className={`${estilos.caja} ${estilos[`tipo_${c.nodo.tipo}`] ?? ''} ${
              c.id === seleccionado ? estilos.cajaActiva : ''
            } ${c.suelto ? estilos.cajaSuelta : ''}`}
            transform={`translate(${c.x} ${c.y})`}
            role="button"
            tabIndex={0}
            aria-label={`${NOMBRES[c.nodo.tipo]}: ${resumen(c.nodo)}`}
            aria-pressed={c.id === seleccionado}
            onClick={() => alSeleccionar(c.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                alSeleccionar(c.id);
              }
            }}
          >
            <rect width={ANCHO} height={ALTO} rx="12" className={estilos.cajaFondo} />
            <rect width="4" height={ALTO} rx="2" className={estilos.cajaFranja} />
            <text x="16" y="22" className={estilos.cajaTipo}>
              {NOMBRES[c.nodo.tipo]}
              {c.id === grafo.inicio ? ' · empieza' : ''}
            </text>
            <text x="16" y="40" className={estilos.cajaResumen}>
              {recortar(resumen(c.nodo), 24)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Disposición
// ---------------------------------------------------------------------------

/**
 * Capas por recorrido en anchura: la distancia al inicio decide la columna, y
 * el orden de aparición decide la fila. Lo que no se alcanza va a una columna
 * final, apagada — donde se ve que sobra.
 */
function disponer(grafo: GrafoDeFlujo): {
  cajas: Caja[];
  aristas: Arista[];
  ancho: number;
  alto: number;
} {
  const porId = new Map(grafo.nodos.map((n) => [n.id, n]));
  const nivel = new Map<string, number>();
  const cola: string[] = [grafo.inicio];
  nivel.set(grafo.inicio, 0);
  while (cola.length) {
    const id = cola.shift()!;
    const n = porId.get(id);
    if (!n) continue;
    for (const { hasta } of salidas(n)) {
      if (!hasta || nivel.has(hasta) || !porId.has(hasta)) continue;
      nivel.set(hasta, (nivel.get(id) ?? 0) + 1);
      cola.push(hasta);
    }
  }

  const maxNivel = Math.max(0, ...nivel.values());
  const sueltos = grafo.nodos.filter((n) => !nivel.has(n.id));
  for (const n of sueltos) nivel.set(n.id, maxNivel + 1);

  const enFila = new Map<number, number>();
  const cajas: Caja[] = [];
  // El orden de `grafo.nodos` decide el reparto dentro de la columna: estable
  // entre repintados, que es lo que evita que el mapa «baile» al escribir.
  for (const n of grafo.nodos) {
    const col = nivel.get(n.id) ?? 0;
    const fila = enFila.get(col) ?? 0;
    enFila.set(col, fila + 1);
    cajas.push({
      id: n.id,
      nodo: n,
      x: MARGEN + col * (ANCHO + HUECO_X),
      y: MARGEN + fila * (ALTO + HUECO_Y),
      suelto: sueltos.some((s) => s.id === n.id),
    });
  }

  const aristas: Arista[] = [];
  for (const n of grafo.nodos) {
    for (const s of salidas(n)) {
      if (s.hasta && porId.has(s.hasta)) {
        aristas.push({ desde: n.id, hasta: s.hasta, etiqueta: s.etiqueta });
      }
    }
  }

  const columnas = Math.max(...[...nivel.values()], 0) + 1;
  const filas = Math.max(...[...enFila.values()], 1);
  return {
    cajas,
    aristas,
    ancho: MARGEN * 2 + columnas * ANCHO + (columnas - 1) * HUECO_X,
    alto: MARGEN * 2 + filas * ALTO + (filas - 1) * HUECO_Y,
  };
}

/** Curva de una caja a otra. Hacia atrás se dibuja por debajo, o se cruzaría todo. */
function trazo(a: Caja, b: Caja): { d: string; mx: number; my: number } {
  const haciaDelante = b.x > a.x;
  if (haciaDelante) {
    const x1 = a.x + ANCHO;
    const y1 = a.y + ALTO / 2;
    const x2 = b.x;
    const y2 = b.y + ALTO / 2;
    const dx = Math.max(28, (x2 - x1) / 2);
    return {
      d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
      mx: (x1 + x2) / 2,
      my: (y1 + y2) / 2 - 6,
    };
  }
  // Vuelta atrás (un recordatorio que reengancha): sale por abajo y entra por abajo.
  const x1 = a.x + ANCHO / 2;
  const y1 = a.y + ALTO;
  const x2 = b.x + ANCHO / 2;
  const y2 = b.y + ALTO;
  const caida = 28;
  return {
    d: `M ${x1} ${y1} C ${x1} ${y1 + caida}, ${x2} ${y2 + caida}, ${x2} ${y2}`,
    mx: (x1 + x2) / 2,
    my: Math.max(y1, y2) + caida - 2,
  };
}

function salidas(n: NodoDeFlujo): { hasta: string | null; etiqueta: string | null }[] {
  switch (n.tipo) {
    case 'mensaje':
    case 'etiquetar':
    case 'asignar':
      return [{ hasta: n.siguiente, etiqueta: null }];
    case 'esperar_respuesta':
      return [
        { hasta: n.siguiente, etiqueta: 'responde' },
        { hasta: n.alExpirar, etiqueta: 'no responde' },
      ];
    case 'condicion':
      return [
        ...n.casos.map((c) => ({
          hasta: c.siguiente,
          etiqueta: recortar(c.contiene.join(', ') || 'sin palabras', 14),
        })),
        { hasta: n.siNo, etiqueta: 'si no' },
      ];
    case 'fin':
      return [];
  }
}

function resumen(n: NodoDeFlujo): string {
  switch (n.tipo) {
    case 'mensaje':
      return n.texto || 'sin texto';
    case 'esperar_respuesta':
      return n.segundos >= 86_400
        ? `hasta ${Math.round(n.segundos / 86_400)} día(s)`
        : n.segundos >= 3600
          ? `hasta ${Math.round(n.segundos / 3600)} h`
          : `hasta ${Math.round(n.segundos / 60)} min`;
    case 'condicion':
      return `${n.casos.length} caso(s)`;
    case 'etiquetar':
      return n.etiquetaId ? 'etiqueta elegida' : 'sin elegir';
    case 'asignar':
      return n.usuarioId ? 'persona elegida' : 'sin elegir';
    case 'fin':
      return n.cerrarConversacion ? 'y cierra' : 'termina';
  }
}

function recortar(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

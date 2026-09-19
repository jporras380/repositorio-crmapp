import { useMemo, useState } from 'react';

/**
 * Buscar, filtrar por fecha, contar y paginar una lista que ya está en memoria.
 *
 * Lo usan Respuestas rápidas y Etiquetas, que tienen exactamente la misma
 * necesidad. Escribirlo dos veces habría garantizado que se separaran: el día
 * que se afine el buscador en una, la otra se queda como estaba.
 *
 * ## Por qué en el navegador y no en el servidor
 *
 * Estas dos listas ya llegan enteras en una sola petición —así estaba antes de
 * esto y no lo empeora— y tienen decenas de elementos, no millones. Filtrar
 * aquí responde a cada tecla sin ir y volver por la red, que es lo que hace
 * que un buscador se sienta vivo.
 *
 * **Dónde deja de valer**: cuando una cuenta pase de unos pocos cientos. A
 * partir de ahí, traerlo todo para enseñar veinte es tirar datos y batería, y
 * toca mover el filtro y la paginación a la API. Queda escrito aquí para que
 * el día que pase se sepa qué hacer, en vez de descubrirlo por una pantalla
 * lenta.
 *
 * ## Qué hace «inteligente» al buscador
 *
 * Tres cosas, y ninguna es magia:
 *
 * 1. **Ignora tildes y mayúsculas**: «cotizacion» encuentra «Cotización». Nadie
 *    escribe tildes en un buscador. La «ñ» se pliega a «n» de paso —«nino»
 *    encuentra «niño»—; en español es una letra propia, pero esto busca, no
 *    corrige, y ensanchar lo que se encuentra no le quita una fila a nadie.
 * 2. **Busca por partes sueltas**: «pago pend» encuentra «Pago pendiente»
 *    aunque las palabras no estén juntas ni en ese orden.
 * 3. **Mira todos los campos** que se le digan —atajo, título y texto—, no solo
 *    el nombre. Quien busca «Trujillo» se acuerda del contenido, no del atajo.
 */

/** Sin tildes y en minúsculas: como lo teclea una persona con prisa. */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * ¿Coincide con lo buscado?
 *
 * Cada trozo de la búsqueda tiene que aparecer en ALGUNO de los campos. Que
 * todos los trozos estén es lo que deja afinar añadiendo palabras; que baste
 * un campo cualquiera es lo que deja buscar por texto sin recordar el atajo.
 */
export function coincide(campos: string[], busqueda: string): boolean {
  const trozos = normalizar(busqueda).split(/\s+/).filter(Boolean);
  if (trozos.length === 0) return true;
  const heno = campos.map(normalizar);
  return trozos.every((t) => heno.some((campo) => campo.includes(t)));
}

export interface RangoDeFechas {
  desde: string;
  hasta: string;
}

export const SIN_RANGO: RangoDeFechas = { desde: '', hasta: '' };

/**
 * ¿Cae la fecha dentro del rango?
 *
 * Los extremos son días (`YYYY-MM-DD`) y los dos están INCLUIDOS: quien pone
 * «hasta el 18» espera que salga lo del 18, no lo anterior a su medianoche.
 * Se compara en la zona del navegador, que es donde está mirando la persona.
 */
export function dentroDelRango(fechaIso: string, rango: RangoDeFechas): boolean {
  if (!rango.desde && !rango.hasta) return true;
  const d = new Date(fechaIso);
  if (Number.isNaN(d.getTime())) return true;
  const dia = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
  if (rango.desde && dia < rango.desde) return false;
  if (rango.hasta && dia > rango.hasta) return false;
  return true;
}

/** A partir de aquí la lista se parte en páginas. */
export const POR_PAGINA = 20;

export interface ListaFiltrada<T> {
  /** Lo que toca pintar ahora mismo. */
  visibles: T[];
  /** Cuántos hay en total, sin filtrar: el denominador del contador. */
  total: number;
  /** Cuántos pasan el filtro. */
  encontrados: number;
  pagina: number;
  paginas: number;
  irAPagina: (n: number) => void;
  busqueda: string;
  setBusqueda: (v: string) => void;
  rango: RangoDeFechas;
  setRango: (r: RangoDeFechas) => void;
  /** Hay algo puesto: sirve para ofrecer «quitar filtros». */
  filtrando: boolean;
  limpiar: () => void;
}

export function useListaFiltrable<T>(
  items: T[] | null,
  camposDe: (item: T) => string[],
  fechaDe: (item: T) => string,
): ListaFiltrada<T> {
  const [busqueda, setBusquedaCruda] = useState('');
  const [rango, setRangoCrudo] = useState<RangoDeFechas>(SIN_RANGO);
  const [pagina, setPagina] = useState(1);

  const todos = useMemo(() => items ?? [], [items]);

  const encontrados = useMemo(
    () => todos.filter((i) => coincide(camposDe(i), busqueda) && dentroDelRango(fechaDe(i), rango)),
    // `camposDe` y `fechaDe` se declaran en el cuerpo del componente y cambian
    // de identidad en cada pintada; incluirlas recalcularía siempre. Lo que
    // importa es que dependan solo de su argumento, y dependen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [todos, busqueda, rango],
  );

  const paginas = Math.max(1, Math.ceil(encontrados.length / POR_PAGINA));
  // Si el filtro deja menos páginas de las que había, la página actual podría
  // quedar fuera y la lista saldría vacía sin explicar por qué.
  const paginaSegura = Math.min(pagina, paginas);
  const visibles = encontrados.slice((paginaSegura - 1) * POR_PAGINA, paginaSegura * POR_PAGINA);

  // Cambiar el filtro vuelve a la primera página: quedarse en la cuarta de una
  // búsqueda anterior es la forma más rápida de pensar que no hay resultados.
  const setBusqueda = (v: string) => {
    setBusquedaCruda(v);
    setPagina(1);
  };
  const setRango = (r: RangoDeFechas) => {
    setRangoCrudo(r);
    setPagina(1);
  };

  return {
    visibles,
    total: todos.length,
    encontrados: encontrados.length,
    pagina: paginaSegura,
    paginas,
    irAPagina: setPagina,
    busqueda,
    setBusqueda,
    rango,
    setRango,
    filtrando: busqueda.trim() !== '' || rango.desde !== '' || rango.hasta !== '',
    limpiar: () => {
      setBusquedaCruda('');
      setRangoCrudo(SIN_RANGO);
      setPagina(1);
    },
  };
}

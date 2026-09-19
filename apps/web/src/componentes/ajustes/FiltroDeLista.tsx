import type { ListaFiltrada } from '../../vista/listaFiltrable.ts';
import estilos from './FiltroDeLista.module.css';

/**
 * La barra de buscar y filtrar, y el contador con la paginación de debajo.
 *
 * Es la cara del hook `useListaFiltrable`. Van juntos a propósito: quien use
 * uno querrá el otro, y tenerlos separados invita a que una pantalla acabe
 * con buscador y sin contador.
 *
 * ## Por qué el contador dice dos números
 *
 * «12 de 47» responde a las dos preguntas a la vez: cuántas hay en total y
 * cuántas ha dejado el filtro. Un solo número obliga a quitar el filtro para
 * saber si la lista entera es pequeña o es la búsqueda la que corta.
 */

/**
 * Cómo se llama lo que hay en la lista, en singular y en plural.
 *
 * Dos palabras y no una porque «1 respuestas» canta, y en esta misma pantalla
 * las filas ya dicen «1 conversación» bien: quedarse corto aquí se nota más.
 */
export interface Nombre {
  uno: string;
  varios: string;
}

const contar = (n: number, nombre: Nombre) => `${n} ${n === 1 ? nombre.uno : nombre.varios}`;

export function BarraDeFiltro({
  lista,
  nombre,
  ejemplo,
}: {
  lista: ListaFiltrada<unknown>;
  nombre: Nombre;
  /** Un ejemplo real de esta pantalla, no «buscar…». */
  ejemplo: string;
}) {
  return (
    <div className={estilos.barra}>
      <label className={estilos.buscador}>
        <span className="visually-hidden">Buscar {nombre.varios}</span>
        <input
          type="search"
          className={estilos.entrada}
          placeholder={ejemplo}
          value={lista.busqueda}
          onChange={(e) => lista.setBusqueda(e.target.value)}
        />
      </label>

      <div className={estilos.fechas}>
        <label className={estilos.fecha}>
          <span className={estilos.etiquetaFecha}>Desde</span>
          <input
            type="date"
            className={estilos.entradaFecha}
            value={lista.rango.desde}
            /* No deja elegir un «desde» posterior al «hasta»: un rango vacío
               no se distingue de «no hay nada» hasta que uno mira las fechas. */
            max={lista.rango.hasta || undefined}
            onChange={(e) => lista.setRango({ ...lista.rango, desde: e.target.value })}
          />
        </label>
        <label className={estilos.fecha}>
          <span className={estilos.etiquetaFecha}>Hasta</span>
          <input
            type="date"
            className={estilos.entradaFecha}
            value={lista.rango.hasta}
            min={lista.rango.desde || undefined}
            onChange={(e) => lista.setRango({ ...lista.rango, hasta: e.target.value })}
          />
        </label>
      </div>

      {lista.filtrando && (
        <button type="button" className={estilos.limpiar} onClick={lista.limpiar}>
          Quitar filtros
        </button>
      )}
    </div>
  );
}

export function ContadorYPaginas({
  lista,
  nombre,
}: {
  lista: ListaFiltrada<unknown>;
  nombre: Nombre;
}) {
  const { encontrados, total, pagina, paginas, filtrando } = lista;

  return (
    <div className={estilos.pie}>
      <p className={estilos.contador} role="status">
        {/* Con filtro, el nombre concuerda con el TOTAL —«1 de 2 respuestas»—,
            que es el sustantivo del que se está sacando una parte. */}
        {filtrando ? `${encontrados} de ${contar(total, nombre)}` : contar(total, nombre)}
        {paginas > 1 && ` · página ${pagina} de ${paginas}`}
      </p>

      {/* La paginación solo aparece cuando hay más de una página: un «1 de 1»
          con dos flechas apagadas es ruido en la pantalla de una cuenta
          pequeña, que son casi todas. */}
      {paginas > 1 && (
        <nav className={estilos.paginas} aria-label={`Páginas de ${nombre.varios}`}>
          <button
            type="button"
            className={estilos.paso}
            disabled={pagina === 1}
            onClick={() => lista.irAPagina(pagina - 1)}
          >
            Anterior
          </button>
          <button
            type="button"
            className={estilos.paso}
            disabled={pagina === paginas}
            onClick={() => lista.irAPagina(pagina + 1)}
          >
            Siguiente
          </button>
        </nav>
      )}
    </div>
  );
}

/**
 * Órdenes sobre el catálogo del clúster, que es de TODOS los procesos.
 *
 * `ALTER ROLE` no toca una base de datos: toca `pg_authid`, que es un catálogo
 * compartido por el clúster entero. Dos procesos que lo cambien a la vez —y en
 * CI eso pasa, porque las suites de varios paquetes arrancan en paralelo y cada
 * una pone la contraseña de los roles de desarrollo— chocan con
 * `tuple concurrently updated`.
 *
 * No es un error de permisos ni de sintaxis: es PostgreSQL diciendo «alguien
 * acaba de modificar esta fila mientras yo la modificaba». Reintentar es la
 * respuesta correcta, porque la orden es idempotente: poner dos veces la misma
 * contraseña deja lo mismo.
 *
 * ## Por qué no un bloqueo consultivo
 *
 * `pg_advisory_lock` es **por base de datos**, y aquí cada suite trabaja en la
 * suya. Serializarlas obligaría a abrir una conexión extra a una base común
 * solo para el candado. Reintentar cuesta menos y no añade un sitio nuevo
 * donde quedarse colgado.
 */

/** Lo que dice PostgreSQL cuando dos procesos pisan la misma fila de catálogo. */
const CHOQUE = 'tuple concurrently updated';

/**
 * Ejecuta la orden y la repite si otro proceso la pisó.
 *
 * La espera crece un poco en cada intento: si dos arrancan a la vez, repetir al
 * instante vuelve a chocar. Con cinco intentos se cubre de sobra el número de
 * suites que corren en paralelo hoy; si un día se quedara corto, el error sale
 * tal cual y dice exactamente qué pasó.
 */
export async function reintentandoSiChocaElCatalogo<T>(
  orden: () => Promise<T>,
  intentos = 5,
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await orden();
    } catch (e) {
      const mensaje = e instanceof Error ? e.message : String(e);
      if (i >= intentos || !mensaje.includes(CHOQUE)) throw e;
      await new Promise((r) => setTimeout(r, 50 * i));
    }
  }
}

/**
 * Cómo se ve la aplicación: tema y cuánto vidrio.
 *
 * ## Por qué esto NO va en el servidor
 *
 * Es una preferencia del **aparato**, no de la persona. La misma recepcionista
 * usa el PC del mostrador —pantalla vieja, hall con ventanal, sol de Barranca
 * a las tres de la tarde— y su móvil por la noche. Guardarlo en su cuenta le
 * impondría en uno lo que eligió en el otro. Va en el navegador, que es donde
 * está el problema que resuelve.
 *
 * Consecuencia aceptada: cambiar de ordenador vuelve a empezar de cero. Es
 * barato de rehacer —dos clics— y nadie pierde nada si se pierde.
 *
 * ## Por qué el vidrio se puede apagar
 *
 * El aspecto de vidrio **cuesta contraste**: un fondo semitransparente deja
 * pasar lo que hay detrás, y lo que hay detrás son manchas de color. Con una
 * pantalla con reflejos, o para alguien que ya fuerza la vista, eso no es
 * elegante, es un estorbo. Quien mira esto ocho horas seguidas tiene derecho a
 * apagarlo, y quien lo quiere más aéreo, a subirlo.
 *
 * El sistema operativo ya puede pedir «menos transparencia»
 * (`prefers-reduced-transparency`), y eso se sigue respetando: aquí se elige
 * por encima de eso, no en contra.
 */

export const TEMAS = ['auto', 'claro', 'oscuro'] as const;
export const VIDRIOS = ['solido', 'vidrio', 'cristal'] as const;

export type Tema = (typeof TEMAS)[number];
export type Vidrio = (typeof VIDRIOS)[number];

export interface Apariencia {
  tema: Tema;
  vidrio: Vidrio;
}

/** Lo de siempre: el tema del sistema y el vidrio que ya tenía la aplicación. */
export const POR_DEFECTO: Apariencia = { tema: 'auto', vidrio: 'vidrio' };

const CLAVE = 'crmapp.apariencia';

/**
 * Lee la preferencia guardada.
 *
 * Todo lo que venga de `localStorage` es de fuera: puede faltar, estar a medias
 * o traer basura de una versión anterior. Cualquier cosa rara vuelve a lo de
 * siempre en vez de dejar la pantalla ilegible.
 */
export function leerApariencia(): Apariencia {
  try {
    const crudo = localStorage.getItem(CLAVE);
    if (!crudo) return POR_DEFECTO;
    const v = JSON.parse(crudo) as Partial<Apariencia>;
    return {
      tema: TEMAS.includes(v.tema as Tema) ? (v.tema as Tema) : POR_DEFECTO.tema,
      vidrio: VIDRIOS.includes(v.vidrio as Vidrio) ? (v.vidrio as Vidrio) : POR_DEFECTO.vidrio,
    };
  } catch {
    // Navegación privada, almacenamiento bloqueado, JSON roto: da igual cuál.
    return POR_DEFECTO;
  }
}

/**
 * La escribe en el documento.
 *
 * Los dos atributos van en `<html>` y los recoge `tokens.css`. Que el CSS
 * decida qué significa cada nivel —y no este archivo— es lo que permite
 * afinarlo sin tocar TypeScript.
 *
 * **Lo que está por defecto no escribe atributo**, y eso importa: mientras no
 * haya atributo, manda lo que pida el sistema operativo (`prefers-color-scheme`
 * y `prefers-reduced-transparency`). En cuanto alguien elige, su elección pesa
 * más, que es lo que se espera de un ajuste que uno ha tocado a propósito.
 */
export function aplicarApariencia(a: Apariencia): void {
  const raiz = document.documentElement;
  if (a.tema === 'auto') raiz.removeAttribute('data-theme');
  else raiz.setAttribute('data-theme', a.tema === 'claro' ? 'light' : 'dark');
  if (a.vidrio === POR_DEFECTO.vidrio) raiz.removeAttribute('data-vidrio');
  else raiz.setAttribute('data-vidrio', a.vidrio);
}

/** Si el sistema pide menos transparencia. Sirve para avisar, no para decidir. */
export function sistemaPideMenosTransparencia(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-transparency: reduce)').matches;
  } catch {
    return false;
  }
}

/** La guarda y la aplica. Si no se puede guardar, al menos se ve aplicada. */
export function guardarApariencia(a: Apariencia): void {
  aplicarApariencia(a);
  try {
    localStorage.setItem(CLAVE, JSON.stringify(a));
  } catch {
    // Sin almacenamiento el cambio dura lo que dure la pestaña. Es peor que
    // guardarlo, y mucho mejor que no dejar cambiarlo.
  }
}

/**
 * Se llama antes de pintar nada.
 *
 * Si se aplicara dentro de un componente, la primera imagen sería la del tema
 * por defecto y cambiaría a la vista: el parpadeo blanco que hace daño de
 * noche.
 */
export function arrancarApariencia(): void {
  aplicarApariencia(leerApariencia());
}

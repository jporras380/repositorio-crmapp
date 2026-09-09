/**
 * Anchos y plegado de los paneles de la bandeja.
 *
 * La decisión de producto: el reparto del espacio es del agente, no nuestro.
 * Quien atiende comentarios cortos quiere la lista ancha; quien negocia por
 * mensajes largos quiere el hilo entero y la ficha cerrada. Se guarda en el
 * navegador y no en el servidor a propósito: es una preferencia del puesto de
 * trabajo —un portátil de 13" y un monitor de 27" piden repartos distintos— y
 * llevarla al servidor obligaría a una tabla, una ruta y una migración para
 * algo que ni siquiera es igual en las dos pantallas de la misma persona.
 * El día que haya que sincronizarla entre dispositivos, este módulo es el
 * único sitio donde tocar.
 */

export interface EstadoDePaneles {
  /** Ancho en píxeles del panel de la lista. */
  anchoLista: number;
  /** Ancho en píxeles de la ficha del contacto. */
  anchoFicha: number;
  listaAbierta: boolean;
  fichaAbierta: boolean;
}

export interface Limites {
  min: number;
  max: number;
  /** Ancho al que vuelve un doble clic en el separador. */
  por: number;
}

/**
 * Los mínimos no son estéticos: por debajo de 232 px la fila de la lista
 * pierde la vista previa y por debajo de 248 px la ficha parte los botones de
 * estado en dos líneas. El máximo evita que un tirón deje el hilo sin sitio.
 */
export const LIMITES: { lista: Limites; ficha: Limites } = {
  lista: { min: 232, max: 520, por: 336 },
  ficha: { min: 248, max: 460, por: 304 },
};

export const POR_DEFECTO: EstadoDePaneles = {
  anchoLista: LIMITES.lista.por,
  anchoFicha: LIMITES.ficha.por,
  listaAbierta: true,
  fichaAbierta: true,
};

const CLAVE = 'crmapp.paneles.v1';

/** Encaja un ancho dentro de sus límites. Un NaN vuelve al valor por defecto. */
export function acotar(valor: number, l: Limites): number {
  if (!Number.isFinite(valor)) return l.por;
  return Math.min(l.max, Math.max(l.min, Math.round(valor)));
}

/**
 * Lee la preferencia guardada. Todo lo que venga mal —otra versión, un valor
 * fuera de rango, JSON roto— cae al valor por defecto en vez de romper la
 * bandeja: es una preferencia, no un dato.
 */
export function leerPaneles(): EstadoDePaneles {
  try {
    const crudo = localStorage.getItem(CLAVE);
    if (!crudo) return POR_DEFECTO;
    const g = JSON.parse(crudo) as Partial<EstadoDePaneles>;
    return {
      anchoLista: acotar(Number(g.anchoLista), LIMITES.lista),
      anchoFicha: acotar(Number(g.anchoFicha), LIMITES.ficha),
      listaAbierta: g.listaAbierta !== false,
      fichaAbierta: g.fichaAbierta !== false,
    };
  } catch {
    return POR_DEFECTO;
  }
}

export function guardarPaneles(e: EstadoDePaneles): void {
  try {
    localStorage.setItem(CLAVE, JSON.stringify(e));
  } catch {
    // Modo privado o almacenamiento lleno: la sesión sigue, sin recordar.
  }
}

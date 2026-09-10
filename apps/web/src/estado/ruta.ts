import { useEffect, useState } from 'react';

export type Ruta =
  | { pantalla: 'panel' }
  | {
      pantalla: 'bandeja';
      conversacionId: string | null;
      /** Vista con la que abrir la lista (la usan los enlaces del panel). */
      vista?: 'sinRespuesta' | undefined;
    }
  | { pantalla: 'ajustes'; seccion: 'canales' | 'plantillas' | 'respuestas' | 'uso' }
  /** Constructor de Salesbots. Sin flujo elegido, la lista. */
  | { pantalla: 'flujos'; flujoId: string | null };

const SECCIONES = new Set(['canales', 'plantillas', 'respuestas', 'uso']);

/**
 * Enrutado por hash, a mano: `#c=<id>` abre una conversación y
 * `#ajustes/<seccion>` una sección de ajustes. Dos pantallas no justifican
 * una dependencia; el día que haya URLs con parámetros anidados, sí.
 */
export function leerRuta(hash: string = location.hash): Ruta {
  if (hash.startsWith('#panel')) return { pantalla: 'panel' };
  if (hash.startsWith('#bandeja')) {
    const vista = hash.split('/')[1];
    return {
      pantalla: 'bandeja',
      conversacionId: null,
      ...(vista === 'sinRespuesta' ? { vista: 'sinRespuesta' as const } : {}),
    };
  }
  if (hash.startsWith('#flujos')) {
    return { pantalla: 'flujos', flujoId: hash.split('/')[1] ?? null };
  }
  if (hash.startsWith('#ajustes')) {
    const seccion = hash.split('/')[1] ?? 'canales';
    return {
      pantalla: 'ajustes',
      seccion: (SECCIONES.has(seccion) ? seccion : 'canales') as never,
    };
  }
  return { pantalla: 'bandeja', conversacionId: hash.startsWith('#c=') ? hash.slice(3) : null };
}

export function irA(ruta: Ruta): void {
  const hash =
    ruta.pantalla === 'panel'
      ? '#panel'
      : ruta.pantalla === 'flujos'
        ? ruta.flujoId
          ? `#flujos/${ruta.flujoId}`
          : '#flujos'
        : ruta.pantalla === 'ajustes'
          ? `#ajustes/${ruta.seccion}`
          : ruta.conversacionId
            ? `#c=${ruta.conversacionId}`
            : ruta.vista
              ? `#bandeja/${ruta.vista}`
              : '#bandeja';
  if (hash) location.hash = hash;
  else history.pushState(null, '', location.pathname);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useRuta(): Ruta {
  const [ruta, setRuta] = useState<Ruta>(() => leerRuta());
  useEffect(() => {
    const alCambiar = () => setRuta(leerRuta());
    window.addEventListener('hashchange', alCambiar);
    return () => window.removeEventListener('hashchange', alCambiar);
  }, []);
  return ruta;
}

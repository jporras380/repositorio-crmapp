import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Avisar al agente de un mensaje nuevo cuando no está mirando.
 *
 * Tres reglas, y las tres son por respeto a quien atiende:
 *
 * 1. **Solo si la pestaña no está a la vista.** Avisar de algo que se está
 *    leyendo es ruido.
 * 2. **El permiso se pide con un botón**, nunca al cargar. Un navegador que
 *    pregunta solo se contesta «bloquear» y ya no hay vuelta atrás.
 * 3. **El título siempre**, la notificación solo si dieron permiso. El título
 *    funciona en todos los navegadores y no necesita permiso de nadie.
 */

export type PermisoDeAviso = 'no_soportado' | 'default' | 'granted' | 'denied';

function permisoActual(): PermisoDeAviso {
  if (typeof Notification === 'undefined') return 'no_soportado';
  return Notification.permission as PermisoDeAviso;
}

/** Título sin el contador: `(3) Bandeja` → `Bandeja`. */
function tituloLimpio(t: string): string {
  return t.replace(/^\(\d+\)\s*/, '');
}

export interface Avisos {
  permiso: PermisoDeAviso;
  /** Pide permiso al navegador. Solo desde un gesto del agente. */
  pedirPermiso: () => Promise<void>;
  /** Llama a esto cuando entra algo nuevo. Decide si avisar y cómo. */
  avisar: (p: { titulo: string; cuerpo: string; alPulsar?: () => void }) => void;
  /** Todo leído: se limpia el contador del título. */
  limpiar: () => void;
}

export function useAvisos(): Avisos {
  const [permiso, setPermiso] = useState<PermisoDeAviso>(permisoActual);
  const pendientes = useRef(0);
  // El título base se lee al montar, no al importar el módulo: cuando se
  // importa todavía puede no estar puesto.
  const titulo = useRef<string | null>(null);

  // El contador vive en el título para que se vea desde otra pestaña, que es
  // justo cuando el agente no está mirando el CRM.
  const pintarTitulo = useCallback(() => {
    titulo.current ??= tituloLimpio(document.title);
    document.title =
      pendientes.current > 0 ? `(${pendientes.current}) ${titulo.current}` : titulo.current;
  }, []);

  const limpiar = useCallback(() => {
    pendientes.current = 0;
    pintarTitulo();
  }, [pintarTitulo]);

  // Volver a la pestaña es haberlo visto: se limpia sin tener que pulsar nada.
  useEffect(() => {
    const alVolver = () => {
      if (document.visibilityState === 'visible') limpiar();
    };
    document.addEventListener('visibilitychange', alVolver);
    return () => document.removeEventListener('visibilitychange', alVolver);
  }, [limpiar]);

  const pedirPermiso = useCallback(async () => {
    if (typeof Notification === 'undefined') return;
    try {
      setPermiso((await Notification.requestPermission()) as PermisoDeAviso);
    } catch {
      setPermiso(permisoActual());
    }
  }, []);

  const avisar = useCallback<Avisos['avisar']>(
    ({ titulo, cuerpo, alPulsar }) => {
      if (document.visibilityState === 'visible') return;
      pendientes.current += 1;
      pintarTitulo();
      if (permisoActual() !== 'granted') return;
      try {
        // `tag` fijo: si entran cinco mensajes seguidos, se reemplaza el
        // mismo aviso en vez de apilar cinco ventanas.
        const n = new Notification(titulo, { body: cuerpo, tag: 'crmapp-mensaje' });
        n.onclick = () => {
          window.focus();
          limpiar();
          alPulsar?.();
          n.close();
        };
      } catch {
        // Un navegador que no deja crear notificaciones no rompe la bandeja.
      }
    },
    [limpiar, pintarTitulo],
  );

  return { permiso, pedirPermiso, avisar, limpiar };
}

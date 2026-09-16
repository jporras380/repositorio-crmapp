import { useCallback, useEffect, useRef, useState } from 'react';
import { prepararSonido, sonarAvisoDeMensaje } from './sonido.ts';

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
 * 4. **El sonido suena aunque la pestaña esté a la vista**, y esa es la
 *    diferencia con las otras dos. El agente puede estar leyendo OTRA
 *    conversación del mismo CRM: para él, lo que acaba de entrar es tan nuevo
 *    como si estuviera en otra pestaña. Se puede silenciar, y la preferencia
 *    se recuerda.
 */

const CLAVE_SONIDO = 'crmapp.avisos.sonido';

function sonidoGuardado(): boolean {
  try {
    // Encendido por defecto: el aviso que no se oye no avisa.
    return localStorage.getItem(CLAVE_SONIDO) !== 'off';
  } catch {
    return true;
  }
}

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
  /** ¿Suena al entrar un mensaje? Se recuerda por navegador. */
  sonido: boolean;
  alternarSonido: () => void;
  /** Pide permiso al navegador. Solo desde un gesto del agente. */
  pedirPermiso: () => Promise<void>;
  /** Llama a esto cuando entra algo nuevo. Decide si avisar y cómo. */
  avisar: (p: { titulo: string; cuerpo: string; alPulsar?: () => void }) => void;
  /** Todo leído: se limpia el contador del título. */
  limpiar: () => void;
}

export function useAvisos(): Avisos {
  const [permiso, setPermiso] = useState<PermisoDeAviso>(permisoActual);
  const [sonido, setSonido] = useState<boolean>(sonidoGuardado);
  // El valor vivo para `avisar`, que se crea una vez y no vuelve a leerlo.
  const sonidoVivo = useRef(sonido);
  sonidoVivo.current = sonido;
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

  /**
   * Ningún navegador reproduce audio hasta que la persona toca la página. Se
   * prepara con el primer gesto, sea cual sea: sin esto, el CRM que se abre y
   * se deja quieto no suena nunca, que es justo el fallo que se reportó.
   */
  useEffect(() => {
    const preparar = () => prepararSonido();
    document.addEventListener('pointerdown', preparar, { once: true });
    document.addEventListener('keydown', preparar, { once: true });
    return () => {
      document.removeEventListener('pointerdown', preparar);
      document.removeEventListener('keydown', preparar);
    };
  }, []);

  const alternarSonido = useCallback(() => {
    setSonido((v) => {
      const nuevo = !v;
      try {
        localStorage.setItem(CLAVE_SONIDO, nuevo ? 'on' : 'off');
      } catch {
        // Sin almacenamiento, vale para esta sesión.
      }
      // Encenderlo ES un gesto: aprovecha para despertar el audio y, de paso,
      // deja oír cómo suena.
      if (nuevo) {
        prepararSonido();
        sonarAvisoDeMensaje();
      }
      return nuevo;
    });
  }, []);

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
      // El sonido va ANTES de la regla de visibilidad: mirando otra
      // conversación del mismo CRM, lo que entra sigue siendo nuevo.
      if (sonidoVivo.current) sonarAvisoDeMensaje();
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

  return { permiso, sonido, alternarSonido, pedirPermiso, avisar, limpiar };
}

import { useCallback, useMemo, useState } from 'react';
import type { Sesion } from '../api/tipos.ts';
import { crearApi } from '../api/cliente.ts';

const CLAVE = 'crmapp.sesion';

function leer(): Sesion | null {
  try {
    // Solo en desarrollo: `#sesion=<json>` siembra la sesión para capturas y
    // demos sin pasar por el formulario. Se elimina del bundle de producción.
    if (import.meta.env.DEV && location.hash.startsWith('#sesion=')) {
      const params = new URLSearchParams(location.hash.slice(1));
      const s = JSON.parse(params.get('sesion') ?? 'null') as Sesion;
      localStorage.setItem(CLAVE, JSON.stringify(s));
      // Se conserva la conversación pedida (#c=…) para que la bandeja la abra.
      const c = params.get('c');
      history.replaceState(null, '', c ? `#c=${c}` : location.pathname);
      return s;
    }
    const crudo = localStorage.getItem(CLAVE);
    return crudo ? (JSON.parse(crudo) as Sesion) : null;
  } catch {
    return null;
  }
}

/** Sesión en memoria + localStorage. El token lo emite la API; aquí solo se guarda. */
export function useSesion() {
  const [sesion, setSesion] = useState<Sesion | null>(leer);

  const iniciar = useCallback((s: Sesion) => {
    localStorage.setItem(CLAVE, JSON.stringify(s));
    setSesion(s);
  }, []);
  const cerrar = useCallback(() => {
    localStorage.removeItem(CLAVE);
    setSesion(null);
  }, []);

  const api = useMemo(() => crearApi(sesion?.token ?? null), [sesion?.token]);
  return { sesion, api, iniciar, cerrar };
}

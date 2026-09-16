import { useEffect, useRef } from 'react';
import { BASE } from '../api/cliente.ts';

/** Lo que manda la API por el flujo: tipos e identificadores, nada más. */
export interface EventoEnVivo {
  tipo: string;
  id: string;
  conversacionId: string | null;
}

/** Espera antes de reconectar, creciendo hasta un minuto. */
const ESPERAS_MS = [1000, 2000, 5000, 15_000, 60_000];

/**
 * Escucha los eventos de la cuenta y llama a `alEvento` con cada uno.
 *
 * Es un aviso, no el dato: la pantalla vuelve a pedir lo que necesita por los
 * endpoints de siempre. Así el flujo no puede enseñar nada que el agente no
 * pudiera ver, y si se cae, la recarga periódica sigue funcionando.
 *
 * Se usa `fetch` en vez de `EventSource` porque `EventSource` no deja poner
 * cabeceras: el token acabaría en la URL, y de ahí a los registros del
 * servidor y al historial del navegador.
 */
export function useEventos(token: string | null, alEvento: (e: EventoEnVivo) => void): void {
  // La función cambia en cada render; con una ref, el flujo no se reabre por eso.
  const manejar = useRef(alEvento);
  manejar.current = alEvento;

  useEffect(() => {
    if (!token) return;
    const control = new AbortController();
    let vivo = true;
    let intento = 0;

    async function escuchar(): Promise<void> {
      const r = await fetch(`${BASE}/v1/eventos`, {
        headers: { authorization: `Bearer ${token}` },
        signal: control.signal,
      });
      if (!r.ok || !r.body) throw new Error(`flujo ${r.status}`);
      intento = 0;
      const lector = r.body.getReader();
      const texto = new TextDecoder();
      let resto = '';
      for (;;) {
        const { done, value } = await lector.read();
        if (done) return;
        resto += texto.decode(value, { stream: true });
        // SSE separa mensajes con una línea en blanco; lo que quede a medias
        // se guarda para el siguiente trozo.
        const partes = resto.split('\n\n');
        resto = partes.pop() ?? '';
        for (const parte of partes) {
          const datos = parte
            .split('\n')
            .find((l) => l.startsWith('data:'))
            ?.slice(5)
            .trim();
          if (!datos) continue; // latido o comentario
          try {
            manejar.current(JSON.parse(datos) as EventoEnVivo);
          } catch {
            /* un evento ilegible no rompe el flujo */
          }
        }
      }
    }

    void (async () => {
      while (vivo) {
        try {
          await escuchar();
        } catch {
          if (!vivo) return;
        }
        // Se llega aquí al cortarse la conexión (red, despliegue, suspensión
        // del portátil). Se reintenta separando cada vez más para no castigar
        // a un servidor que está reiniciando.
        const espera = ESPERAS_MS[Math.min(intento, ESPERAS_MS.length - 1)]!;
        intento += 1;
        await new Promise((r) => setTimeout(r, espera));
      }
    })();

    return () => {
      vivo = false;
      control.abort();
    };
  }, [token]);
}

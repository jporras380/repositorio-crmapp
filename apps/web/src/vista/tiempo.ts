/**
 * Formato de tiempos para pintar. Solo presentación: la API manda el instante
 * en que expira la ventana; aquí se convierte en "3 h 20 min", nada más.
 */
export type TonoDeVentana = 'abierta' | 'por-cerrar' | 'cerrada';

export function ventana(
  expiraEn: string | null,
  ahora: Date = new Date(),
): { tono: TonoDeVentana; texto: string } {
  if (!expiraEn) return { tono: 'cerrada', texto: 'Sin ventana' };
  const ms = new Date(expiraEn).getTime() - ahora.getTime();
  if (ms <= 0) return { tono: 'cerrada', texto: 'Ventana cerrada' };
  const min = Math.floor(ms / 60_000);
  const h = Math.floor(min / 60);
  const texto = h >= 1 ? `${h} h ${String(min % 60).padStart(2, '0')} min` : `${min} min`;
  return { tono: h < 2 ? 'por-cerrar' : 'abierta', texto };
}

/** "14:05" hoy, "ayer", "lun", o "12 ago" según distancia. */
export function horaCorta(iso: string | null, ahora: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  const mismoDia = d.toDateString() === ahora.toDateString();
  if (mismoDia) return d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  const ayer = new Date(ahora);
  ayer.setDate(ahora.getDate() - 1);
  if (d.toDateString() === ayer.toDateString()) return 'ayer';
  const dias = (ahora.getTime() - d.getTime()) / 86_400_000;
  if (dias < 7) return d.toLocaleDateString('es', { weekday: 'short' });
  return d.toLocaleDateString('es', { day: 'numeric', month: 'short' });
}

export function horaDeMensaje(iso: string): string {
  return new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

export function inicial(nombre: string | null, handle: string | null): string {
  const base = (nombre ?? handle ?? '?').trim();
  return base.charAt(0).toUpperCase() || '?';
}

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

/**
 * Etiqueta del separador de dia dentro del hilo: «Hoy», «Ayer» o la fecha.
 * Sin el separador, dos mensajes con la misma hora y tres dias de diferencia
 * se leen como seguidos, que es el error de lectura mas caro de la bandeja.
 */
export function diaDeMensaje(iso: string, ahora: Date = new Date()): string {
  const d = new Date(iso);
  if (d.toDateString() === ahora.toDateString()) return 'Hoy';
  const ayer = new Date(ahora);
  ayer.setDate(ahora.getDate() - 1);
  if (d.toDateString() === ayer.toDateString()) return 'Ayer';
  const mismoAno = d.getFullYear() === ahora.getFullYear();
  return d.toLocaleDateString('es', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(mismoAno ? {} : { year: 'numeric' }),
  });
}

export function inicial(nombre: string | null, handle: string | null): string {
  const base = (nombre ?? handle ?? '?').trim();
  return base.charAt(0).toUpperCase() || '?';
}

/**
 * «hace 3 min», «hace 5 h», «hace 2 días».
 *
 * Para la pantalla de Canales: una fecha completa obliga a restar mentalmente
 * para contestar lo único que importa —«¿esto sigue vivo?»—, y ese cálculo es
 * justo el que no se hace cuando algo va mal y hay prisa.
 */
export function hace(iso: string | null, ahora: Date = new Date()): string | null {
  if (!iso) return null;
  const segundos = Math.floor((ahora.getTime() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(segundos) || segundos < 0) return null;
  if (segundos < 90) return 'hace un momento';
  const minutos = Math.round(segundos / 60);
  if (minutos < 60) return `hace ${minutos} min`;
  const horas = Math.round(minutos / 60);
  if (horas < 24) return `hace ${horas} h`;
  const dias = Math.round(horas / 24);
  return `hace ${dias} ${dias === 1 ? 'día' : 'días'}`;
}

/**
 * Una fecha futura en palabras: «en 12 días», «mañana», «hoy».
 *
 * `hace()` no sirve para esto y devuelve `null` con cualquier fecha futura —
 * la consola del operador enseñaba «vence » y nada detrás—. Son dos preguntas
 * distintas: cuánto hace que pasó algo, y cuánto falta para que pase.
 *
 * Se cuenta por DÍAS DE CALENDARIO y no por horas: «vence en 1 día» a las
 * once de la noche tiene que decir «mañana», no «en 13 horas», porque lo que
 * organiza el trabajo de quien lo lee es el día, no el reloj.
 */
export function faltan(iso: string | null, ahora: Date = new Date()): string | null {
  if (!iso) return null;
  const cuando = new Date(iso);
  if (Number.isNaN(cuando.getTime())) return null;
  const dia = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const dias = Math.round((dia(cuando) - dia(ahora)) / 86_400_000);
  if (dias < 0) return null;
  if (dias === 0) return 'hoy';
  if (dias === 1) return 'mañana';
  return `en ${dias} días`;
}

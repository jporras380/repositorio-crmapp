/**
 * Importes: céntimos por dentro, moneda del embudo por fuera.
 *
 * El servidor guarda enteros y no sabe de comas. Aquí se convierte una sola
 * vez, en los dos sentidos, porque un `parseFloat` repartido por cinco
 * componentes acaba en una venta de «S/ 1.500» que se guarda como 1,50.
 */

/** `123456` + `'PEN'` → `S/ 1,234.56`. Sin decimales cuando son cero. */
export function importe(centimos: number, moneda: string): string {
  const valor = centimos / 100;
  try {
    return new Intl.NumberFormat('es-PE', {
      style: 'currency',
      currency: moneda,
      minimumFractionDigits: Number.isInteger(valor) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(valor);
  } catch {
    // Una moneda que el navegador no conozca no puede dejar la tarjeta vacía.
    return `${moneda} ${valor.toFixed(2)}`;
  }
}

/**
 * Lo que escribe una persona → céntimos.
 *
 * Acepta «1234.5», «1 234,50» y «S/ 1,234.50». La regla para decidir cuál es
 * el separador decimal es la posición: el ÚLTIMO separador con dos o menos
 * dígitos detrás manda, y todo lo demás son miles. Adivinar por el símbolo
 * falla en cuanto alguien escribe a la europea en una cuenta en dólares.
 */
export function aCentimos(texto: string): number {
  // El signo se descarta con el resto de símbolos: no existen reservas
  // negativas, y un «-» de más no puede convertir 40 soles en cero.
  const limpio = texto.replace(/[^\d.,]/g, '').trim();
  if (!limpio) return 0;
  const ultimo = Math.max(limpio.lastIndexOf('.'), limpio.lastIndexOf(','));
  const decimales = ultimo >= 0 ? limpio.length - ultimo - 1 : 0;
  const esDecimal = ultimo >= 0 && decimales > 0 && decimales <= 2;
  const entero = (esDecimal ? limpio.slice(0, ultimo) : limpio).replace(/[.,]/g, '');
  const resto = esDecimal ? limpio.slice(ultimo + 1).padEnd(2, '0') : '00';
  const n = Number(`${entero || '0'}${resto}`);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Para el campo de edición: céntimos → «1234.50» sin símbolo ni miles. */
export function aCampo(centimos: number): string {
  if (!centimos) return '';
  return centimos % 100 === 0 ? String(centimos / 100) : (centimos / 100).toFixed(2);
}

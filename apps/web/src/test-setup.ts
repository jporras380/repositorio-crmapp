/**
 * Lo que jsdom no trae y la bandeja sí usa.
 *
 * `URL.createObjectURL` no existe en jsdom: sin este apaño, elegir un archivo
 * en un test revienta dentro del manejador y la bandeja aparece vacía, que es
 * un síntoma que no se parece en nada a la causa.
 */
if (typeof URL.createObjectURL !== 'function') {
  let n = 0;
  URL.createObjectURL = () => `blob:test/${++n}`;
  URL.revokeObjectURL = () => undefined;
}

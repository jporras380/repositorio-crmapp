/**
 * Datos de facturación peruanos: RUC y DNI.
 *
 * Vive en `core` porque es una regla de negocio pura —sin base de datos y sin
 * red— y la usan la API al guardar y la web al escribir. Validar solo en el
 * servidor obligaría a mandar el formulario para enterarse de que falta un
 * dígito; validar solo en el navegador no valida nada.
 *
 * ## Por qué se comprueba el dígito y no solo la longitud
 *
 * Un RUC mal tecleado no lo rechaza nadie hasta que SUNAT devuelve la factura,
 * que es semanas después y con el crédito fiscal perdido. El dígito verificador
 * atrapa el error más común —dos cifras cambiadas de sitio— en el momento de
 * escribirlo. No garantiza que el RUC exista: para eso habría que preguntarle
 * a SUNAT, que es una integración con su propia caducidad y su propio permiso.
 */

export type TipoDeComprobante = 'boleta' | 'factura';

/**
 * ¿Es un RUC válido?
 *
 * Once dígitos, con los dos primeros indicando el tipo de contribuyente:
 * `10` persona natural con negocio, `20` persona jurídica, `15` y `17`
 * casos antiguos que siguen vigentes. El último dígito es de control.
 */
export function esRucValido(ruc: string): boolean {
  const limpio = ruc.trim();
  if (!/^\d{11}$/.test(limpio)) return false;
  if (!['10', '15', '17', '20'].includes(limpio.slice(0, 2))) return false;

  // Módulo 11 con los pesos que publica SUNAT.
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((t, peso, i) => t + peso * Number(limpio[i]), 0);
  const resto = 11 - (suma % 11);
  const esperado = resto === 10 ? 0 : resto === 11 ? 1 : resto;
  return esperado === Number(limpio[10]);
}

/**
 * ¿Es un DNI válido?
 *
 * Ocho dígitos y nada más. El DNI peruano lleva un carácter de verificación,
 * pero **no está impreso en todos los documentos antiguos** y la gente no lo
 * sabe de memoria: exigirlo rechazaría a personas con su DNI en la mano.
 */
export function esDniValido(dni: string): boolean {
  return /^\d{8}$/.test(dni.trim());
}

export interface DatosDeFacturacion {
  tipo: TipoDeComprobante;
  /** RUC para factura, DNI para boleta. */
  documento: string | null;
  /** Razón social o nombre de la persona. */
  nombre: string | null;
  direccion: string | null;
}

/**
 * Qué le falta a estos datos para poder emitir el comprobante.
 *
 * Devuelve los problemas, en plural y en el idioma de quien los lee: uno por
 * uno obligaría a mandar el formulario cuatro veces para enterarse de las
 * cuatro cosas que faltan.
 */
export function problemasDeFacturacion(d: DatosDeFacturacion): string[] {
  const problemas: string[] = [];
  const documento = d.documento?.trim() ?? '';
  const nombre = d.nombre?.trim() ?? '';

  if (d.tipo === 'factura') {
    // Una factura sin estos tres datos la rechaza SUNAT, y el hotel se queda
    // sin el crédito fiscal que es la razón de pedir factura.
    if (!documento) problemas.push('La factura necesita el RUC de la empresa.');
    else if (!esRucValido(documento)) problemas.push('Ese RUC no es válido. Son 11 dígitos.');
    if (!nombre) problemas.push('La factura necesita la razón social.');
    if (!d.direccion?.trim()) problemas.push('La factura necesita la dirección fiscal.');
  } else {
    // El DNI en una boleta es opcional por debajo de S/ 700, pero si se
    // escribe tiene que estar bien: un DNI a medias no sirve para nada.
    if (documento && !esDniValido(documento)) {
      problemas.push('Ese DNI no es válido. Son 8 dígitos.');
    }
  }
  return problemas;
}

/** Horas que la plataforma se da para subir el comprobante de un pago. */
export const HORAS_PARA_EL_COMPROBANTE = 48;

/**
 * Hasta cuándo hay de plazo para subir el comprobante de un pago.
 *
 * Se calcula, no se guarda: un plazo guardado y un pago con la fecha corregida
 * se separan, y entonces la pantalla promete algo que ya no es cierto.
 */
export function venceElComprobante(pagadoEn: Date): Date {
  return new Date(pagadoEn.getTime() + HORAS_PARA_EL_COMPROBANTE * 3_600_000);
}

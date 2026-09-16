/**
 * Plantillas de WhatsApp (HSM): forma y avisos antes de mandarlas a Meta.
 *
 * **Avisa, no bloquea.** Quien aprueba es Meta y sus criterios cambian; un
 * editor que impide intentarlo es peor que uno que advierte y deja probar. Lo
 * único que se rechaza aquí es lo que Meta rechazaría SIEMPRE por forma —un
 * nombre con mayúsculas, una variable sin ejemplo— porque mandarlo es gastar
 * un intento y una espera para nada.
 *
 * Los motivos vienen del vault (`canales/whatsapp.md` §Causas frecuentes de
 * rechazo), aprendidos de la documentación de Meta y de rechazos reales.
 */

export type CategoriaDePlantilla = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

export interface BorradorDePlantilla {
  /** Minúsculas, números y guion bajo: lo exige Meta. */
  nombre: string;
  idioma: string;
  categoria: CategoriaDePlantilla;
  encabezado?: string | undefined;
  cuerpo: string;
  pie?: string | undefined;
  /** Botones de respuesta rápida: solo su texto. */
  botones?: string[] | undefined;
  /** Un ejemplo por variable, en orden: `{{1}}`, `{{2}}`… */
  ejemplos?: string[] | undefined;
}

export interface ProblemaDePlantilla {
  /** `error` impide enviarla a Meta; `aviso` solo advierte. */
  nivel: 'error' | 'aviso';
  codigo: string;
  mensaje: string;
}

const NOMBRE = /^[a-z0-9_]{1,512}$/;
const VARIABLE = /\{\{(\d+)\}\}/g;
const ACORTADORES = ['bit.ly', 'tinyurl.com', 'goo.gl', 'ow.ly', 't.co', 'cutt.ly'];
const PALABRAS_PROMOCIONALES = [
  'oferta',
  'descuento',
  'promoción',
  'promocion',
  'gratis',
  'rebaja',
  '%',
];

/** Números de variable que aparecen en un texto, en orden de aparición. */
export function variablesDe(texto: string): number[] {
  return [...texto.matchAll(VARIABLE)].map((m) => Number(m[1]));
}

export function validarPlantilla(p: BorradorDePlantilla): ProblemaDePlantilla[] {
  const problemas: ProblemaDePlantilla[] = [];
  const error = (codigo: string, mensaje: string) =>
    problemas.push({ nivel: 'error', codigo, mensaje });
  const aviso = (codigo: string, mensaje: string) =>
    problemas.push({ nivel: 'aviso', codigo, mensaje });

  if (!NOMBRE.test(p.nombre)) {
    error(
      'nombre_invalido',
      'El nombre solo admite minúsculas, números y guion bajo (ej.: confirmacion_reserva).',
    );
  }
  const cuerpo = p.cuerpo.trim();
  if (!cuerpo) error('cuerpo_vacio', 'El cuerpo no puede estar vacío.');
  if (cuerpo.length > 1024) error('cuerpo_largo', 'El cuerpo no puede pasar de 1024 caracteres.');
  if ((p.encabezado ?? '').length > 60) {
    error('encabezado_largo', 'El encabezado no puede pasar de 60 caracteres.');
  }
  if ((p.pie ?? '').length > 60) error('pie_largo', 'El pie no puede pasar de 60 caracteres.');
  if ((p.botones ?? []).length > 3) {
    error('demasiados_botones', 'Como mucho tres botones de respuesta rápida.');
  }
  if ((p.botones ?? []).some((b) => b.trim().length === 0 || b.length > 25)) {
    error('boton_invalido', 'Cada botón necesita texto y no puede pasar de 25 caracteres.');
  }

  // Variables: numeradas desde 1 y sin saltos, y CADA una con su ejemplo.
  // Meta rechaza sin excepción una plantilla con variables y sin muestra.
  const variables = [...variablesDe(p.encabezado ?? ''), ...variablesDe(cuerpo)];
  const distintas = [...new Set(variables)].sort((a, b) => a - b);
  const esperadas = distintas.map((_, i) => i + 1);
  if (distintas.join() !== esperadas.join()) {
    error(
      'variables_desordenadas',
      'Las variables se numeran desde {{1}} y sin saltos: {{1}}, {{2}}, {{3}}…',
    );
  }
  const ejemplos = (p.ejemplos ?? []).filter((e) => e.trim().length > 0);
  if (distintas.length > ejemplos.length) {
    error(
      'faltan_ejemplos',
      `Escribe un ejemplo para cada variable (${distintas.length} ${distintas.length === 1 ? 'variable' : 'variables'}). Meta rechaza las plantillas sin muestra.`,
    );
  }

  // Avisos: motivos frecuentes de rechazo, pero decide Meta.
  const texto = `${p.encabezado ?? ''} ${cuerpo} ${p.pie ?? ''}`.toLowerCase();
  if (ACORTADORES.some((a) => texto.includes(a))) {
    aviso('enlace_acortado', 'Los enlaces acortados (bit.ly y similares) suelen rechazarse.');
  }
  if (cuerpo.startsWith('{{') || cuerpo.endsWith('}}')) {
    aviso(
      'variable_en_el_borde',
      'Una variable al principio o al final del cuerpo suele rechazarse: envuélvela con texto.',
    );
  }
  if (p.categoria === 'UTILITY' && PALABRAS_PROMOCIONALES.some((w) => texto.includes(w))) {
    aviso(
      'promocional_como_utility',
      'Parece contenido promocional declarado como «utilidad». Meta puede recategorizarla como marketing, que sí se cobra.',
    );
  }
  if (p.categoria === 'AUTHENTICATION') {
    aviso(
      'autenticacion',
      'Las plantillas de autenticación tienen formato propio y restricciones aparte; revisa la documentación de Meta antes de enviarla.',
    );
  }
  return problemas;
}

/** Componentes en la forma que pide Meta al crear la plantilla. */
export function componentesDePlantilla(p: BorradorDePlantilla): Record<string, unknown>[] {
  const componentes: Record<string, unknown>[] = [];
  if (p.encabezado?.trim()) {
    const vars = variablesDe(p.encabezado);
    componentes.push({
      type: 'HEADER',
      format: 'TEXT',
      text: p.encabezado.trim(),
      // El encabezado lleva su ejemplo aparte, y en singular: `header_text`.
      ...(vars.length > 0
        ? { example: { header_text: vars.map((_, i) => (p.ejemplos ?? [])[i] ?? '') } }
        : {}),
    });
  }
  const cuerpo = p.cuerpo.trim();
  const varsCuerpo = variablesDe(cuerpo);
  componentes.push({
    type: 'BODY',
    text: cuerpo,
    ...(varsCuerpo.length > 0
      ? {
          // `body_text` es un array de arrays: una fila de ejemplos.
          example: { body_text: [varsCuerpo.map((n) => (p.ejemplos ?? [])[n - 1] ?? '')] },
        }
      : {}),
  });
  if (p.pie?.trim()) componentes.push({ type: 'FOOTER', text: p.pie.trim() });
  if ((p.botones ?? []).length > 0) {
    componentes.push({
      type: 'BUTTONS',
      buttons: (p.botones ?? []).map((texto) => ({ type: 'QUICK_REPLY', text: texto.trim() })),
    });
  }
  return componentes;
}

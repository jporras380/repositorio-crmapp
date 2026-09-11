/**
 * CSV: leerlo y escribirlo, sin dependencias.
 *
 * Existe porque importar clientes es la primera cosa que hace quien estrena
 * un CRM, y porque el archivo que llega **no es el que uno espera**. Llega
 * exportado de un Excel en español —separado por punto y coma—, con BOM
 * delante, con saltos de línea de Windows y con una observación entre
 * comillas que tiene una coma dentro. Un `split(',')` falla en el primer
 * archivo real y falla en silencio: parte una fila en dos y el usuario ve
 * clientes fantasma sin entender por qué.
 *
 * Son cien líneas y se prueban enteras. Una librería de CSV habría traído
 * más superficie de la que resuelve.
 */

export interface TablaCsv {
  cabeceras: string[];
  filas: string[][];
}

/**
 * Adivina el separador contando cuántos hay en la primera línea, fuera de
 * comillas. Preguntárselo al usuario sería trasladarle un problema que la
 * máquina resuelve mejor: casi nadie sabe con qué separador exportó su Excel.
 */
export function separadorDe(texto: string): string {
  const primera = primeraLinea(texto);
  const candidatos = [';', ',', '\t', '|'];
  let mejor = ',';
  let max = 0;
  for (const c of candidatos) {
    const n = contarFuera(primera, c);
    if (n > max) {
      max = n;
      mejor = c;
    }
  }
  return mejor;
}

/**
 * Lee un CSV completo. La primera fila es la cabecera.
 *
 * Las filas con menos columnas que la cabecera se rellenan con vacíos en vez
 * de descartarse: un campo final vacío que el exportador se comió no es
 * motivo para perder un cliente.
 */
export function leerCsv(texto: string, separador?: string): TablaCsv {
  const limpio = texto.replace(/^﻿/, '');
  const sep = separador ?? separadorDe(limpio);
  const filas = trocear(limpio, sep).filter((f) => f.some((c) => c.trim() !== ''));
  const cabeceras = (filas.shift() ?? []).map((c) => c.trim());
  return {
    cabeceras,
    filas: filas.map((f) => cabeceras.map((_, i) => (f[i] ?? '').trim())),
  };
}

/** Escribe un CSV con comillas solo donde hacen falta. */
export function escribirCsv(cabeceras: string[], filas: string[][], separador = ','): string {
  const celda = (v: string) => {
    const s = v ?? '';
    // Comillas si hay separador, comillas, salto de línea, o espacios al
    // borde —que Excel se come sin avisar.
    return /["\r\n]|^\s|\s$/.test(s) || s.includes(separador) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // CRLF: es lo que Excel espera, y en cualquier otro sitio da igual.
  return [cabeceras, ...filas].map((f) => f.map(celda).join(separador)).join('\r\n');
}

/**
 * Nombre de columna → clave comparable. Sin acentos, sin mayúsculas y sin
 * espacios, para que «Teléfono», «telefono» y «TELEFONO » sean la misma.
 */
export function clave(cabecera: string): string {
  return cabecera
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

// ---------------------------------------------------------------------------
// Interno
// ---------------------------------------------------------------------------

/** Recorre el texto carácter a carácter: es la única forma de respetar las
 * comillas, y dentro de comillas un salto de línea NO termina la fila. */
function trocear(texto: string, sep: string): string[][] {
  const filas: string[][] = [];
  let fila: string[] = [];
  let celda = '';
  let dentro = false;

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]!;
    if (dentro) {
      if (c === '"') {
        // Dos comillas seguidas son una comilla literal.
        if (texto[i + 1] === '"') {
          celda += '"';
          i++;
        } else {
          dentro = false;
        }
      } else {
        celda += c;
      }
      continue;
    }
    if (c === '"' && celda.trim() === '') {
      dentro = true;
      celda = '';
    } else if (c === sep) {
      fila.push(celda);
      celda = '';
    } else if (c === '\n') {
      fila.push(celda);
      filas.push(fila);
      fila = [];
      celda = '';
    } else if (c !== '\r') {
      celda += c;
    }
  }
  if (celda !== '' || fila.length > 0) {
    fila.push(celda);
    filas.push(fila);
  }
  return filas;
}

function primeraLinea(texto: string): string {
  let dentro = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]!;
    if (c === '"') dentro = !dentro;
    else if (c === '\n' && !dentro) return texto.slice(0, i);
  }
  return texto;
}

function contarFuera(linea: string, sep: string): number {
  let n = 0;
  let dentro = false;
  for (const c of linea) {
    if (c === '"') dentro = !dentro;
    else if (c === sep && !dentro) n++;
  }
  return n;
}

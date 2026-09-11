import { useRef, useState } from 'react';
import type { Api } from '../../api/cliente.ts';
import type { ResultadoDeImportacion } from '../../api/tipos.ts';
import estilos from './Importar.module.css';

interface Props {
  api: Api;
  alCerrar: () => void;
  alTerminar: () => void | Promise<void>;
}

/**
 * El contenido del archivo, con `FileReader` y no con `File.text()`.
 *
 * `text()` es más corto pero no existe en todas partes —jsdom, que es donde
 * corren los tests, no lo tiene—, y `FileReader` funciona en todos los
 * navegadores desde hace una década. Un solo camino, sin ramas.
 */
function textoDe(f: File): Promise<string> {
  return new Promise((ok, fallo) => {
    const lector = new FileReader();
    lector.onload = () => ok(String(lector.result ?? ''));
    lector.onerror = () => fallo(new Error('No se pudo leer el archivo.'));
    lector.readAsText(f, 'utf-8');
  });
}

/** Prefijos habituales. El primero es el del hotel; los demás, por si acaso. */
const PREFIJOS = ['+51', '+56', '+57', '+52', '+54', '+34', '+1'];

/**
 * Importar clientes desde un CSV.
 *
 * **El archivo se lee en el navegador y viaja como texto.** No hay subida de
 * archivos en el servidor porque no hace falta: un CSV de clientes son unos
 * cientos de kilobytes de texto plano, y montar almacenamiento temporal,
 * limpieza y `multipart` para eso sería pagar por un problema que no tenemos.
 *
 * **El prefijo lo elige quien importa.** Un archivo local trae «999111222» y
 * WhatsApp habla en formato internacional; completar el prefijo a escondidas
 * sería adivinar el país de cada fila. Aquí se pregunta una vez, se ve, y se
 * puede dejar en blanco.
 */
export function Importar({ api, alCerrar, alTerminar }: Props) {
  const [csv, setCsv] = useState('');
  const [nombreArchivo, setNombreArchivo] = useState<string | null>(null);
  const [prefijo, setPrefijo] = useState('+51');
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<ResultadoDeImportacion | null>(null);
  const archivo = useRef<HTMLInputElement>(null);

  async function leerArchivo(f: File) {
    setNombreArchivo(f.name);
    setCsv(await textoDe(f));
    setResultado(null);
    setError(null);
  }

  async function importar() {
    setOcupado(true);
    setError(null);
    try {
      setResultado(await api.importarClientes(csv, prefijo || undefined));
      await alTerminar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo importar.');
    } finally {
      setOcupado(false);
    }
  }

  const filas = csv ? Math.max(0, csv.trim().split('\n').length - 1) : 0;

  return (
    <section className={`glass ${estilos.panel}`} aria-label="Importar clientes">
      <header className={estilos.cabecera}>
        <div>
          <h2 className={estilos.titulo}>Importar clientes</h2>
          <p className={estilos.subtitulo}>
            Un archivo CSV con una fila por cliente. Reconoce las columnas por su nombre — «nombre»,
            «teléfono», «correo», «ciudad», «observaciones»— en cualquier orden, y vale tal como lo
            exporta Excel.
          </p>
        </div>
        <button className={estilos.cerrar} onClick={alCerrar} disabled={ocupado}>
          Cerrar
        </button>
      </header>

      {error && <p className={estilos.error}>{error}</p>}

      <div
        className={estilos.zona}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) void leerArchivo(f);
        }}
      >
        <input
          ref={archivo}
          className={estilos.oculto}
          type="file"
          accept=".csv,text/csv,text/plain"
          aria-label="Archivo CSV"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void leerArchivo(f);
          }}
        />
        <button className={estilos.elegir} onClick={() => archivo.current?.click()}>
          Elegir archivo
        </button>
        <p className={estilos.pista}>
          {nombreArchivo ? `${nombreArchivo} · ${filas} fila(s)` : 'o arrástralo aquí'}
        </p>
      </div>

      <label className={estilos.campo}>
        <span className={estilos.etiquetaCampo}>Completar los teléfonos sin prefijo con</span>
        <select
          className={estilos.select}
          value={prefijo}
          onChange={(e) => setPrefijo(e.target.value)}
        >
          <option value="">No completar</option>
          {PREFIJOS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>

      <div className={estilos.acciones}>
        <button
          className={estilos.primario}
          disabled={!csv || ocupado}
          onClick={() => void importar()}
        >
          {ocupado ? 'Importando…' : 'Importar'}
        </button>
      </div>

      {resultado && (
        <div className={estilos.resultado} role="status">
          <p className={estilos.cuenta}>
            <strong>{resultado.creados}</strong> creados · <strong>{resultado.actualizados}</strong>{' '}
            actualizados
            {resultado.omitidos > 0 && <> · {resultado.omitidos} sin datos suficientes</>}
          </p>
          {resultado.columnasIgnoradas.length > 0 && (
            <p className={estilos.aviso}>
              Columnas que no se reconocieron y quedaron fuera:{' '}
              {resultado.columnasIgnoradas.join(', ')}.
            </p>
          )}
          {resultado.errores.length > 0 && (
            <ul className={estilos.errores}>
              {resultado.errores.slice(0, 20).map((e, i) => (
                <li key={i}>
                  Línea {e.linea}: {e.motivo}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

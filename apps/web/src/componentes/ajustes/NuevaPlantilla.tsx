import { useState, type FormEvent } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { ProblemaDePlantilla } from '../../api/tipos.ts';
import compartidos from './ajustes.module.css';
import estilos from './NuevaPlantilla.module.css';

interface Props {
  api: Api;
  cuentaId: string;
  alCancelar: () => void;
  alCreada: (avisos: ProblemaDePlantilla[]) => void;
}

const CATEGORIAS: [string, string][] = [
  ['UTILITY', 'Utilidad — confirmaciones, avisos de la reserva (gratis dentro de la ventana)'],
  ['MARKETING', 'Marketing — promociones y novedades (siempre se cobra)'],
  ['AUTHENTICATION', 'Autenticación — códigos de verificación'],
];

/** Variables `{{1}}`, en orden de aparición y sin repetir. */
function variablesDe(texto: string): number[] {
  const nums = [...texto.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  return [...new Set(nums)];
}

/**
 * Crear una plantilla y mandarla a revisión de Meta.
 *
 * La misma regla que en el servidor, pero en vivo: lo que Meta rechaza
 * siempre se marca como error y el botón no envía; lo que suele rechazar se
 * advierte y se deja intentar, porque quien aprueba es Meta.
 */
export function NuevaPlantilla({ api, cuentaId, alCancelar, alCreada }: Props) {
  const [nombre, setNombre] = useState('');
  const [idioma, setIdioma] = useState('es');
  const [categoria, setCategoria] = useState('UTILITY');
  const [encabezado, setEncabezado] = useState('');
  const [cuerpo, setCuerpo] = useState('');
  const [pie, setPie] = useState('');
  const [botones, setBotones] = useState<string[]>([]);
  const [ejemplos, setEjemplos] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const variables = variablesDe(`${encabezado} ${cuerpo}`);
  const nombreValido = /^[a-z0-9_]{1,512}$/.test(nombre);
  const faltanEjemplos = variables.some((_, i) => !(ejemplos[i] ?? '').trim());
  const puedeEnviar = nombreValido && cuerpo.trim().length > 0 && !faltanEjemplos && !enviando;

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    try {
      const r = await api.crearPlantilla(cuentaId, {
        nombre,
        idioma,
        categoria,
        cuerpo: cuerpo.trim(),
        ...(encabezado.trim() ? { encabezado: encabezado.trim() } : {}),
        ...(pie.trim() ? { pie: pie.trim() } : {}),
        ...(botones.filter((b) => b.trim()).length > 0
          ? { botones: botones.filter((b) => b.trim()) }
          : {}),
        ...(variables.length > 0 ? { ejemplos: variables.map((_, i) => ejemplos[i] ?? '') } : {}),
      });
      alCreada(r.avisos);
    } catch (err) {
      setError(err instanceof ErrorDeApi ? err.message : 'No se pudo crear la plantilla.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form className={compartidos.formulario} onSubmit={enviar}>
      <p className={compartidos.descripcion}>
        Meta la revisa antes de poder usarla: suele tardar minutos, a veces horas. Escribe el texto
        tal como llegará, y usa <code>{'{{1}}'}</code>, <code>{'{{2}}'}</code>… donde cambie según
        el huésped.
      </p>

      <div className={compartidos.campos}>
        <label className={compartidos.campo}>
          <span>Nombre</span>
          <input
            required
            value={nombre}
            maxLength={100}
            placeholder="confirmacion_reserva"
            onChange={(e) => setNombre(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
          />
          <span className={compartidos.ayuda}>
            Solo minúsculas, números y guion bajo. Lo exige Meta; se corrige solo al escribir.
          </span>
        </label>
        <label className={compartidos.campo}>
          <span>Idioma</span>
          <input
            required
            value={idioma}
            maxLength={10}
            onChange={(e) => setIdioma(e.target.value.trim())}
          />
          <span className={compartidos.ayuda}>Código de Meta: es, es_MX, en_US…</span>
        </label>
      </div>

      <label className={compartidos.campo}>
        <span>Categoría</span>
        <select value={categoria} onChange={(e) => setCategoria(e.target.value)}>
          {CATEGORIAS.map(([valor, texto]) => (
            <option key={valor} value={valor}>
              {texto}
            </option>
          ))}
        </select>
        <span className={compartidos.ayuda}>
          Meta puede cambiarla: la categoría que manda para el costo es la que ella fije.
        </span>
      </label>

      <label className={compartidos.campo}>
        <span>Encabezado (opcional)</span>
        <input value={encabezado} maxLength={60} onChange={(e) => setEncabezado(e.target.value)} />
      </label>

      <label className={compartidos.campo}>
        <span>Cuerpo</span>
        <textarea
          required
          rows={4}
          maxLength={1024}
          value={cuerpo}
          placeholder="Hola {{1}}, confirmamos tu reserva del {{2}} en el Apart Hotel El Paraíso."
          onChange={(e) => setCuerpo(e.target.value)}
        />
      </label>

      <label className={compartidos.campo}>
        <span>Pie (opcional)</span>
        <input value={pie} maxLength={60} onChange={(e) => setPie(e.target.value)} />
      </label>

      {variables.length > 0 && (
        <fieldset className={estilos.ejemplos}>
          <legend>Ejemplo de cada variable</legend>
          <p className={compartidos.ayuda}>
            Meta rechaza sin excepción una plantilla con variables y sin muestra.
          </p>
          {variables.map((n, i) => (
            <label key={n} className={compartidos.campo}>
              <span>{`{{${n}}}`}</span>
              <input
                value={ejemplos[i] ?? ''}
                maxLength={200}
                placeholder={i === 0 ? 'Rosa' : '12 de julio'}
                onChange={(e) =>
                  setEjemplos((prev) => {
                    const copia = [...prev];
                    copia[i] = e.target.value;
                    return copia;
                  })
                }
              />
            </label>
          ))}
        </fieldset>
      )}

      <fieldset className={estilos.botones}>
        <legend>Botones de respuesta rápida (opcional)</legend>
        {botones.map((b, i) => (
          <div key={i} className={estilos.boton}>
            <input
              value={b}
              maxLength={25}
              aria-label={`Botón ${i + 1}`}
              onChange={(e) =>
                setBotones((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))
              }
            />
            <button
              type="button"
              className={compartidos.secundario}
              onClick={() => setBotones((prev) => prev.filter((_, j) => j !== i))}
            >
              Quitar
            </button>
          </div>
        ))}
        {botones.length < 3 && (
          <button
            type="button"
            className={compartidos.secundario}
            onClick={() => setBotones((prev) => [...prev, ''])}
          >
            + botón
          </button>
        )}
      </fieldset>

      {!nombreValido && nombre.length > 0 && (
        <p className={`${compartidos.aviso} ${compartidos.aviso_error}`}>
          El nombre solo admite minúsculas, números y guion bajo.
        </p>
      )}
      {faltanEjemplos && (
        <p className={`${compartidos.aviso} ${compartidos.aviso_info}`}>
          Falta el ejemplo de alguna variable: Meta la rechazaría.
        </p>
      )}
      {error && (
        <p className={`${compartidos.aviso} ${compartidos.aviso_error}`} role="alert">
          {error}
        </p>
      )}

      <div className={compartidos.formularioAcciones}>
        <button type="button" className={compartidos.secundario} onClick={alCancelar}>
          Cancelar
        </button>
        <button type="submit" className={compartidos.primario} disabled={!puedeEnviar}>
          {enviando ? 'Enviando a Meta…' : 'Enviar a revisión'}
        </button>
      </div>
    </form>
  );
}

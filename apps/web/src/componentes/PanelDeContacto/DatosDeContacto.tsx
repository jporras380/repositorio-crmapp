import { useState } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import estilos from './DatosDeContacto.module.css';

/**
 * Cómo localizar a esta persona: su número y su usuario.
 *
 * Antes era **una sola línea** —«+51925300224 · @joperami1»— porque el
 * servidor los mandaba ya unidos. Dos problemas de eso: no se puede copiar uno
 * sin el otro, y no se puede saber cuál falta. Ahora vienen separados.
 *
 * ## Por qué copiar y no seleccionar
 *
 * El número se usa fuera del CRM: para llamar, para pegarlo en una reserva, en
 * un grupo del hotel. Seleccionar con el ratón un texto de catorce dígitos y
 * no llevarse un espacio de más es más difícil de lo que parece, y se hace
 * varias veces al día.
 *
 * ## Por qué se puede añadir el número
 *
 * WhatsApp ya deja escribir solo con nombre de usuario: hay conversaciones sin
 * número ninguno. Si el agente lo consigue hablando —«¿me pasas tu número?»—
 * tiene que poder guardarlo, o se queda en su cabeza.
 */

interface Props {
  api: Api;
  contactoId: string;
  telefono: string | null;
  usuario: string | null;
  alCambiar: () => void | Promise<void>;
}

export function DatosDeContacto({ api, contactoId, telefono, usuario, alCambiar }: Props) {
  const [copiado, setCopiado] = useState<string | null>(null);
  const [anadiendo, setAnadiendo] = useState(false);
  const [nuevo, setNuevo] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function copiar(que: string, valor: string) {
    try {
      await navigator.clipboard.writeText(valor);
      setCopiado(que);
      setTimeout(() => setCopiado(null), 1500);
    } catch {
      // Sin permiso de portapapeles: el dato sigue a la vista para copiarlo a
      // mano, que es lo que se hacía antes de que existiera este botón.
      setError('Tu navegador no deja copiar. Selecciónalo a mano.');
    }
  }

  async function guardarTelefono() {
    const limpio = nuevo.trim();
    if (!limpio) return;
    setError(null);
    try {
      await api.editarCliente(contactoId, { telefono: limpio });
      setAnadiendo(false);
      setNuevo('');
      await alCambiar();
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo guardar el número.');
    }
  }

  return (
    <div className={estilos.datos}>
      {telefono && (
        <Dato
          etiqueta="Teléfono"
          valor={telefono}
          copiado={copiado === 'telefono'}
          alCopiar={() => void copiar('telefono', telefono)}
        />
      )}
      {usuario && (
        <Dato
          etiqueta="Usuario"
          valor={`@${usuario}`}
          copiado={copiado === 'usuario'}
          alCopiar={() => void copiar('usuario', `@${usuario}`)}
        />
      )}

      {/* Sin número no se le puede llamar ni buscar en otra parte. */}
      {!telefono &&
        (anadiendo ? (
          <div className={estilos.anadir}>
            <input
              className={estilos.entrada}
              value={nuevo}
              placeholder="+51 9…"
              aria-label="Número de teléfono"
              autoFocus
              onChange={(e) => setNuevo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void guardarTelefono();
                if (e.key === 'Escape') setAnadiendo(false);
              }}
            />
            <button className={estilos.guardar} onClick={() => void guardarTelefono()}>
              Guardar
            </button>
          </div>
        ) : (
          <button className={estilos.anadirBoton} onClick={() => setAnadiendo(true)}>
            + Añadir teléfono
          </button>
        ))}

      {error && (
        <p className={estilos.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Dato({
  etiqueta,
  valor,
  copiado,
  alCopiar,
}: {
  etiqueta: string;
  valor: string;
  copiado: boolean;
  alCopiar: () => void;
}) {
  return (
    <div className={estilos.fila}>
      <span className={estilos.valor}>{valor}</span>
      <button
        className={estilos.copiar}
        onClick={alCopiar}
        title={`Copiar ${etiqueta.toLowerCase()}`}
        /*
          El nombre va en `aria-label` y no en un texto oculto: con los dos, un
          lector de pantalla leía «Copiar Copiar teléfono». El texto visible
          dice solo «Copiar» porque al lado ya se ve QUÉ se copia.
        */
        aria-label={`Copiar ${etiqueta.toLowerCase()}`}
      >
        {/* Cambia a «Copiado» un momento: sin eso, pulsar no se nota y la
            gente pulsa dos veces por si acaso. */}
        <span className={estilos.copiarTexto}>{copiado ? 'Copiado' : 'Copiar'}</span>
      </button>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import type { Api } from '../../api/cliente.ts';
import type { Etiqueta, FichaDeCliente as Ficha, OrigenDeCliente } from '../../api/tipos.ts';
import { irA } from '../../estado/ruta.ts';
import { importe as formatearImporte } from '../../vista/dinero.ts';
import { diaDeMensaje } from '../../vista/tiempo.ts';
import { Fusionar } from './Fusionar.tsx';
import estilos from './FichaDeCliente.module.css';

interface Props {
  api: Api;
  clienteId: string;
  etiquetas: Etiqueta[];
  /** Quien no manda no borra: el botón ni siquiera aparece. */
  puedeBorrar: boolean;
  alCerrar: () => void;
  alCambiar: () => void | Promise<void>;
}

const ORIGENES: { valor: OrigenDeCliente; texto: string }[] = [
  { valor: 'whatsapp', texto: 'WhatsApp' },
  { valor: 'instagram', texto: 'Instagram' },
  { valor: 'facebook', texto: 'Facebook' },
  { valor: 'tiktok', texto: 'TikTok' },
  { valor: 'web', texto: 'Web' },
  { valor: 'otro', texto: 'Otro' },
];

/**
 * La ficha del cliente.
 *
 * Cada campo guarda al salir del foco. Es lo correcto en un panel que se
 * cierra de un clic fuera: un «Guardar» que a veces se olvida pierde trabajo,
 * y aquí no hay nada que confirmar.
 *
 * El historial —conversaciones y reservas— es de solo lectura y enlaza a
 * donde se edita. Duplicar aquí la edición del embudo sería mantener dos
 * formularios que hacen lo mismo y se separan al segundo cambio.
 */
export function FichaDeCliente({
  api,
  clienteId,
  etiquetas,
  puedeBorrar,
  alCerrar,
  alCambiar,
}: Props) {
  const [ficha, setFicha] = useState<Ficha | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [uniendo, setUniendo] = useState(false);

  const cargar = useCallback(async () => {
    try {
      setFicha(await api.cliente(clienteId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar el cliente.');
    }
  }, [api, clienteId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function guardar(cambio: Parameters<Api['editarCliente']>[1]) {
    try {
      await api.editarCliente(clienteId, cambio);
      await cargar();
      await alCambiar();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar.');
      await cargar();
    }
  }

  async function borrar() {
    try {
      const { accion } = await api.borrarCliente(clienteId);
      await alCambiar();
      alCerrar();
      if (accion === 'anonimizado') {
        // No es un detalle: el usuario pidió borrar y hay que decirle qué pasó
        // de verdad con las conversaciones de esa persona.
        alert('El cliente se anonimizó: sus conversaciones y reservas siguen en el historial.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo borrar.');
    }
  }

  if (!ficha) {
    return (
      <aside className={`glass ${estilos.ficha}`} aria-label="Cliente">
        <p className={estilos.cargando}>{error ?? 'Cargando…'}</p>
      </aside>
    );
  }

  const puestas = new Set(ficha.etiquetas.map((e) => e.id));

  return (
    <aside className={`glass ${estilos.ficha}`} aria-label={`Cliente: ${ficha.nombre ?? ''}`}>
      <header className={estilos.cabecera}>
        <h2 className={estilos.nombre}>{ficha.nombre ?? 'Sin nombre'}</h2>
        <button className={estilos.cerrar} onClick={alCerrar} aria-label="Cerrar la ficha">
          ×
        </button>
      </header>

      {error && <p className={estilos.error}>{error}</p>}

      <Campo
        etiqueta="Nombre"
        valor={ficha.nombre ?? ''}
        alGuardar={(v) => void guardar({ nombre: v || null })}
      />
      <Campo
        etiqueta="Teléfono"
        valor={ficha.telefono ?? ''}
        alGuardar={(v) => void guardar({ telefono: v || null })}
      />
      <Campo
        etiqueta="Correo"
        valor={ficha.email ?? ''}
        alGuardar={(v) => void guardar({ email: v || null })}
      />
      <Campo
        etiqueta="Ciudad"
        valor={ficha.ciudad ?? ''}
        alGuardar={(v) => void guardar({ ciudad: v || null })}
      />
      <Campo
        etiqueta="Tipo de huésped"
        valor={ficha.tipoDeHuesped ?? ''}
        alGuardar={(v) => void guardar({ tipoDeHuesped: v || null })}
      />

      <label className={estilos.campo}>
        <span className={estilos.etiquetaCampo}>Origen</span>
        <select
          className={estilos.select}
          value={ficha.origen}
          onChange={(e) => void guardar({ origen: e.target.value as OrigenDeCliente })}
        >
          {ORIGENES.map((o) => (
            <option key={o.valor} value={o.valor}>
              {o.texto}
            </option>
          ))}
        </select>
      </label>

      <label className={estilos.campo}>
        <span className={estilos.etiquetaCampo}>Observaciones</span>
        <textarea
          className={estilos.texto}
          rows={3}
          defaultValue={ficha.notas ?? ''}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (ficha.notas ?? '')) void guardar({ notas: v || null });
          }}
        />
      </label>

      <div className={estilos.campo}>
        <span className={estilos.etiquetaCampo}>Etiquetas</span>
        <div className={estilos.chips}>
          {etiquetas.map((e) => {
            const puesta = puestas.has(e.id);
            return (
              <button
                key={e.id}
                className={`${estilos.chip} ${puesta ? estilos.chipPuesta : ''}`}
                aria-pressed={puesta}
                ref={(n) => n?.style.setProperty('--color-etiqueta', e.color ?? '#8E8E93')}
                onClick={() =>
                  void guardar({
                    etiquetas: puesta
                      ? [...puestas].filter((id) => id !== e.id)
                      : [...puestas, e.id],
                  })
                }
              >
                {e.nombre}
              </button>
            );
          })}
          {etiquetas.length === 0 && <p className={estilos.pista}>Aún no hay etiquetas.</p>}
        </div>
      </div>

      {ficha.identidades.length > 0 && (
        <section className={estilos.bloque} aria-label="Canales">
          <h3 className={estilos.bloqueTitulo}>Por dónde escribe</h3>
          <ul className={estilos.lista}>
            {ficha.identidades.map((i, n) => (
              <li key={n} className={estilos.linea}>
                <span>{i.canal}</span>
                <span className={estilos.secundario}>{i.handle ?? i.telefono ?? '—'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={estilos.bloque} aria-label="Conversaciones">
        <h3 className={estilos.bloqueTitulo}>Conversaciones</h3>
        <ul className={estilos.lista}>
          {ficha.conversaciones.map((c) => (
            <li key={c.id}>
              <button
                className={estilos.enlace}
                onClick={() => irA({ pantalla: 'bandeja', conversacionId: c.id })}
              >
                <span>{c.canal}</span>
                <span className={estilos.secundario}>
                  {c.ultimoMensajeEn ? diaDeMensaje(c.ultimoMensajeEn) : c.estado}
                </span>
              </button>
            </li>
          ))}
          {ficha.conversaciones.length === 0 && (
            <li className={estilos.pista}>Todavía no ha escrito.</li>
          )}
        </ul>
      </section>

      <section className={estilos.bloque} aria-label="Historial de reservas">
        <h3 className={estilos.bloqueTitulo}>Historial de reservas</h3>
        <ul className={estilos.lista}>
          {ficha.reservas.map((r) => (
            <li key={r.id}>
              <button
                className={estilos.enlace}
                onClick={() => irA({ pantalla: 'reservas', reservaId: r.id })}
              >
                <span>{r.titulo}</span>
                <span className={estilos.secundario}>
                  {r.etapa}
                  {r.importe > 0 ? ` · ${formatearImporte(r.importe, 'PEN')}` : ''}
                </span>
              </button>
            </li>
          ))}
          {ficha.reservas.length === 0 && <li className={estilos.pista}>Sin reservas todavía.</li>}
        </ul>
      </section>

      {/*
        Unir va con borrar, en el pie: son las dos acciones que cambian la
        ficha entera, y las dos las decide quien manda.
      */}
      {puedeBorrar && uniendo && (
        <Fusionar
          api={api}
          destinoId={clienteId}
          nombreDestino={ficha.nombre}
          alHecho={alCambiar}
          alCerrar={() => setUniendo(false)}
        />
      )}

      {puedeBorrar && (
        <footer className={estilos.pie}>
          {confirmando ? (
            <span className={estilos.confirmar}>
              ¿Borrar este cliente?
              <button className={estilos.borrarSi} onClick={() => void borrar()}>
                Sí, borrar
              </button>
              <button className={estilos.borrarNo} onClick={() => setConfirmando(false)}>
                No
              </button>
            </span>
          ) : (
            <>
              <button className={estilos.unir} onClick={() => setUniendo((v) => !v)}>
                {uniendo ? 'Cancelar' : 'Unir con otra ficha'}
              </button>
              <button className={estilos.borrar} onClick={() => setConfirmando(true)}>
                Borrar cliente
              </button>
            </>
          )}
        </footer>
      )}
    </aside>
  );
}

/** Campo de texto que guarda al salir del foco y no antes. */
function Campo({
  etiqueta,
  valor,
  alGuardar,
}: {
  etiqueta: string;
  valor: string;
  alGuardar: (v: string) => void;
}) {
  return (
    <label className={estilos.campo}>
      <span className={estilos.etiquetaCampo}>{etiqueta}</span>
      <input
        className={estilos.entrada}
        defaultValue={valor}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v !== valor) alGuardar(v);
        }}
      />
    </label>
  );
}

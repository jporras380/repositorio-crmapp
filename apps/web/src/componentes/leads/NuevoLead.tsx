import { useCallback, useEffect, useState } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { EtapaDeEmbudo, ResumenDeCliente } from '../../api/tipos.ts';
import estilos from './NuevoLead.module.css';

/**
 * Anotar una oportunidad que no vino por un canal.
 *
 * El embudo se llenaba solo desde la ingesta: quien escribe por WhatsApp o
 * Instagram entra al tablero sin que nadie haga nada. Faltaba lo de siempre en
 * un hotel — **el huésped que llama por teléfono, o el que aparece en
 * recepción**. Esas consultas existían y no se contaban en ninguna parte, así
 * que el informe del periodo las ignoraba y parecían no haber pasado.
 *
 * ## Por qué exige un cliente y no un nombre suelto
 *
 * Una oportunidad sin ficha es un nombre en una tarjeta: no se le puede
 * escribir, no tiene historial y no se cruza con nada. Si el cliente no
 * existe todavía, se crea aquí mismo con su nombre y su teléfono, que es lo
 * único que hace falta para poder llamarle luego.
 */

interface Props {
  api: Api;
  etapas: EtapaDeEmbudo[];
  alCreado: () => void | Promise<void>;
  alCerrar: () => void;
}

export function NuevoLead({ api, etapas, alCreado, alCerrar }: Props) {
  const [busqueda, setBusqueda] = useState('');
  const [encontrados, setEncontrados] = useState<ResumenDeCliente[]>([]);
  const [cliente, setCliente] = useState<{ id: string; nombre: string | null } | null>(null);
  const [nombreNuevo, setNombreNuevo] = useState('');
  const [telefonoNuevo, setTelefonoNuevo] = useState('');
  const [titulo, setTitulo] = useState('');
  const [importe, setImporte] = useState('');
  const [etapaId, setEtapaId] = useState(etapas[0]?.id ?? '');
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!etapaId && etapas[0]) setEtapaId(etapas[0].id);
  }, [etapas, etapaId]);

  const buscar = useCallback(
    async (texto: string) => {
      setBusqueda(texto);
      setCliente(null);
      if (texto.trim().length < 2) {
        setEncontrados([]);
        return;
      }
      try {
        const p = await api.clientes({ q: texto.trim() });
        setEncontrados(p.items.slice(0, 6));
      } catch {
        setEncontrados([]);
      }
    },
    [api],
  );

  async function crear() {
    setOcupado(true);
    setError(null);
    try {
      let contactoId = cliente?.id;
      if (!contactoId) {
        // Se crea la ficha y la oportunidad de una vez: pedirle al agente que
        // vaya a Clientes, la cree y vuelva es perder la llamada.
        const nuevo = await api.crearCliente({
          nombre: nombreNuevo.trim() || busqueda.trim(),
          telefono: telefonoNuevo.trim() || null,
          origen: 'otro',
        });
        contactoId = nuevo.id;
      }
      await api.crearLead({
        contactoId,
        titulo: titulo.trim() || `Consulta de ${cliente?.nombre ?? (nombreNuevo || busqueda)}`,
        ...(importe.trim() ? { importe: Number(importe) } : {}),
        ...(etapaId ? { etapaId } : {}),
      });
      await alCreado();
      alCerrar();
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo crear la oportunidad.');
    } finally {
      setOcupado(false);
    }
  }

  const listo = cliente !== null || nombreNuevo.trim() !== '' || busqueda.trim() !== '';

  return (
    <section className={`glass ${estilos.panel}`} aria-label="Nueva oportunidad">
      <h2 className={estilos.titulo}>Nueva oportunidad</h2>
      <p className={estilos.ayuda}>
        Para lo que no llega por un canal: una llamada, alguien que aparece en recepción.
      </p>

      <label className={estilos.campo}>
        <span className={estilos.etiqueta}>Cliente</span>
        <input
          className={estilos.entrada}
          value={cliente?.nombre ?? busqueda}
          placeholder="Busca por nombre o teléfono"
          onChange={(e) => void buscar(e.target.value)}
        />
      </label>

      {!cliente &&
        encontrados.map((c) => (
          <button
            key={c.id}
            className={estilos.opcion}
            onClick={() => {
              setCliente({ id: c.id, nombre: c.nombre });
              setEncontrados([]);
            }}
          >
            <span>{c.nombre ?? 'Sin nombre'}</span>
            <span className={estilos.pista}>{c.telefono ?? c.email ?? ''}</span>
          </button>
        ))}

      {!cliente && busqueda.trim().length >= 2 && (
        <div className={estilos.nuevo}>
          <p className={estilos.pista}>No está en la lista. Se creará su ficha:</p>
          <label className={estilos.campo}>
            <span className={estilos.etiqueta}>Nombre</span>
            <input
              className={estilos.entrada}
              value={nombreNuevo || busqueda}
              onChange={(e) => setNombreNuevo(e.target.value)}
            />
          </label>
          <label className={estilos.campo}>
            <span className={estilos.etiqueta}>Teléfono</span>
            <input
              className={estilos.entrada}
              value={telefonoNuevo}
              placeholder="+51 9…"
              onChange={(e) => setTelefonoNuevo(e.target.value)}
            />
          </label>
        </div>
      )}

      <label className={estilos.campo}>
        <span className={estilos.etiqueta}>Qué quiere</span>
        <input
          className={estilos.entrada}
          value={titulo}
          placeholder="Bungalow familiar para el 12 de julio"
          onChange={(e) => setTitulo(e.target.value)}
        />
      </label>

      <div className={estilos.dos}>
        <label className={estilos.campo}>
          <span className={estilos.etiqueta}>Importe estimado</span>
          <input
            className={estilos.entrada}
            value={importe}
            inputMode="decimal"
            placeholder="0"
            onChange={(e) => setImporte(e.target.value.replace(/[^\d.]/g, ''))}
          />
        </label>
        <label className={estilos.campo}>
          <span className={estilos.etiqueta}>Etapa</span>
          <select
            className={estilos.entrada}
            value={etapaId}
            onChange={(e) => setEtapaId(e.target.value)}
          >
            {etapas.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nombre}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <p className={estilos.error} role="alert">
          {error}
        </p>
      )}

      <div className={estilos.acciones}>
        <button className={estilos.cancelar} onClick={alCerrar} disabled={ocupado}>
          Cancelar
        </button>
        <button className={estilos.crear} onClick={() => void crear()} disabled={ocupado || !listo}>
          {ocupado ? 'Creando…' : 'Crear oportunidad'}
        </button>
      </div>
    </section>
  );
}

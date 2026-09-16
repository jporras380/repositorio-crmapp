import { useCallback, useEffect, useState } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { CuentaDeCanal, PlantillaDeWhatsapp } from '../../api/tipos.ts';
import { NuevaPlantilla } from './NuevaPlantilla.tsx';
import estilos from './ajustes.module.css';

interface Props {
  api: Api;
  gestor: boolean;
}

const ESTADO: Record<string, { texto: string; tono: 'ok' | 'warn' | 'danger' | '' }> = {
  aprobada: { texto: 'Aprobada', tono: 'ok' },
  en_revision: { texto: 'En revisión', tono: 'warn' },
  pausada: { texto: 'Pausada', tono: 'warn' },
  rechazada: { texto: 'Rechazada', tono: 'danger' },
  deshabilitada: { texto: 'Deshabilitada', tono: 'danger' },
  borrador: { texto: 'Borrador', tono: '' },
};

/**
 * Plantillas HSM de una cuenta. Aquí no se aprueba nada: el estado viene de
 * Meta al sincronizar o por webhook; la pantalla lo muestra con su motivo.
 */
export function Plantillas({ api, gestor }: Props) {
  const [cuentas, setCuentas] = useState<CuentaDeCanal[]>([]);
  const [cuentaId, setCuentaId] = useState<string>('');
  const [plantillas, setPlantillas] = useState<PlantillaDeWhatsapp[] | null>(null);
  const [aviso, setAviso] = useState<{ tono: 'ok' | 'error'; texto: string } | null>(null);
  const [sincronizando, setSincronizando] = useState(false);
  const [creando, setCreando] = useState(false);

  useEffect(() => {
    api
      .canales()
      .then((cs) => {
        const wa = cs.filter((c) => c.canal === 'whatsapp' && c.status !== 'disconnected');
        setCuentas(wa);
        setCuentaId((actual) => actual || (wa[0]?.id ?? ''));
      })
      .catch(() => setAviso({ tono: 'error', texto: 'No se pudieron cargar los canales.' }));
  }, [api]);

  const cargar = useCallback(async () => {
    if (!cuentaId) return;
    try {
      setPlantillas(await api.plantillasDeCanal(cuentaId));
    } catch (e) {
      setAviso({ tono: 'error', texto: e instanceof Error ? e.message : 'No se pudieron cargar.' });
    }
  }, [api, cuentaId]);
  useEffect(() => void cargar(), [cargar]);

  async function borrar(p: PlantillaDeWhatsapp) {
    if (
      !confirm(
        `¿Borrar «${p.nombre}» de Meta? Dejará de poder enviarse. Los mensajes ya enviados se conservan.`,
      )
    )
      return;
    setAviso(null);
    try {
      await api.borrarPlantilla(cuentaId, p.id);
      setAviso({ tono: 'ok', texto: `«${p.nombre}» se borró en Meta.` });
      await cargar();
    } catch (e) {
      setAviso({
        tono: 'error',
        texto: e instanceof ErrorDeApi ? e.message : 'No se pudo borrar.',
      });
    }
  }

  async function sincronizar() {
    setSincronizando(true);
    setAviso(null);
    try {
      const r = await api.sincronizarPlantillas(cuentaId);
      setAviso({
        tono: 'ok',
        texto: `Sincronizado: ${r.total} plantillas en Meta, ${r.nuevas} nuevas, ${r.actualizadas} con cambios.`,
      });
      await cargar();
    } catch (e) {
      setAviso({
        tono: 'error',
        texto: e instanceof ErrorDeApi ? e.message : 'No se pudo sincronizar.',
      });
    } finally {
      setSincronizando(false);
    }
  }

  return (
    <section className={estilos.seccion}>
      <header className={estilos.cabecera}>
        <div>
          <h2 className={estilos.titulo}>Plantillas de WhatsApp</h2>
          <p className={estilos.descripcion}>
            Son los únicos mensajes que se pueden enviar cuando la ventana de 24 horas está cerrada.
            Las crea y aprueba Meta; aquí ves su estado real. Si una fue rechazada, el motivo te
            dice qué corregir.
          </p>
        </div>
        {gestor && cuentaId && !creando && (
          <div className={estilos.acciones}>
            <button
              className={estilos.secundario}
              onClick={() => void sincronizar()}
              disabled={sincronizando}
            >
              {sincronizando ? 'Consultando a Meta…' : 'Sincronizar con Meta'}
            </button>
            <button className={estilos.primario} onClick={() => setCreando(true)}>
              Nueva plantilla
            </button>
          </div>
        )}
      </header>

      {cuentas.length > 1 && (
        <label className={estilos.campo}>
          <span>Número</span>
          <select value={cuentaId} onChange={(e) => setCuentaId(e.target.value)}>
            {cuentas.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName} · {c.externalId}
              </option>
            ))}
          </select>
        </label>
      )}

      {creando && cuentaId && (
        <NuevaPlantilla
          api={api}
          cuentaId={cuentaId}
          alCancelar={() => setCreando(false)}
          alCreada={(avisos) => {
            setCreando(false);
            setAviso({
              tono: 'ok',
              texto:
                'Enviada a Meta. Quedará «En revisión» hasta que la apruebe.' +
                (avisos.length > 0 ? ` Ojo: ${avisos.map((a) => a.mensaje).join(' ')}` : ''),
            });
            void cargar();
          }}
        />
      )}

      {aviso && (
        <p
          className={`${estilos.aviso} ${aviso.tono === 'ok' ? estilos.aviso_ok : estilos.aviso_error}`}
          role="status"
        >
          {aviso.texto}
        </p>
      )}

      {cuentas.length === 0 && (
        <p className={estilos.vacio}>Conecta un número de WhatsApp para ver sus plantillas.</p>
      )}

      {cuentaId && plantillas && plantillas.length === 0 && (
        <p className={estilos.vacio}>
          Sin plantillas sincronizadas.{' '}
          {gestor ? 'Pulsa «Sincronizar con Meta».' : 'Pide a un administrador que sincronice.'}
        </p>
      )}

      {plantillas && plantillas.length > 0 && (
        <div className={estilos.tablaEnvoltorio}>
          <table className={estilos.tabla}>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Idioma</th>
                <th>Estado</th>
                <th>Categoría</th>
                <th>Calidad</th>
                <th>Última sincronización</th>
                {gestor && <th />}
              </tr>
            </thead>
            <tbody>
              {plantillas.map((p) => {
                const e = ESTADO[p.estado] ?? { texto: p.estado, tono: '' as const };
                return (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.nombre}</strong>
                      {p.motivoDeRechazo && (
                        <div className={estilos.ayuda}>Motivo: {p.motivoDeRechazo}</div>
                      )}
                    </td>
                    <td>{p.idioma}</td>
                    <td>
                      <span
                        className={`${estilos.estado} ${e.tono ? estilos[`estado_${e.tono}`] : ''}`}
                      >
                        {e.texto}
                      </span>
                    </td>
                    <td>{p.categoriaEfectiva ?? '—'}</td>
                    <td>{p.calidad ?? '—'}</td>
                    <td>
                      {p.ultimaSincronizacion
                        ? new Date(p.ultimaSincronizacion).toLocaleString('es')
                        : '—'}
                    </td>
                    {gestor && (
                      <td>
                        {p.estado !== 'deshabilitada' && (
                          <button
                            className={estilos.peligro}
                            onClick={() => void borrar(p)}
                            title="La borra en Meta; aquí queda deshabilitada"
                          >
                            Borrar
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

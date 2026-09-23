import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { ConversacionDeSoporte, CuentaEnLaConsola, DetalleDeCuenta } from '../../api/tipos.ts';
import { ChatDeSoporte } from '../../componentes/ajustes/ChatDeSoporte.tsx';
import { importe } from '../../vista/dinero.ts';
import { faltan, hace } from '../../vista/tiempo.ts';
import estilos from './CuentaDeLaPlataforma.module.css';

/**
 * Trabajar sobre UNA cuenta, desde la consola de la plataforma.
 *
 * ## Por qué existe
 *
 * La consola de PR-88 enseñaba «3 comprobantes sin subir» y no había forma de
 * subir ninguno. El modo soporte de PR-90 dejaba al cliente **aprobar** un
 * acceso que nadie podía pedir desde ninguna pantalla: se arrancaba con
 * `curl`. Y con el permiso concedido, tampoco había dónde ver qué falla.
 *
 * Tres funciones entregadas, probadas, y sin un botón. Las encontró la guarda
 * de rutas de API sin pantalla que se escribió en PR-94, no una revisión.
 *
 * ## El orden de lo que sale
 *
 * 1. **Comprobantes**, porque son lo único con un plazo legal encima.
 * 2. **El acceso de soporte**, que es lo que hay que pedir antes de poder
 *    diagnosticar nada.
 * 3. **El chat**, que es donde el cliente contó el problema.
 *
 * ## Lo que sigue sin poder hacerse desde aquí
 *
 * Leer conversaciones. Ni con el permiso concedido: lo que devuelve «qué
 * falla» son estados y errores de envío, no lo que la gente se dice. Esa
 * línea la sostiene el rol de base de datos, no esta pantalla.
 */

interface Props {
  api: Api;
  cuenta: CuentaEnLaConsola;
  alCerrar: () => void;
  /** Para refrescar la tabla cuando algo de aquí cambia sus cifras. */
  alCambiar: () => void;
}

/** Lo que se admite como comprobante. Igual que en el resto del producto. */
const COMPROBANTES = 'image/jpeg,image/png,image/webp,application/pdf';

export function CuentaDeLaPlataforma({ api, cuenta, alCerrar, alCambiar }: Props) {
  const [detalle, setDetalle] = useState<DetalleDeCuenta | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      setDetalle(await api.detalleDeCuenta(cuenta.tenantId));
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo cargar la cuenta.');
    }
  }, [api, cuenta.tenantId]);
  useEffect(() => void cargar(), [cargar]);

  return (
    <section className={estilos.panel}>
      <header className={estilos.cabecera}>
        <div>
          <h2 className={estilos.titulo}>{cuenta.nombre}</h2>
          <p className={estilos.slug}>{cuenta.slug}</p>
        </div>
        <button className={estilos.cerrar} onClick={alCerrar}>
          Cerrar
        </button>
      </header>

      {error && (
        <p className={estilos.error} role="alert">
          {error}
        </p>
      )}

      <Comprobantes
        api={api}
        tenantId={cuenta.tenantId}
        pagos={detalle?.pagosPendientes ?? []}
        cargado={detalle !== null}
        alSubir={() => {
          void cargar();
          alCambiar();
        }}
      />

      <AccesoDeSoporte
        api={api}
        tenantId={cuenta.tenantId}
        soporte={detalle?.soporte ?? null}
        alPedir={() => void cargar()}
      />

      <h3 className={estilos.seccion}>Lo que nos escribió</h3>
      <ChatDeSoporte api={api} tenantId={cuenta.tenantId} />
    </section>
  );
}

/**
 * Los pagos a los que les debemos comprobante, y el botón para subirlo.
 *
 * El plazo va en cada fila y no en un aviso general: «vencido» es un
 * incumplimiento NUESTRO con ese pago concreto, y saber cuál es lo que
 * permite hacer algo.
 */
function Comprobantes({
  api,
  tenantId,
  pagos,
  cargado,
  alSubir,
}: {
  api: Api;
  tenantId: string;
  pagos: DetalleDeCuenta['pagosPendientes'];
  cargado: boolean;
  alSubir: () => void;
}) {
  const [subiendo, setSubiendo] = useState<string | null>(null);
  const [numero, setNumero] = useState('');
  const [error, setError] = useState<string | null>(null);
  const archivo = useRef<HTMLInputElement>(null);

  async function subir(pagoId: string, f: File) {
    setSubiendo(pagoId);
    setError(null);
    try {
      const { mediaAssetId, urlDeSubida } = await api.prepararSubida(f.type, f.size, f.name);
      const r = await fetch(urlDeSubida, {
        method: 'PUT',
        body: f,
        headers: { 'content-type': f.type },
      });
      if (!r.ok) throw new Error('subida');
      await api.confirmarSubida(mediaAssetId);
      // El medio se crea DENTRO de la cuenta del cliente y el pago se busca
      // bajo su RLS: un archivo de otro inquilino no se encuentra desde aquí.
      await api.subirComprobante({
        tenantId,
        pagoId,
        mediaAssetId,
        ...(numero.trim() ? { numero: numero.trim() } : {}),
      });
      setNumero('');
      alSubir();
    } catch (err) {
      setError(err instanceof ErrorDeApi ? err.message : 'No se pudo subir el comprobante.');
    } finally {
      setSubiendo(null);
      if (archivo.current) archivo.current.value = '';
    }
  }

  return (
    <>
      <h3 className={estilos.seccion}>Comprobantes pendientes</h3>
      {error && (
        <p className={estilos.error} role="alert">
          {error}
        </p>
      )}

      {cargado && pagos.length === 0 && (
        <p className={estilos.vacio}>No le debemos ningún comprobante.</p>
      )}

      {pagos.length > 0 && (
        <label className={estilos.campo}>
          Número del comprobante (opcional)
          <input
            value={numero}
            maxLength={40}
            placeholder="F001-00000123"
            onChange={(e) => setNumero(e.target.value)}
          />
          <span className={estilos.ayuda}>
            Se guarda con el archivo para que el hotel lo reconozca en su contabilidad.
          </span>
        </label>
      )}

      <ul className={estilos.pagos}>
        {pagos.map((p) => (
          <li key={p.id} className={estilos.pago}>
            <div>
              <p className={estilos.pagoImporte}>{importe(p.importeCentimos, p.moneda)}</p>
              <p className={estilos.pagoDetalle}>
                cobrado {hace(p.registradoEn) ?? 'ahora'} ·{' '}
                {p.vencido ? (
                  // No es un retraso del cliente: es nuestro, y por eso va en
                  // rojo y con esas palabras.
                  <span className={estilos.vencido}>fuera de plazo</span>
                ) : (
                  `vence ${faltan(p.venceEn) ?? 'hoy'}`
                )}
              </p>
            </div>
            <div>
              <input
                ref={archivo}
                type="file"
                id={`comprobante-${p.id}`}
                className="visually-hidden"
                accept={COMPROBANTES}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void subir(p.id, f);
                }}
              />
              <label htmlFor={`comprobante-${p.id}`} className={estilos.subir}>
                {subiendo === p.id ? 'Subiendo…' : 'Subir comprobante'}
              </label>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Pedir entrar a la cuenta, y ver qué falla cuando ya se puede.
 *
 * Pedir no abre nada: lo abre el cliente desde sus ajustes, eligiendo el
 * plazo. Aquí solo se dice **para qué**, que es lo único que él tiene para
 * decidir, y por eso el motivo es obligatorio y largo.
 */
function AccesoDeSoporte({
  api,
  tenantId,
  soporte,
  alPedir,
}: {
  api: Api;
  tenantId: string;
  soporte: DetalleDeCuenta['soporte'];
  alPedir: () => void;
}) {
  const [motivo, setMotivo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversaciones, setConversaciones] = useState<ConversacionDeSoporte[] | null>(null);

  async function pedir() {
    setOcupado(true);
    setError(null);
    try {
      await api.pedirAccesoDeSoporte(tenantId, motivo.trim());
      setMotivo('');
      alPedir();
    } catch (err) {
      setError(err instanceof ErrorDeApi ? err.message : 'No se pudo pedir el acceso.');
    } finally {
      setOcupado(false);
    }
  }

  async function verQueFalla() {
    setError(null);
    try {
      setConversaciones(await api.conversacionesDeSoporte(tenantId));
    } catch (err) {
      setError(err instanceof ErrorDeApi ? err.message : 'No se pudo cargar.');
    }
  }

  return (
    <>
      <h3 className={estilos.seccion}>Acceso a su bandeja</h3>
      {error && (
        <p className={estilos.error} role="alert">
          {error}
        </p>
      )}

      {soporte?.estado === 'activo' ? (
        <>
          <p className={estilos.estadoOk}>
            Acceso abierto · termina {faltan(soporte.expiraEn) ?? 'pronto'}
          </p>
          <button className={estilos.accion} onClick={() => void verQueFalla()}>
            Ver qué está fallando
          </button>
          {conversaciones && <QueFalla lista={conversaciones} />}
        </>
      ) : soporte?.estado === 'pendiente' ? (
        // Sin botón de reintentar: la solicitud ya está puesta y la decisión
        // es del cliente. Insistir desde aquí solo crea duplicados.
        <p className={estilos.estadoEspera}>
          Pedido. Lo tiene que abrir el dueño o un administrador de la cuenta, desde sus ajustes.
        </p>
      ) : (
        <div className={estilos.pedir}>
          <label className={estilos.campo}>
            Para qué necesitas entrar
            <textarea
              rows={2}
              value={motivo}
              maxLength={500}
              placeholder="Dicen que no les llegan los mensajes de WhatsApp desde ayer."
              onChange={(e) => setMotivo(e.target.value)}
            />
            <span className={estilos.ayuda}>
              Lo lee el cliente antes de decidir, y es lo único que tiene para hacerlo.
            </span>
          </label>
          <button
            className={estilos.accion}
            disabled={ocupado || motivo.trim().length < 10}
            onClick={() => void pedir()}
          >
            {ocupado ? 'Pidiendo…' : 'Pedir acceso'}
          </button>
        </div>
      )}
    </>
  );
}

/** Estados y errores de envío. No es la bandeja: es la lista de lo que falla. */
function QueFalla({ lista }: { lista: ConversacionDeSoporte[] }) {
  if (lista.length === 0) {
    return <p className={estilos.vacio}>Esta cuenta no tiene conversaciones todavía.</p>;
  }
  return (
    <ul className={estilos.fallos}>
      {lista.map((c) => (
        <li key={c.id} className={estilos.fallo}>
          <span className={estilos.canal}>{c.canal}</span>
          <span className={estilos.pagoDetalle}>
            último entrante {c.ultimoEntranteEn ? (hace(c.ultimoEntranteEn) ?? 'ahora') : 'nunca'}
          </span>
          {c.mensajesFallidos > 0 && (
            <span className={estilos.vencido}>{c.mensajesFallidos} sin enviar</span>
          )}
          {/* El último error, entero: es lo que contesta «no me llega». */}
          {c.ultimoError?.mensaje && (
            <span className={estilos.errorDeEnvio}>{c.ultimoError.mensaje}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

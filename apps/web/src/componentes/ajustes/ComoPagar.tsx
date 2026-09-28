import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { ComoPagar as Datos, DeclaracionDePago } from '../../api/tipos.ts';
import { importe } from '../../vista/dinero.ts';
import { hace } from '../../vista/tiempo.ts';
import compartidos from './ajustes.module.css';
import estilos from './ComoPagar.module.css';

/**
 * A dónde transferir, y decir que ya se transfirió.
 *
 * ## El hueco que cierra
 *
 * La pantalla de Suscripción decía «los pagos se hacen por transferencia y los
 * registramos nosotros al recibirlos» y **en ningún sitio decía a dónde**. El
 * cliente leía eso y tenía que escribir para preguntar.
 *
 * ADR-011 eligió cobro manual, sin pasarela, y eso sigue. Lo que faltaba no
 * era una pasarela: era decir los datos.
 *
 * ## Por qué «declarar» y no «pagar»
 *
 * Pulsar un botón aquí no mueve dinero. Lo que hace es avisar de que ya se
 * movió, con el voucher adjunto, para que no haya que escribir por WhatsApp
 * diciendo «ya te pagué». El operador lo confirma y entonces entra en el
 * historial de pagos de verdad.
 *
 * Por eso el botón dice «Avisar de que ya pagué» y no «Pagar»: prometer un
 * cobro que no ocurre es peor que no ofrecerlo.
 */

interface Props {
  api: Api;
  datos: Datos;
  declaraciones: DeclaracionDePago[];
  /** Lo que toca este mes, para proponerlo ya escrito. */
  importeSugeridoCentimos: number;
  monedaDelPlan: string;
  /** Solo owner o admin declaran un pago. */
  gestor: boolean;
  alCambiar: () => void | Promise<void>;
}

/** Lo que vale como voucher: la captura de la app o el PDF del banco. */
const VOUCHER = 'image/jpeg,image/png,image/webp,application/pdf';

const ESTADO: Record<string, string> = {
  pendiente: 'Esperando que lo revisemos',
  confirmado: 'Confirmado',
  rechazado: 'Rechazado',
};

/** Una línea de datos que solo aparece si hay algo que poner. */
function Dato({ etiqueta, valor }: { etiqueta: string; valor: string | null }) {
  if (!valor) return null;
  return (
    <div className={estilos.dato}>
      <span className={estilos.datoEtiqueta}>{etiqueta}</span>
      {/* `user-select: all` en la hoja: estos números se copian, no se leen. */}
      <span className={estilos.datoValor}>{valor}</span>
    </div>
  );
}

export function ComoPagar({
  api,
  datos,
  declaraciones,
  importeSugeridoCentimos,
  monedaDelPlan,
  gestor,
  alCambiar,
}: Props) {
  const [abierto, setAbierto] = useState(false);
  const [metodo, setMetodo] = useState<'transferencia' | 'yape' | 'plin' | 'otro'>('transferencia');
  const [referencia, setReferencia] = useState('');
  const [pagadoEl, setPagadoEl] = useState(() => new Date().toISOString().slice(0, 10));
  const [voucher, setVoucher] = useState<{ id: string; nombre: string } | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archivo = useRef<HTMLInputElement>(null);

  const hayTransferencia = Boolean(datos.numeroDeCuenta || datos.cci);
  const hayBilletera = Boolean(datos.numeroBilletera);
  const hayAlgo = hayTransferencia || hayBilletera;

  async function subir(f: File) {
    setSubiendo(true);
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
      setVoucher({ id: mediaAssetId, nombre: f.name });
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo subir el comprobante.');
    } finally {
      setSubiendo(false);
      if (archivo.current) archivo.current.value = '';
    }
  }

  async function declarar(e: FormEvent) {
    e.preventDefault();
    setOcupado(true);
    setError(null);
    try {
      await api.declararPago({
        importeCentimos: importeSugeridoCentimos,
        moneda: monedaDelPlan,
        metodo,
        pagadoEl,
        ...(referencia.trim() ? { referencia: referencia.trim() } : {}),
        ...(voucher ? { mediaAssetId: voucher.id } : {}),
      });
      setAbierto(false);
      setVoucher(null);
      setReferencia('');
      await alCambiar();
    } catch (err) {
      setError(err instanceof ErrorDeApi ? err.message : 'No se pudo avisar.');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <>
      <h3 className={compartidos.tarjetaTitulo}>Cómo pagar</h3>

      {error && (
        <p className={`${compartidos.aviso} ${compartidos.aviso_error}`} role="alert">
          {error}
        </p>
      )}

      {/* Sin datos cargados no se promete un método que no existe: se dice que
          faltan, en vez de enseñar una tarjeta con campos vacíos. */}
      {!hayAlgo && (
        <p className={compartidos.vacio}>
          Todavía no hemos publicado nuestros datos de pago. Escríbenos por Soporte técnico y te los
          pasamos.
        </p>
      )}

      {hayAlgo && (
        <div className={estilos.metodos}>
          {hayTransferencia && (
            <article className={estilos.metodo}>
              <h4 className={estilos.metodoTitulo}>Transferencia</h4>
              <Dato etiqueta="Banco" valor={datos.banco} />
              <Dato etiqueta="Tipo de cuenta" valor={datos.tipoDeCuenta} />
              <Dato etiqueta="Número de cuenta" valor={datos.numeroDeCuenta} />
              <Dato etiqueta="CCI" valor={datos.cci} />
              <Dato etiqueta="Titular" valor={datos.titular} />
              <Dato etiqueta="Documento" valor={datos.documentoTitular} />
            </article>
          )}

          {hayBilletera && (
            <article className={estilos.metodo}>
              <h4 className={estilos.metodoTitulo}>Yape o Plin</h4>
              <Dato etiqueta="Número" valor={datos.numeroBilletera} />
              <Dato etiqueta="Titular" valor={datos.titularBilletera} />
              {datos.hayQr && <Qr api={api} />}
            </article>
          )}
        </div>
      )}

      {/* El importe en soles al lado del de dólares: quien paga por Yape paga
          en soles, y hacer la conversión de cabeza es cómo llegan pagos por
          un importe que no cuadra con nada. */}
      {datos.solesCentimos !== null && (
        <p className={compartidos.descripcion}>
          Este mes: <strong>{importe(importeSugeridoCentimos, monedaDelPlan)}</strong>, o{' '}
          <strong>{importe(datos.solesCentimos, 'PEN')}</strong> si pagas en soles.
        </p>
      )}

      {datos.nota && (
        <p className={`${compartidos.aviso} ${compartidos.aviso_info}`}>{datos.nota}</p>
      )}

      {hayAlgo && gestor && !abierto && (
        <button className={compartidos.primario} onClick={() => setAbierto(true)}>
          Avisar de que ya pagué
        </button>
      )}

      {abierto && (
        <form className={compartidos.formulario} onSubmit={declarar}>
          <p className={compartidos.descripcion}>
            Esto no cobra nada: nos avisa de que ya transferiste, para no tener que escribirnos. Lo
            revisamos y aparecerá en tus pagos.
          </p>
          <div className={compartidos.campos}>
            <label className={compartidos.campo}>
              Cómo pagaste
              <select
                value={metodo}
                onChange={(e) => setMetodo(e.target.value as typeof metodo)}
                disabled={ocupado}
              >
                <option value="transferencia">Transferencia</option>
                <option value="yape">Yape</option>
                <option value="plin">Plin</option>
                <option value="otro">Otro</option>
              </select>
            </label>
            <label className={compartidos.campo}>
              Fecha del pago
              <input
                type="date"
                value={pagadoEl}
                required
                disabled={ocupado}
                onChange={(e) => setPagadoEl(e.target.value)}
              />
            </label>
            <label className={compartidos.campo}>
              Número de operación
              <input
                value={referencia}
                maxLength={80}
                disabled={ocupado}
                placeholder="El que te dio el banco o la app"
                onChange={(e) => setReferencia(e.target.value)}
              />
              <span className={compartidos.ayuda}>
                Opcional, pero con él lo encontramos sin preguntarte nada.
              </span>
            </label>
          </div>

          <input
            ref={archivo}
            type="file"
            id="voucher-de-pago"
            className="visually-hidden"
            accept={VOUCHER}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void subir(f);
            }}
          />
          <div className={compartidos.formularioAcciones}>
            <label htmlFor="voucher-de-pago" className={compartidos.secundario}>
              {subiendo ? 'Subiendo…' : voucher ? `Adjunto: ${voucher.nombre}` : 'Adjuntar voucher'}
            </label>
            <button
              type="button"
              className={compartidos.secundario}
              onClick={() => setAbierto(false)}
            >
              Cancelar
            </button>
            <button className={compartidos.primario} disabled={ocupado || subiendo}>
              {ocupado ? 'Avisando…' : 'Avisar'}
            </button>
          </div>
        </form>
      )}

      {declaraciones.length > 0 && (
        <>
          <h3 className={compartidos.tarjetaTitulo}>Pagos que nos avisaste</h3>
          <div className={compartidos.tarjetas}>
            {declaraciones.map((d) => (
              <article key={d.id} className={compartidos.tarjeta}>
                <div>
                  <p className={compartidos.tarjetaTitulo}>
                    {importe(d.importeCentimos, d.moneda)} · {d.metodo}
                  </p>
                  <p className={compartidos.tarjetaDetalle}>
                    {ESTADO[d.estado] ?? d.estado} · avisado {hace(d.creadoEn) ?? 'ahora'}
                    {/* El motivo del rechazo, entero: sin él hay que escribir
                        para preguntar, que es lo que esto evita. */}
                    {d.notaDeRevision && ` · ${d.notaDeRevision}`}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/**
 * El QR de Yape o Plin.
 *
 * La URL se firma y caduca, así que no se puede poner directamente en el
 * `src`: un `<img>` no manda la cabecera de sesión. Se pide primero y se pinta
 * después, igual que las capturas del chat de soporte (0044).
 */
function Qr({ api }: { api: Api }) {
  const [url, setUrl] = useState<string | null>(null);
  const [fallo, setFallo] = useState(false);

  useEffect(() => {
    let vivo = true;
    api
      .qrDeCobro()
      .then((r) => {
        if (vivo) setUrl(r.url);
      })
      .catch(() => {
        if (vivo) setFallo(true);
      });
    return () => {
      vivo = false;
    };
  }, [api]);

  if (fallo) return <p className={compartidos.vacio}>No se pudo cargar el QR.</p>;
  if (!url) return <p className={compartidos.vacio}>Cargando el QR…</p>;
  return <img className={estilos.qr} src={url} alt="Código QR para pagar con Yape o Plin" />;
}

import { useEffect, useState, type FormEvent } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type {
  DatosDeFacturacion,
  PagoDeSuscripcion,
  ResumenDeSuscripcion,
  TipoDeComprobante,
} from '../../api/tipos.ts';
import estilos from './ajustes.module.css';

interface Props {
  api: Api;
}

const ESTADOS: Record<string, { texto: string; detalle: string }> = {
  prueba: { texto: 'En prueba', detalle: 'Todo disponible hasta que termine la prueba.' },
  activa: { texto: 'Al día', detalle: 'La cuenta está cubierta.' },
  gracia: {
    texto: 'En gracia',
    detalle: 'El periodo venció. Solo se puede enviar texto y los bots están detenidos.',
  },
  suspendida: {
    texto: 'Suspendida',
    detalle: 'Puedes consultar y exportar tu historial, pero no enviar.',
  },
};

const LIMITES: Record<string, string> = {
  agentes: 'asientos',
  conversaciones_mes: 'conversaciones del mes',
  bot_runs_mes: 'ejecuciones de bot del mes',
  creditos_ia_mes: 'créditos de IA del mes',
};

function dinero(centimos: number, moneda: string): string {
  return `${(centimos / 100).toLocaleString('es', { minimumFractionDigits: 2 })} ${moneda}`;
}

function fecha(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' })
    : '—';
}

/**
 * Qué se paga y hasta cuándo está cubierta la cuenta.
 *
 * **No hay botón de pagar, y no es un olvido**: el cobro es manual (ADR-011).
 * Aquí se ve el importe, la cobertura y el historial; el pago se registra por
 * fuera. Poner un botón que no cobra sería peor que no ponerlo.
 */
export function Suscripcion({ api }: Props) {
  const [d, setD] = useState<ResumenDeSuscripcion | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .suscripcion()
      .then(setD)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'No se pudo cargar.'));
  }, [api]);

  if (error) {
    return (
      <p className={`${estilos.aviso} ${estilos.aviso_error}`} role="alert">
        {error}
      </p>
    );
  }
  if (!d) return <p className={estilos.descripcion}>Cargando…</p>;

  const estado = ESTADOS[d.estado] ?? { texto: d.estado, detalle: '' };
  const moneda = d.plan?.moneda ?? 'USD';
  const cubiertaHasta = d.periodoHasta ?? d.pruebaHasta;

  return (
    <section className={estilos.seccion}>
      <header className={estilos.cabecera}>
        <div>
          <h2 className={estilos.titulo}>Suscripción</h2>
          <p className={estilos.descripcion}>
            {d.plan ? `Plan ${d.plan.nombre}` : 'Sin plan'} ·{' '}
            {dinero(d.plan?.precioPorAsientoCentimos ?? 0, moneda)} por asiento y mes. El consumo de
            WhatsApp lo cobra Meta directamente en tu cuenta; aquí solo va la suscripción.
          </p>
        </div>
      </header>

      {d.avisos.map((a) => (
        <p
          key={a.limite}
          className={`${estilos.aviso} ${a.nivel === 'pasado' ? estilos.aviso_error : estilos.aviso_info}`}
          role="status"
        >
          {a.nivel === 'pasado'
            ? `Has llegado al límite de ${LIMITES[a.limite] ?? a.limite} de tu plan (${a.usado} de ${a.tope}). Las conversaciones siguen entrando; lo que se detiene son los bots.`
            : `Vas por ${a.usado} de ${a.tope} ${LIMITES[a.limite] ?? a.limite}.`}
        </p>
      ))}

      <div className={estilos.tarjetas}>
        <div className={estilos.tarjeta}>
          <span className={estilos.tarjetaTitulo}>Estado</span>
          <span className={estilos.tarjetaDetalle}>{estado.texto}</span>
          <span className={estilos.descripcion}>{estado.detalle}</span>
        </div>
        <div className={estilos.tarjeta}>
          <span className={estilos.tarjetaTitulo}>Este mes</span>
          <span className={estilos.tarjetaDetalle}>{dinero(d.importeMensualCentimos, moneda)}</span>
          <span className={estilos.descripcion}>
            {d.asientos} {d.asientos === 1 ? 'asiento ocupado' : 'asientos ocupados'}
          </span>
        </div>
        <div className={estilos.tarjeta}>
          <span className={estilos.tarjetaTitulo}>Cubierta hasta</span>
          <span className={estilos.tarjetaDetalle}>{fecha(cubiertaHasta)}</span>
          <span className={estilos.descripcion}>
            {d.graciaHasta ? `Después hay gracia hasta el ${fecha(d.graciaHasta)}.` : ''}
          </span>
        </div>
      </div>

      <Facturacion api={api} datos={d.facturacion} alGuardar={setD} />

      <h3 className={estilos.tarjetaTitulo}>Pagos registrados</h3>
      {d.pagos.length === 0 ? (
        <p className={estilos.descripcion}>
          Todavía no hay ninguno. Los pagos se hacen por transferencia y los registramos nosotros al
          recibirlos.
        </p>
      ) : (
        <table className={estilos.tabla}>
          <thead>
            <tr>
              <th>Cubre</th>
              <th>Importe</th>
              <th>Forma</th>
              <th>Referencia</th>
              <th>Comprobante</th>
            </tr>
          </thead>
          <tbody>
            {d.pagos.map((p) => (
              <tr key={p.id}>
                <td>
                  {fecha(p.cubreDesde)} — {fecha(p.cubreHasta)}
                </td>
                <td>{dinero(p.importeCentimos, p.moneda)}</td>
                <td>{p.metodo}</td>
                <td>{p.referencia ?? '—'}</td>
                <td>
                  <Comprobante api={api} pago={p} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * A nombre de quién se emite el comprobante.
 *
 * ## Por qué se pregunta, en vez de mandar siempre una boleta
 *
 * En Perú factura y boleta no son lo mismo: la factura da crédito fiscal y
 * exige RUC, razón social y dirección; la boleta es para persona natural y no
 * lo da. Un hotel formal necesita la primera, y si el CRM manda boletas, ese
 * gasto no se puede deducir. Preguntarlo una vez evita un problema mensual.
 */
function Facturacion({
  api,
  datos,
  alGuardar,
}: {
  api: Api;
  datos: DatosDeFacturacion;
  alGuardar: (d: ResumenDeSuscripcion) => void;
}) {
  const [tipo, setTipo] = useState<TipoDeComprobante>(datos.tipo);
  const [documento, setDocumento] = useState(datos.documento ?? '');
  const [nombre, setNombre] = useState(datos.nombre ?? '');
  const [direccion, setDireccion] = useState(datos.direccion ?? '');
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const esFactura = tipo === 'factura';

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setGuardando(true);
    setError(null);
    setAviso(null);
    try {
      alGuardar(
        await api.guardarFacturacion({
          tipo,
          documento: documento.trim() || null,
          nombre: nombre.trim() || null,
          direccion: direccion.trim() || null,
        }),
      );
      setAviso('Guardado. Los próximos comprobantes salen así.');
    } catch (err) {
      setError(err instanceof ErrorDeApi ? err.message : 'No se pudo guardar.');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <form className={estilos.formulario} onSubmit={guardar}>
      <h3 className={estilos.tarjetaTitulo}>Comprobante de pago</h3>
      <p className={estilos.descripcion}>
        Lo emitimos nosotros y lo subimos aquí dentro de las 48 horas siguientes a registrar tu
        pago. Elige qué necesitas.
      </p>

      <div className={estilos.campos}>
        <label className={estilos.campo}>
          <span>Tipo</span>
          <select value={tipo} onChange={(e) => setTipo(e.target.value as TipoDeComprobante)}>
            <option value="boleta">Boleta</option>
            <option value="factura">Factura</option>
          </select>
          <span className={estilos.ayuda}>
            {esFactura
              ? 'Da crédito fiscal. Necesita RUC, razón social y dirección.'
              : 'Para persona natural. No da crédito fiscal.'}
          </span>
        </label>
        <label className={estilos.campo}>
          <span>{esFactura ? 'RUC' : 'DNI (opcional)'}</span>
          <input
            inputMode="numeric"
            maxLength={esFactura ? 11 : 8}
            value={documento}
            onChange={(e) => setDocumento(e.target.value.replace(/\D/g, ''))}
            placeholder={esFactura ? '20XXXXXXXXX' : '########'}
          />
        </label>
      </div>

      <label className={estilos.campo}>
        <span>{esFactura ? 'Razón social' : 'Nombre (opcional)'}</span>
        <input maxLength={200} value={nombre} onChange={(e) => setNombre(e.target.value)} />
      </label>

      {/* La dirección solo la pide la factura: en una boleta sobra. */}
      {esFactura && (
        <label className={estilos.campo}>
          <span>Dirección fiscal</span>
          <input
            maxLength={300}
            value={direccion}
            onChange={(e) => setDireccion(e.target.value)}
            placeholder="Av. Grau 100, Barranca"
          />
        </label>
      )}

      {error && (
        <p className={`${estilos.aviso} ${estilos.aviso_error}`} role="alert">
          {error}
        </p>
      )}
      {aviso && <p className={`${estilos.aviso} ${estilos.aviso_ok}`}>{aviso}</p>}

      <div className={estilos.formularioAcciones}>
        <button type="submit" className={estilos.primario} disabled={guardando}>
          {guardando ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
    </form>
  );
}

/**
 * El comprobante de un pago: descargarlo, o saber cuándo llega.
 *
 * Se distingue «pendiente» de «retrasado» a propósito. Lo primero es normal
 * —hay 48 horas— y lo segundo es un incumplimiento nuestro que el hotel tiene
 * derecho a ver sin tener que preguntar por WhatsApp.
 */
function Comprobante({ api, pago }: { api: Api; pago: PagoDeSuscripcion }) {
  const [abriendo, setAbriendo] = useState(false);
  const c = pago.comprobante;

  async function descargar() {
    setAbriendo(true);
    try {
      // La URL se firma para unos minutos, así que se pide al pulsar y no al
      // pintar la tabla: una lista de diez pagos pediría diez firmas que
      // caducarían antes de usarse.
      const { url } = await api.urlDeMedio(c.medioId!);
      window.open(url, '_blank', 'noopener');
    } finally {
      setAbriendo(false);
    }
  }

  if (c.estado === 'disponible') {
    return (
      <button className={estilos.secundario} onClick={() => void descargar()} disabled={abriendo}>
        {abriendo ? 'Abriendo…' : (c.numero ?? 'Descargar')}
      </button>
    );
  }
  return (
    <span className={c.estado === 'retrasado' ? estilos.retrasado : estilos.descripcion}>
      {c.estado === 'retrasado' ? 'Nos hemos retrasado' : `Antes del ${fecha(c.venceEn)}`}
    </span>
  );
}

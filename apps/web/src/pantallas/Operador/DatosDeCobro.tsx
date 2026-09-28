import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { PlanPublico } from '../../api/tipos.ts';
import { aCampo, aCentimos, importe } from '../../vista/dinero.ts';
import estilos from './DatosDeCobro.module.css';

/**
 * A dónde te pagan: los datos que verá cada cliente en su Suscripción.
 *
 * ## Por qué esto existe
 *
 * La pantalla de Suscripción decía «los pagos se hacen por transferencia y los
 * registramos nosotros al recibirlos» y **no decía a dónde**. ADR-011 eligió
 * cobro manual; lo que faltaba no era una pasarela, era decir los datos.
 *
 * ## Por qué se escriben aquí y no en el `.env`
 *
 * Cambiar un número de Yape no debería exigir tocar el servidor y reiniciarlo.
 * Aquí se escribe una vez, se cambia cuando haga falta, y queda quién lo
 * cambió y cuándo.
 *
 * ## Por qué el importe en soles se pone a mano
 *
 * Los planes están en dólares y Yape cobra en soles. Un tipo de cambio
 * automático es un servicio externo de coste recurrente y un número que se
 * mueve solo el día que a alguien le cobran de más. Aquí se fija por plan y no
 * cambia hasta que alguien decide cambiarlo.
 */

interface Props {
  api: Api;
  planes: PlanPublico[];
}

/** Lo que vale como QR: una captura de la app o una imagen. */
const IMAGEN = 'image/jpeg,image/png,image/webp';

const CAMPOS: { clave: string; etiqueta: string; ayuda?: string }[] = [
  { clave: 'banco', etiqueta: 'Banco' },
  { clave: 'tipo_de_cuenta', etiqueta: 'Tipo de cuenta', ayuda: 'Ahorros o corriente, y moneda.' },
  { clave: 'numero_de_cuenta', etiqueta: 'Número de cuenta' },
  {
    clave: 'cci',
    etiqueta: 'CCI',
    ayuda: 'El código interbancario: sin él no te pueden pagar desde otro banco.',
  },
  { clave: 'titular', etiqueta: 'Titular' },
  { clave: 'documento_titular', etiqueta: 'DNI o RUC del titular' },
  { clave: 'numero_billetera', etiqueta: 'Número de Yape o Plin' },
  { clave: 'titular_billetera', etiqueta: 'Titular de Yape o Plin' },
];

export function DatosDeCobro({ api, planes }: Props) {
  const [datos, setDatos] = useState<Record<string, string | null> | null>(null);
  const [soles, setSoles] = useState<Record<string, string>>({});
  const [guardado, setGuardado] = useState(false);
  const [subiendo, setSubiendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archivo = useRef<HTMLInputElement>(null);

  const cargar = useCallback(async () => {
    try {
      const d = await api.datosDeCobro();
      setDatos(d);
      const porPlan = (d['soles_por_plan'] ?? {}) as unknown as Record<string, number>;
      setSoles(Object.fromEntries(Object.entries(porPlan).map(([k, v]) => [k, aCampo(Number(v))])));
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudieron cargar los datos.');
    }
  }, [api]);
  useEffect(() => void cargar(), [cargar]);

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setGuardado(false);
    try {
      const soloTexto = Object.fromEntries(
        CAMPOS.map((c) => [c.clave, (datos?.[c.clave] ?? '') || null]),
      );
      await api.guardarDatosDeCobro({ ...soloTexto, nota: (datos?.['nota'] ?? '') || null });
      setGuardado(true);
    } catch (err) {
      setError(err instanceof ErrorDeApi ? err.message : 'No se pudo guardar.');
    }
  }

  async function guardarSoles(codigo: string) {
    setError(null);
    try {
      const texto = soles[codigo] ?? '';
      await api.guardarSolesDePlan(codigo, texto.trim() ? aCentimos(texto) : null);
      setGuardado(true);
    } catch (err) {
      setError(err instanceof ErrorDeApi ? err.message : 'No se pudo guardar el importe.');
    }
  }

  async function subirQr(f: File) {
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
      await api.publicarQrDeCobro(mediaAssetId);
      await cargar();
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo subir el QR.');
    } finally {
      setSubiendo(false);
      if (archivo.current) archivo.current.value = '';
    }
  }

  const campo = (clave: string) => datos?.[clave] ?? '';

  return (
    <section className={estilos.panel}>
      <header>
        <h2 className={estilos.titulo}>A dónde te pagan</h2>
        <p className={estilos.descripcion}>
          Esto es lo que cada cliente verá en su pantalla de Suscripción. Lo que dejes en blanco no
          se le enseña, así que no promete un método que no ofreces.
        </p>
      </header>

      {error && (
        <p className={estilos.error} role="alert">
          {error}
        </p>
      )}
      {guardado && !error && (
        <p className={estilos.ok} role="status">
          Guardado. Tus clientes ya lo ven.
        </p>
      )}

      {datos && (
        <form className={estilos.formulario} onSubmit={guardar}>
          <div className={estilos.campos}>
            {CAMPOS.map((c) => (
              <label key={c.clave} className={estilos.campo}>
                {c.etiqueta}
                <input
                  value={campo(c.clave)}
                  onChange={(e) => setDatos({ ...datos, [c.clave]: e.target.value })}
                />
                {c.ayuda && <span className={estilos.ayuda}>{c.ayuda}</span>}
              </label>
            ))}
          </div>

          <label className={estilos.campo}>
            Qué poner en el detalle de la transferencia
            <textarea
              rows={2}
              maxLength={500}
              value={campo('nota')}
              placeholder="Pon el nombre de tu hotel en el detalle para que lo identifiquemos."
              onChange={(e) => setDatos({ ...datos, nota: e.target.value })}
            />
            {/* Sin esto llegan pagos que nadie sabe de quién son. */}
            <span className={estilos.ayuda}>
              Se le enseña al cliente junto a los datos. Sin esto, llegan pagos sin saber de quién.
            </span>
          </label>

          <div className={estilos.acciones}>
            <button className={estilos.primario}>Guardar</button>
          </div>
        </form>
      )}

      <h3 className={estilos.subtitulo}>Código QR de Yape o Plin</h3>
      <p className={estilos.descripcion}>
        Es como paga la mayoría: escanean y listo, sin teclear tu número.
      </p>
      <input
        ref={archivo}
        type="file"
        id="qr-de-cobro"
        className="visually-hidden"
        accept={IMAGEN}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void subirQr(f);
        }}
      />
      <label htmlFor="qr-de-cobro" className={estilos.secundario}>
        {subiendo ? 'Subiendo…' : datos?.['qr_storage_key'] ? 'Cambiar el QR' : 'Subir el QR'}
      </label>
      {datos?.['qr_storage_key'] && <p className={estilos.ayuda}>Hay un QR publicado.</p>}

      <h3 className={estilos.subtitulo}>Importe en soles por plan</h3>
      <p className={estilos.descripcion}>
        Los planes están en dólares y Yape cobra en soles. Lo que pongas aquí es lo que verá el
        cliente al lado del precio; si lo dejas vacío, solo ve el importe en dólares.
      </p>
      <ul className={estilos.planes}>
        {planes.map((p) => (
          <li key={p.codigo} className={estilos.plan}>
            <span className={estilos.planNombre}>
              {p.nombre}
              <span className={estilos.ayuda}>
                {' '}
                · {importe(p.precioPorAsientoCentimos, p.moneda)} por asiento
              </span>
            </span>
            <input
              className={estilos.planImporte}
              value={soles[p.codigo] ?? ''}
              placeholder="S/ por asiento"
              onChange={(e) => setSoles({ ...soles, [p.codigo]: e.target.value })}
              onBlur={() => void guardarSoles(p.codigo)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

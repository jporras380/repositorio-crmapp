import { useCallback, useEffect, useState } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { DeclaracionDePago } from '../../api/tipos.ts';
import { importe } from '../../vista/dinero.ts';
import { hace } from '../../vista/tiempo.ts';
import estilos from './PagosDeclarados.module.css';

/**
 * «Ya te pagué»: lo que dicen los clientes y nadie ha mirado.
 *
 * ## Por qué esto es lo primero de la consola
 *
 * La consola ya enseñaba lo que NOSOTROS le debemos al cliente —comprobantes
 * sin subir— y no lo que el cliente dice habernos pagado. Es dinero esperando,
 * y es lo único de esta pantalla que otra persona está esperando a que mires.
 *
 * ## Confirmar no es un botón más
 *
 * Confirmar **crea la fila en el libro del dinero** y con ella la cuenta pasa a
 * estar cubierta. Rechazar exige escribir por qué, porque el cliente lo va a
 * leer y un rechazo mudo le obliga a escribir para preguntar.
 */

interface Props {
  api: Api;
  /** La tabla de cuentas cambia al confirmar: hay que recargarla. */
  alResolver: () => void;
}

type Pendiente = DeclaracionDePago & { tenantId: string; cuenta: string };

export function PagosDeclarados({ api, alResolver }: Props) {
  const [pendientes, setPendientes] = useState<Pendiente[] | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      setPendientes(await api.pagosDeclarados());
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudieron cargar.');
    }
  }, [api]);
  useEffect(() => void cargar(), [cargar]);

  async function resolver(p: Pendiente, confirmar: boolean) {
    // Rechazar sin motivo deja al cliente sin saber qué arreglar.
    const nota = confirmar ? undefined : prompt(`¿Por qué rechazas el pago de ${p.cuenta}?`);
    if (!confirmar && !nota?.trim()) return;

    setOcupado(p.id);
    setError(null);
    try {
      await api.resolverPagoDeclarado(p.id, {
        tenantId: p.tenantId,
        confirmar,
        ...(nota ? { nota } : {}),
      });
      await cargar();
      alResolver();
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo resolver.');
    } finally {
      setOcupado(null);
    }
  }

  // Sin nada pendiente no se ocupa sitio: esta sección es una bandeja, no un
  // panel, y una bandeja vacía no necesita anunciarse.
  if (pendientes !== null && pendientes.length === 0 && !error) return null;

  return (
    <section className={estilos.panel} aria-label="Pagos que dicen haber hecho">
      <h2 className={estilos.titulo}>
        Dicen haber pagado
        {pendientes && <span className={estilos.cuantos}>{pendientes.length}</span>}
      </h2>

      {error && (
        <p className={estilos.error} role="alert">
          {error}
        </p>
      )}

      <ul className={estilos.lista}>
        {(pendientes ?? []).map((p) => (
          <li key={p.id} className={estilos.fila}>
            <div className={estilos.quien}>
              <span className={estilos.cuenta}>{p.cuenta}</span>
              <span className={estilos.detalle}>
                {importe(p.importeCentimos, p.moneda)} · {p.metodo}
                {p.referencia ? ` · op. ${p.referencia}` : ''} · avisado{' '}
                {hace(p.creadoEn) ?? 'ahora'}
              </span>
            </div>
            <div className={estilos.acciones}>
              <button
                className={estilos.rechazar}
                disabled={ocupado === p.id}
                onClick={() => void resolver(p, false)}
              >
                Rechazar
              </button>
              <button
                className={estilos.confirmar}
                disabled={ocupado === p.id}
                onClick={() => void resolver(p, true)}
              >
                {ocupado === p.id ? 'Guardando…' : 'Confirmar'}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

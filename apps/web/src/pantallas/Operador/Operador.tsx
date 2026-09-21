import { useEffect, useMemo, useState } from 'react';
import { crearApi, ErrorDeApi } from '../../api/cliente.ts';
import type { CuentaEnLaConsola, Sesion, Yo } from '../../api/tipos.ts';
import { Barra } from '../../componentes/Barra/Barra.tsx';
import { useListaFiltrable, type ListaFiltrada } from '../../vista/listaFiltrable.ts';
import { BarraDeFiltro, ContadorYPaginas } from '../../componentes/ajustes/FiltroDeLista.tsx';
import { importe } from '../../vista/dinero.ts';
import { faltan, hace } from '../../vista/tiempo.ts';
import estilos from './Operador.module.css';

/**
 * La consola del operador: todas las cuentas de la plataforma a la vez.
 *
 * ## Qué contesta, en este orden
 *
 * 1. **¿A quién le debo un comprobante?** Es lo único con un plazo legal
 *    encima —48 horas— y por eso manda el orden de la tabla.
 * 2. **¿A quién se le vence la suscripción?** Lo segundo que decide a quién
 *    se llama hoy.
 * 3. **¿Qué cuenta se está quedando muda?** Un canal caído o cero mensajes en
 *    el mes es un cliente que se va sin avisar.
 *
 * ## Lo que NO enseña, y no es un descuido
 *
 * Ninguna conversación, ningún contacto, ningún mensaje. El rol de base de
 * datos que alimenta esta pantalla no puede leerlos —está probado contra la
 * base, no solo contra la API—, así que no es una promesa de la interfaz: es
 * una imposibilidad. Para cobrar y para saber si una cuenta va bien hacen
 * falta cifras, no la correspondencia de los huéspedes de nadie.
 */

interface Props {
  sesion: Sesion;
  alSalir: () => void;
}

export function Operador({ sesion, alSalir }: Props) {
  const api = useMemo(() => crearApi(sesion.token), [sesion.token]);
  const [yo, setYo] = useState<Yo | null>(null);
  const [cuentas, setCuentas] = useState<CuentaEnLaConsola[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .yo()
      .then(setYo)
      .catch(() => undefined);
    api
      .cuentasDeLaPlataforma()
      .then(setCuentas)
      .catch((e: unknown) =>
        setError(
          e instanceof ErrorDeApi && e.estado === 404
            ? 'Esta consola es para el personal de la plataforma.'
            : 'No se pudieron cargar las cuentas.',
        ),
      );
  }, [api]);

  const lista = useListaFiltrable(
    cuentas,
    (c) => [c.nombre, c.slug, c.plan ?? ''],
    (c) => c.altaEn,
  );

  const debiendo = (cuentas ?? []).filter((c) => c.comprobantesPendientes > 0).length;

  return (
    <div className={estilos.pantalla}>
      <Barra api={api} yo={yo} activa="operador" alSalir={alSalir} />
      <main className={`glass ${estilos.contenido}`}>
        <header className={estilos.cabecera}>
          <div>
            <h1 className={estilos.titulo}>Cuentas de la plataforma</h1>
            <p className={estilos.descripcion}>
              Facturación y salud de cada cuenta. Aquí no se ven conversaciones ni contactos: el
              permiso de base de datos que alimenta esta pantalla no puede leerlos.
            </p>
          </div>
          {/* Lo primero que se mira al entrar, sin tener que contar filas. */}
          {debiendo > 0 && (
            <span className={estilos.alerta} role="status">
              {debiendo === 1
                ? '1 cuenta espera comprobante'
                : `${debiendo} cuentas esperan comprobante`}
            </span>
          )}
        </header>

        {error && (
          <p className={estilos.error} role="alert">
            {error}
          </p>
        )}

        {cuentas && cuentas.length > 0 && (
          <BarraDeFiltro
            lista={lista as ListaFiltrada<unknown>}
            nombre={{ uno: 'cuenta', varios: 'cuentas' }}
            ejemplo="Buscar por nombre, identificador o plan…"
          />
        )}

        {cuentas && (
          <table className={estilos.tabla}>
            <thead>
              <tr>
                <th>Cuenta</th>
                <th>Plan</th>
                <th>Estado</th>
                <th>Al mes</th>
                <th>Comprobantes</th>
                <th>Canales</th>
                <th>Mensajes del mes</th>
              </tr>
            </thead>
            <tbody>
              {lista.visibles.map((c) => (
                <Fila key={c.tenantId} c={c} />
              ))}
            </tbody>
          </table>
        )}

        {cuentas && cuentas.length > 0 && (
          <ContadorYPaginas
            lista={lista as ListaFiltrada<unknown>}
            nombre={{ uno: 'cuenta', varios: 'cuentas' }}
          />
        )}
      </main>
    </div>
  );
}

function Fila({ c }: { c: CuentaEnLaConsola }) {
  return (
    <tr>
      <td>
        <span className={estilos.nombre}>{c.nombre}</span>
        <span className={estilos.slug}>{c.slug}</span>
      </td>
      <td>{c.plan ?? '—'}</td>
      <td>
        <span className={`${estilos.estado} ${estilos[`estado_${c.estado}`] ?? ''}`}>
          {ESTADO[c.estado] ?? c.estado}
        </span>
        {/* «vence» mira al futuro: con `hace()` la celda decía «vence » y nada
            detrás, porque esa función solo sabe de tiempos pasados. */}
        {faltan(c.periodoHasta) && (
          <span className={estilos.menor}>vence {faltan(c.periodoHasta)}</span>
        )}
      </td>
      <td>{importe(c.importeMensualCentimos, c.moneda)}</td>
      <td>
        {c.comprobantesPendientes === 0 ? (
          <span className={estilos.menor}>al día</span>
        ) : (
          <span className={estilos.debe}>
            {c.comprobantesPendientes} sin subir
            {/* El más viejo es el que puede haber pasado las 48 h. */}
            {c.comprobanteMasViejoEn && (
              <span className={estilos.menor}>el más viejo, {hace(c.comprobanteMasViejoEn)}</span>
            )}
          </span>
        )}
      </td>
      <td>
        {c.canales === 0 ? (
          // Una cuenta sin canales no ha terminado de instalarse; es distinto
          // de una con un canal caído, y se llama por motivos distintos.
          <span className={estilos.menor}>sin conectar</span>
        ) : c.canalesConProblema > 0 ? (
          <span className={estilos.debe}>
            {c.canalesConProblema} de {c.canales} con problema
          </span>
        ) : (
          <span className={estilos.menor}>
            {c.canales} · {c.ultimoEventoEn ? hace(c.ultimoEventoEn) : 'sin eventos'}
          </span>
        )}
      </td>
      <td className={c.mensajesDelMes === 0 ? estilos.debe : undefined}>{c.mensajesDelMes}</td>
    </tr>
  );
}

const ESTADO: Record<string, string> = {
  trialing: 'En prueba',
  active: 'Activa',
  past_due: 'Vencida',
  canceled: 'Cancelada',
};

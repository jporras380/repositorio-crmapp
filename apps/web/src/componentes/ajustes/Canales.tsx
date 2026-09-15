import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { CuentaDeCanal } from '../../api/tipos.ts';
import { irA } from '../../estado/ruta.ts';
import { ConectarCanal } from './ConectarCanal.tsx';
import estilos from './ajustes.module.css';

interface Props {
  api: Api;
  gestor: boolean;
}

const NOMBRE: Record<string, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
};
const ESTADO: Record<string, { texto: string; tono: 'ok' | 'warn' | 'danger' | '' }> = {
  connected: { texto: 'Conectado', tono: 'ok' },
  degraded: { texto: 'Con problemas', tono: 'warn' },
  blocked: { texto: 'Bloqueado', tono: 'danger' },
  disconnected: { texto: 'Desconectado', tono: '' },
};

export function Canales({ api, gestor }: Props) {
  const [cuentas, setCuentas] = useState<CuentaDeCanal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conectando, setConectando] = useState<'whatsapp' | 'instagram' | 'facebook' | null>(null);
  const [renovando, setRenovando] = useState<CuentaDeCanal | null>(null);

  const cargar = useCallback(async () => {
    try {
      setCuentas(await api.canales());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudieron cargar los canales.');
    }
  }, [api]);
  useEffect(() => void cargar(), [cargar]);

  async function desconectar(c: CuentaDeCanal) {
    if (
      !confirm(
        `¿Desconectar ${c.displayName}? Dejarán de llegar sus mensajes hasta que lo vuelvas a conectar.`,
      )
    )
      return;
    try {
      await api.desconectarCanal(c.id);
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo desconectar.');
    }
  }

  return (
    <section className={estilos.seccion}>
      <header className={estilos.cabecera}>
        <div>
          <h2 className={estilos.titulo}>Canales</h2>
          <p className={estilos.descripcion}>
            Cada número o cuenta conectada trae sus conversaciones a la bandeja. Las credenciales se
            guardan cifradas y no se vuelven a mostrar.
          </p>
        </div>
        {gestor && !conectando && (
          <div className={estilos.acciones}>
            <button className={estilos.secundario} onClick={() => setConectando('facebook')}>
              Conectar Facebook
            </button>
            <button className={estilos.secundario} onClick={() => setConectando('instagram')}>
              Conectar Instagram
            </button>
            <button className={estilos.primario} onClick={() => setConectando('whatsapp')}>
              Conectar WhatsApp
            </button>
          </div>
        )}
      </header>

      {error && (
        <p className={`${estilos.aviso} ${estilos.aviso_error}`} role="alert">
          {error}
        </p>
      )}

      {renovando && (
        <FormularioRenovar
          api={api}
          cuenta={renovando}
          alCancelar={() => setRenovando(null)}
          alRenovar={async () => {
            setRenovando(null);
            await cargar();
          }}
        />
      )}

      {conectando && (
        <ConectarCanal
          key={conectando}
          api={api}
          canal={conectando}
          alCancelar={() => setConectando(null)}
          alConectar={async () => {
            setConectando(null);
            await cargar();
          }}
        />
      )}

      {cuentas && cuentas.length === 0 && !conectando && (
        <p className={estilos.vacio}>
          Todavía no hay canales.{' '}
          {gestor
            ? 'Conecta tu número de WhatsApp, tu página de Facebook o tu Instagram para empezar.'
            : 'Pide a un administrador que conecte uno.'}
        </p>
      )}

      <div className={estilos.tarjetas}>
        {cuentas?.map((c) => {
          const e = ESTADO[c.status] ?? { texto: c.status, tono: '' as const };
          return (
            <article key={c.id} className={estilos.tarjeta}>
              <span
                className={`${estilos.canalPunto} ${estilos[`canal_${c.canal}`] ?? ''}`}
                aria-hidden="true"
              />
              <div>
                <p className={estilos.tarjetaTitulo}>{c.displayName}</p>
                <p className={estilos.tarjetaDetalle}>
                  {NOMBRE[c.canal] ?? c.canal} · {c.externalId}
                  {c.lastEventAt
                    ? ` · último evento ${new Date(c.lastEventAt).toLocaleString('es')}`
                    : ' · sin eventos todavía'}
                </p>
              </div>
              <div className={estilos.acciones}>
                {c.webhookSuscrito === false && (
                  <span
                    className={`${estilos.estado} ${estilos.estado_danger}`}
                    title="Meta no envía los mensajes de esta cuenta a esta aplicación. Renueva el token con los permisos de gestión para arreglarlo."
                  >
                    No recibe mensajes
                  </span>
                )}
                <span className={`${estilos.estado} ${e.tono ? estilos[`estado_${e.tono}`] : ''}`}>
                  {e.texto}
                </span>
                {c.canal === 'whatsapp' && (
                  <button
                    className={estilos.secundario}
                    onClick={() => irA({ pantalla: 'ajustes', seccion: 'plantillas' })}
                  >
                    Plantillas
                  </button>
                )}
                {gestor && (
                  <button className={estilos.secundario} onClick={() => setRenovando(c)}>
                    Renovar token
                  </button>
                )}
                {gestor && c.status !== 'disconnected' && (
                  <button className={estilos.peligro} onClick={() => void desconectar(c)}>
                    Desconectar
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Renovar el token de un canal ya conectado. Es lo que hace falta cuando Meta
 * lo caduca: la cuenta y sus conversaciones siguen siendo las mismas.
 */
function FormularioRenovar({
  api,
  cuenta,
  alCancelar,
  alRenovar,
}: {
  api: Api;
  cuenta: CuentaDeCanal;
  alCancelar: () => void;
  alRenovar: () => Promise<void>;
}) {
  const [accessToken, setAccessToken] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    try {
      await api.renovarCredenciales(cuenta.id, {
        accessToken: accessToken.trim(),
        ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
      });
      await alRenovar();
    } catch (err) {
      setError(err instanceof ErrorDeApi ? err.message : 'No se pudo renovar.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form className={estilos.formulario} onSubmit={enviar}>
      <p className={estilos.descripcion}>
        Nuevo token para <strong>{cuenta.displayName}</strong>. Se verifica con Meta antes de
        guardarlo; si falla, el canal se queda como está. Un token de usuario del sistema no caduca.
      </p>
      <div className={estilos.campos}>
        <label className={estilos.campo}>
          <span>Token de acceso</span>
          <input
            required
            type="password"
            autoComplete="off"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
          />
        </label>
        <label className={estilos.campo}>
          <span>Clave secreta de la app (solo si cambió)</span>
          <input
            type="password"
            autoComplete="off"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
          />
        </label>
      </div>
      {error && (
        <p className={`${estilos.aviso} ${estilos.aviso_error}`} role="alert">
          {error}
        </p>
      )}
      <div className={estilos.formularioAcciones}>
        <button type="button" className={estilos.secundario} onClick={alCancelar}>
          Cancelar
        </button>
        <button type="submit" className={estilos.primario} disabled={enviando}>
          {enviando ? 'Verificando con Meta…' : 'Renovar'}
        </button>
      </div>
    </form>
  );
}

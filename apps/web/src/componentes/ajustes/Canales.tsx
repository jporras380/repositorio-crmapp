import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { CuentaDeCanal } from '../../api/tipos.ts';
import { irA } from '../../estado/ruta.ts';
import estilos from './ajustes.module.css';

interface Props {
  api: Api;
  gestor: boolean;
}

const NOMBRE: Record<string, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
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
  const [conectando, setConectando] = useState(false);

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
          <button className={estilos.primario} onClick={() => setConectando(true)}>
            Conectar WhatsApp
          </button>
        )}
      </header>

      {error && (
        <p className={`${estilos.aviso} ${estilos.aviso_error}`} role="alert">
          {error}
        </p>
      )}

      {conectando && (
        <FormularioWhatsapp
          api={api}
          alCancelar={() => setConectando(false)}
          alConectar={async () => {
            setConectando(false);
            await cargar();
          }}
        />
      )}

      {cuentas && cuentas.length === 0 && !conectando && (
        <p className={estilos.vacio}>
          Todavía no hay canales.{' '}
          {gestor
            ? 'Conecta tu número de WhatsApp para empezar.'
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

function FormularioWhatsapp({
  api,
  alCancelar,
  alConectar,
}: {
  api: Api;
  alCancelar: () => void;
  alConectar: () => Promise<void>;
}) {
  const [datos, setDatos] = useState({
    phoneNumberId: '',
    wabaId: '',
    accessToken: '',
    appSecret: '',
    displayName: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const campo = (k: keyof typeof datos) => ({
    value: datos[k],
    onChange: (e: { target: { value: string } }) => setDatos({ ...datos, [k]: e.target.value }),
  });

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    try {
      await api.conectarWhatsapp({
        phoneNumberId: datos.phoneNumberId.trim(),
        wabaId: datos.wabaId.trim(),
        accessToken: datos.accessToken.trim(),
        appSecret: datos.appSecret.trim(),
        ...(datos.displayName.trim() ? { displayName: datos.displayName.trim() } : {}),
      });
      await alConectar();
    } catch (err) {
      setError(
        err instanceof ErrorDeApi ? err.message : 'No se pudo conectar. Revisa tu conexión.',
      );
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form className={estilos.formulario} onSubmit={enviar}>
      <p className={estilos.descripcion}>
        Los cuatro datos están en el panel de Meta para desarrolladores. Se verifican contra Meta
        antes de guardarse.
      </p>
      <div className={estilos.campos}>
        <label className={estilos.campo}>
          <span>Phone number ID</span>
          <input required inputMode="numeric" autoComplete="off" {...campo('phoneNumberId')} />
          <span className={estilos.ayuda}>WhatsApp → Configuración de la API</span>
        </label>
        <label className={estilos.campo}>
          <span>ID de la cuenta de WhatsApp Business (WABA)</span>
          <input required inputMode="numeric" autoComplete="off" {...campo('wabaId')} />
        </label>
        <label className={estilos.campo}>
          <span>Token de acceso</span>
          <input required type="password" autoComplete="off" {...campo('accessToken')} />
          <span className={estilos.ayuda}>
            El temporal caduca en 24 h; el permanente sale de un usuario del sistema.
          </span>
        </label>
        <label className={estilos.campo}>
          <span>Clave secreta de la app</span>
          <input required type="password" autoComplete="off" {...campo('appSecret')} />
          <span className={estilos.ayuda}>
            Configuración de la app → Básica. Verifica la firma de cada webhook.
          </span>
        </label>
        <label className={estilos.campo}>
          <span>Nombre para mostrar (opcional)</span>
          <input maxLength={80} {...campo('displayName')} />
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
          {enviando ? 'Verificando con Meta…' : 'Conectar'}
        </button>
      </div>
    </form>
  );
}

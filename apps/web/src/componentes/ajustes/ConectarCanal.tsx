import { useState, type FormEvent } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { CuentaDeInstagramDescubierta, DescubrimientoWhatsapp } from '../../api/tipos.ts';
import compartidos from './ajustes.module.css';
import estilos from './ConectarCanal.module.css';

interface Props {
  api: Api;
  canal: 'whatsapp' | 'instagram';
  alCancelar: () => void;
  alConectar: () => Promise<void>;
}

/** Una opción elegible, igual para un número de WhatsApp que para una cuenta de Instagram. */
interface Opcion {
  clave: string;
  titulo: string;
  detalle: string;
  yaConectado: boolean;
}

const CALIDAD: Record<string, string> = {
  GREEN: 'calidad alta',
  YELLOW: 'calidad media',
  RED: 'calidad baja',
};

const mensajeDe = (e: unknown, porDefecto: string) =>
  e instanceof ErrorDeApi ? e.message : porDefecto;

/**
 * Conectar un canal en dos pasos: pegar token y clave secreta, y ELEGIR el
 * número o la cuenta de una lista que trae Meta. Sustituye al formulario de
 * cuatro identificadores copiados del panel de desarrolladores (P-26, opción A).
 *
 * El token se queda en este componente hasta conectar; la lista que llega del
 * servidor no trae tokens. Si Meta no deja listar las cuentas de WhatsApp con
 * ese token, se pide el único dato que falta —el id de la cuenta— y se dice por
 * qué, en vez de volver al formulario largo.
 */
export function ConectarCanal({ api, canal, alCancelar, alConectar }: Props) {
  const esWhatsapp = canal === 'whatsapp';
  const [accessToken, setAccessToken] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [nombre, setNombre] = useState('');

  const [whatsapp, setWhatsapp] = useState<DescubrimientoWhatsapp | null>(null);
  const [instagram, setInstagram] = useState<CuentaDeInstagramDescubierta[] | null>(null);
  const [elegida, setElegida] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<'buscando' | 'conectando' | null>(null);

  const descubierto = esWhatsapp ? whatsapp !== null : instagram !== null;

  const opciones: Opcion[] = esWhatsapp
    ? (whatsapp?.cuentas ?? []).flatMap((w) =>
        w.numeros.map((n) => ({
          // La clave lleva la WABA: el alta necesita las dos cosas.
          clave: `${w.wabaId}:${n.phoneNumberId}`,
          titulo: n.numero,
          detalle: [n.nombreVerificado, w.nombre, n.calidad ? CALIDAD[n.calidad] : null]
            .filter(Boolean)
            .join(' · '),
          yaConectado: n.yaConectado,
        })),
      )
    : (instagram ?? []).map((c) => ({
        clave: c.igUserId,
        titulo: c.usuario ?? c.pagina,
        detalle: `Página de Facebook: ${c.pagina}`,
        yaConectado: c.yaConectado,
      }));

  async function buscar(e: FormEvent) {
    e.preventDefault();
    setOcupado('buscando');
    setError(null);
    setElegida(null);
    try {
      if (esWhatsapp) {
        const d = await api.descubrirWhatsapp({
          accessToken: accessToken.trim(),
          ...(wabaId.trim() ? { wabaId: wabaId.trim() } : {}),
        });
        setWhatsapp(d);
        const libres = d.cuentas.flatMap((w) =>
          w.numeros.filter((n) => !n.yaConectado).map((n) => `${w.wabaId}:${n.phoneNumberId}`),
        );
        // Con un solo número libre no hay nada que elegir.
        if (libres.length === 1) setElegida(libres[0]!);
      } else {
        const d = await api.descubrirInstagram({ accessToken: accessToken.trim() });
        setInstagram(d);
        const libres = d.filter((c) => !c.yaConectado);
        if (libres.length === 1) setElegida(libres[0]!.igUserId);
      }
    } catch (err) {
      setError(mensajeDe(err, 'No se pudo consultar a Meta. Revisa tu conexión.'));
    } finally {
      setOcupado(null);
    }
  }

  async function conectar() {
    if (!elegida) return;
    setOcupado('conectando');
    setError(null);
    const comunes = {
      accessToken: accessToken.trim(),
      appSecret: appSecret.trim(),
      ...(nombre.trim() ? { displayName: nombre.trim() } : {}),
    };
    try {
      if (esWhatsapp) {
        const [waba, numero] = elegida.split(':') as [string, string];
        await api.conectarWhatsapp({ phoneNumberId: numero, wabaId: waba, ...comunes });
      } else {
        await api.conectarInstagram({ igUserId: elegida, ...comunes });
      }
      await alConectar();
    } catch (err) {
      setError(mensajeDe(err, 'No se pudo conectar. Revisa tu conexión.'));
    } finally {
      setOcupado(null);
    }
  }

  const caduca = whatsapp?.caducaEn ? new Date(whatsapp.caducaEn) : null;

  return (
    <div className={compartidos.formulario}>
      <form className={estilos.paso} onSubmit={buscar}>
        <h3 className={estilos.pasoTitulo}>
          {esWhatsapp ? 'Conectar WhatsApp' : 'Conectar Instagram'}
        </h3>
        <p className={compartidos.descripcion}>
          {esWhatsapp
            ? 'Pega el token de tu app de Meta y te enseñamos los números que puede usar. No hace falta copiar ningún identificador.'
            : 'Pega el token de tu app de Meta y te enseñamos las cuentas de Instagram vinculadas a tus páginas de Facebook.'}
        </p>

        <details className={estilos.guia}>
          <summary>¿Dónde saco el token y la clave secreta?</summary>
          {esWhatsapp ? (
            <ol>
              <li>
                En Meta Business Suite: Configuración del negocio → Usuarios del sistema. Crea uno
                (o usa el que tengas) y asígnale tu app y tu cuenta de WhatsApp.
              </li>
              <li>
                «Generar token», con los permisos <code>whatsapp_business_messaging</code> y{' '}
                <code>whatsapp_business_management</code>. Ese token no caduca.
              </li>
              <li>La clave secreta está en tu app: Configuración de la app → Básica.</li>
            </ol>
          ) : (
            <ol>
              <li>
                Tu cuenta de Instagram debe ser profesional y estar vinculada a una página de
                Facebook.
              </li>
              <li>
                Genera un token de usuario con <code>instagram_basic</code>,{' '}
                <code>instagram_manage_messages</code>, <code>instagram_manage_comments</code>,{' '}
                <code>pages_show_list</code>, <code>pages_manage_metadata</code> y{' '}
                <code>pages_read_engagement</code>. El CRM lo cambia por el de la página.
              </li>
              <li>La clave secreta está en tu app: Configuración de la app → Básica.</li>
            </ol>
          )}
        </details>

        <div className={compartidos.campos}>
          <label className={compartidos.campo}>
            <span>Token de acceso</span>
            <input
              required
              type="password"
              autoComplete="off"
              value={accessToken}
              onChange={(e) => {
                setAccessToken(e.target.value);
                // Otro token puede ver otras cuentas: la lista anterior ya no vale.
                setWhatsapp(null);
                setInstagram(null);
                setElegida(null);
              }}
            />
          </label>
          <label className={compartidos.campo}>
            <span>Clave secreta de la app</span>
            <input
              required
              type="password"
              autoComplete="off"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
            />
            <span className={compartidos.ayuda}>
              Con ella se comprueba que cada mensaje viene de Meta.
            </span>
          </label>
          {esWhatsapp && whatsapp?.necesitaWaba && (
            <label className={compartidos.campo}>
              <span>ID de la cuenta de WhatsApp Business</span>
              <input
                required
                inputMode="numeric"
                autoComplete="off"
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
              />
              <span className={compartidos.ayuda}>
                En el Administrador de WhatsApp, junto al nombre de la cuenta.
              </span>
            </label>
          )}
        </div>

        {esWhatsapp && whatsapp?.necesitaWaba && (
          <p className={`${compartidos.aviso} ${compartidos.aviso_info}`}>
            Meta no deja ver con este token qué cuentas tienes. Falta un solo dato: el ID de la
            cuenta de WhatsApp Business. Con él buscamos los números.
          </p>
        )}

        {(!descubierto || whatsapp?.necesitaWaba) && (
          <div className={compartidos.formularioAcciones}>
            <button type="button" className={compartidos.secundario} onClick={alCancelar}>
              Cancelar
            </button>
            <button type="submit" className={compartidos.primario} disabled={ocupado !== null}>
              {ocupado === 'buscando'
                ? 'Consultando a Meta…'
                : esWhatsapp
                  ? 'Buscar mis números'
                  : 'Buscar mis cuentas'}
            </button>
          </div>
        )}
      </form>

      {descubierto && !whatsapp?.necesitaWaba && (
        <div className={estilos.paso}>
          {caduca && (
            <p className={`${compartidos.aviso} ${estilos.avisoCaduca}`}>
              Este token caduca el {caduca.toLocaleString('es')}. Después dejarán de llegar mensajes
              hasta que lo renueves; uno de usuario del sistema no caduca.
            </p>
          )}

          {opciones.length === 0 ? (
            <p className={compartidos.vacio}>
              {esWhatsapp
                ? 'Este token no ve ningún número. Revisa que el usuario del sistema tenga asignada la cuenta de WhatsApp.'
                : 'Este token no ve ninguna cuenta de Instagram. Revisa que sea profesional, esté vinculada a una página y que el token tenga los permisos de páginas.'}
            </p>
          ) : (
            <fieldset className={estilos.opciones}>
              <legend className={estilos.pasoTitulo}>
                {esWhatsapp ? 'Elige el número' : 'Elige la cuenta'}
              </legend>
              {opciones.map((o) => (
                <label
                  key={o.clave}
                  className={`${estilos.opcion} ${elegida === o.clave ? estilos.opcionElegida : ''}`}
                >
                  <input
                    type="radio"
                    name={`canal-${canal}`}
                    value={o.clave}
                    checked={elegida === o.clave}
                    disabled={o.yaConectado}
                    onChange={() => setElegida(o.clave)}
                  />
                  <span className={estilos.opcionTexto}>
                    <span className={estilos.opcionTitulo}>{o.titulo}</span>
                    {o.detalle && <span className={estilos.opcionDetalle}>{o.detalle}</span>}
                  </span>
                  {o.yaConectado && <span className={estilos.yaConectado}>Ya conectado</span>}
                </label>
              ))}
            </fieldset>
          )}

          {opciones.length > 0 && (
            <label className={compartidos.campo}>
              <span>Nombre para mostrar (opcional)</span>
              <input maxLength={80} value={nombre} onChange={(e) => setNombre(e.target.value)} />
            </label>
          )}

          <div className={compartidos.formularioAcciones}>
            <button type="button" className={compartidos.secundario} onClick={alCancelar}>
              Cancelar
            </button>
            <button
              type="button"
              className={compartidos.primario}
              disabled={!elegida || !appSecret.trim() || ocupado !== null}
              onClick={() => void conectar()}
            >
              {ocupado === 'conectando'
                ? 'Verificando con Meta…'
                : esWhatsapp
                  ? 'Conectar este número'
                  : 'Conectar esta cuenta'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className={`${compartidos.aviso} ${compartidos.aviso_error}`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { PlataformaMeta } from '../../api/tipos.ts';
import { abrirVentanaDeMeta, cargarSdkDeMeta } from '../../vista/metaSdk.ts';
import compartidos from './ajustes.module.css';
import estilos from './ConectarCanal.module.css';

type Canal = 'whatsapp' | 'instagram' | 'facebook';

interface Opcion {
  /** En WhatsApp, `waba:numero`; en el resto, el id de la cuenta o la página. */
  clave: string;
  titulo: string;
  detalle: string;
  yaConectado: boolean;
}

interface Props {
  api: Api;
  canal: Canal;
  plataforma: PlataformaMeta;
  alCancelar: () => void;
  /** `aviso`: algo que decir después de conectar, cuando la pantalla ya cerró. */
  alConectar: (aviso?: string) => Promise<void>;
  /** Volver al formulario de pegar credenciales de una app propia. */
  alPegarCredenciales: () => void;
}

const TEXTOS = {
  whatsapp: {
    titulo: 'Conectar WhatsApp',
    boton: 'Conectar con Meta',
    elegir: 'Elige el número',
    conectar: 'Conectar este número',
    vacio: 'La cuenta que compartiste no tiene ningún número. Vuelve a intentarlo y elige uno.',
  },
  instagram: {
    titulo: 'Conectar Instagram',
    boton: 'Conectar con Facebook',
    elegir: 'Elige la cuenta',
    conectar: 'Conectar esta cuenta',
    vacio:
      'No aparece ninguna cuenta de Instagram. Tiene que ser profesional y estar vinculada a una de las páginas que elegiste.',
  },
  facebook: {
    titulo: 'Conectar Facebook',
    boton: 'Conectar con Facebook',
    elegir: 'Elige la página',
    conectar: 'Conectar esta página',
    vacio:
      'No aparece ninguna página. Vuelve a intentarlo y marca la página en la ventana de Meta.',
  },
} as const;

const mensajeDe = (e: unknown, porDefecto: string) =>
  e instanceof ErrorDeApi ? e.message : porDefecto;

/**
 * Conectar un canal con un botón, sin pegar nada (ADR-015).
 *
 * Abre la ventana de Meta. En WhatsApp, quien ya usa la app WhatsApp Business
 * en su celular escanea un código QR desde ella y el mismo número queda
 * también aquí: puede seguir contestando desde el teléfono.
 *
 * ## Lo que se dice ANTES de pulsar
 *
 * Conectar por QR tiene consecuencias en el celular del dueño que no se ven
 * hasta que es tarde —dejan de funcionar las listas de difusión, Meta avisa a
 * sus clientes, y hay que abrir la app cada dos semanas o se desconecta—. Van
 * escritas encima del botón, no en una ayuda plegada.
 *
 * ## El token no pasa por aquí
 *
 * La ventana devuelve un código; el servidor lo cambia por un token y manda de
 * vuelta la lista de cuentas y un sobre sellado. Este componente guarda el
 * sobre y lo devuelve al conectar. No puede abrirlo.
 */
export function ConectarConMeta({
  api,
  canal,
  plataforma,
  alCancelar,
  alConectar,
  alPegarCredenciales,
}: Props) {
  const textos = TEXTOS[canal];
  const esWhatsapp = canal === 'whatsapp';
  const configId = esWhatsapp ? plataforma.configWhatsapp : plataforma.configPaginas;

  const [listo, setListo] = useState(false);
  const [credencial, setCredencial] = useState<string | null>(null);
  const [opciones, setOpciones] = useState<Opcion[] | null>(null);
  const [elegida, setElegida] = useState<string | null>(null);
  const [nombre, setNombre] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<'meta' | 'buscando' | 'conectando' | null>(null);

  // El SDK se carga al abrir, no al pulsar: la ventana tiene que abrirse EN el
  // clic, y esperar a un script la convertiría en emergente bloqueada.
  useEffect(() => {
    if (!plataforma.appId) return;
    let vivo = true;
    cargarSdkDeMeta(plataforma.appId, plataforma.version)
      .then(() => vivo && setListo(true))
      .catch(() => vivo && setError('No se pudo cargar la ventana de Meta. Revisa tu conexión.'));
    return () => {
      vivo = false;
    };
  }, [plataforma.appId, plataforma.version]);

  function abrir() {
    if (!configId) return;
    setError(null);
    setOpciones(null);
    setElegida(null);
    setOcupado('meta');
    // Sin `await` antes de esta llamada: ver el comentario de `metaSdk.ts`.
    abrirVentanaDeMeta({ configId, whatsapp: esWhatsapp })
      .then(async (r) => {
        if (!r) return; // cerró la ventana: no es un error
        setOcupado('buscando');
        if (esWhatsapp) {
          if (!r.wabaId) {
            setError('Meta no dijo qué cuenta compartiste. Vuelve a pulsar «Conectar con Meta».');
            return;
          }
          const d = await api.sesionMetaWhatsapp({ code: r.code, wabaId: r.wabaId });
          setCredencial(d.credencial);
          const lista = d.cuentas.flatMap((w) =>
            w.numeros.map((n) => ({
              clave: `${w.wabaId}:${n.phoneNumberId}`,
              titulo: n.numero,
              detalle: [n.nombreVerificado, w.nombre].filter(Boolean).join(' · '),
              yaConectado: n.yaConectado,
            })),
          );
          setOpciones(lista);
          // Meta suele decir qué número fue; si no, y solo hay uno libre, ese.
          const libres = lista.filter((o) => !o.yaConectado);
          const dicho = libres.find((o) => o.clave.endsWith(`:${r.phoneNumberId}`));
          setElegida(dicho?.clave ?? (libres.length === 1 ? libres[0]!.clave : null));
          return;
        }
        const d = await api.sesionMetaPaginas({ code: r.code });
        setCredencial(d.credencial);
        const lista: Opcion[] =
          canal === 'instagram'
            ? d.instagram.map((c) => ({
                clave: c.igUserId,
                titulo: c.usuario ?? c.pagina,
                detalle: `Página de Facebook: ${c.pagina}`,
                yaConectado: c.yaConectado,
              }))
            : d.facebook.map((pg) => ({
                clave: pg.paginaId,
                titulo: pg.pagina,
                detalle: 'Messenger y comentarios de sus publicaciones',
                yaConectado: pg.yaConectado,
              }));
        setOpciones(lista);
        const libres = lista.filter((o) => !o.yaConectado);
        setElegida(libres.length === 1 ? libres[0]!.clave : null);
      })
      .catch((e: unknown) => setError(mensajeDe(e, 'No se pudo conectar con Meta.')))
      .finally(() => setOcupado(null));
  }

  async function conectar() {
    if (!elegida || !credencial) return;
    setOcupado('conectando');
    setError(null);
    const comunes = { credencial, ...(nombre.trim() ? { displayName: nombre.trim() } : {}) };
    try {
      if (esWhatsapp) {
        const [wabaId, phoneNumberId] = elegida.split(':') as [string, string];
        const r = await api.conectarWhatsapp({ phoneNumberId, wabaId, ...comunes });
        await alConectar(
          r.historialPedido === true
            ? 'Conectado. Estamos trayendo los chats que compartiste desde tu celular: van llegando durante las próximas horas. Deja abierta la app de WhatsApp Business mientras tanto.'
            : r.historialPedido === false
              ? 'Conectado, pero Meta no aceptó traer los chats antiguos. Los mensajes nuevos llegan con normalidad.'
              : undefined,
        );
      } else if (canal === 'instagram') {
        await api.conectarInstagram({ igUserId: elegida, ...comunes });
        await alConectar();
      } else {
        await api.conectarFacebook({ paginaId: elegida, ...comunes });
        await alConectar();
      }
    } catch (e) {
      setError(mensajeDe(e, 'No se pudo conectar. Revisa tu conexión.'));
    } finally {
      setOcupado(null);
    }
  }

  return (
    <div className={compartidos.formulario}>
      <div className={estilos.paso}>
        <h3 className={estilos.pasoTitulo}>{textos.titulo}</h3>
        {esWhatsapp ? (
          <>
            <p className={compartidos.descripcion}>
              Se abre una ventana de Meta. Si ya usas WhatsApp Business en tu celular, escaneas un
              código QR desde la app y el mismo número queda también aquí: puedes seguir contestando
              desde el teléfono.
            </p>
            <ul className={estilos.antes} aria-label="Antes de conectar">
              <li>Actualiza la app WhatsApp Business a la última versión.</li>
              <li>
                Meta te preguntará si compartes tus chats. Si aceptas, traemos tus contactos y hasta
                6 meses de conversaciones. Los grupos y los chats archivados no vienen.
              </li>
              <li>
                Abre la app del celular al menos una vez cada 14 días, o la conexión se corta.
              </li>
              <li>
                En el celular dejan de funcionar las listas de difusión, los mensajes temporales y
                los de ver una sola vez.
              </li>
              <li>Meta avisará a tus clientes de que sus chats pasan por un servicio de Meta.</li>
            </ul>
          </>
        ) : (
          <p className={compartidos.descripcion}>
            Se abre una ventana de Meta. Inicia sesión con el usuario que administra la página y
            marca cuáles compartes. No hay que copiar ningún token.
          </p>
        )}

        {opciones === null && (
          <div className={compartidos.formularioAcciones}>
            <button type="button" className={compartidos.secundario} onClick={alCancelar}>
              Cancelar
            </button>
            <button
              type="button"
              className={compartidos.primario}
              disabled={!listo || !configId || ocupado !== null}
              onClick={abrir}
            >
              {ocupado === 'meta'
                ? 'Esperando a Meta…'
                : ocupado === 'buscando'
                  ? 'Buscando tus cuentas…'
                  : !listo
                    ? 'Cargando…'
                    : textos.boton}
            </button>
          </div>
        )}
      </div>

      {opciones !== null && (
        <div className={estilos.paso}>
          {opciones.length === 0 ? (
            <p className={compartidos.vacio}>{textos.vacio}</p>
          ) : (
            <fieldset className={estilos.opciones}>
              <legend className={estilos.pasoTitulo}>{textos.elegir}</legend>
              {opciones.map((o) => (
                <label
                  key={o.clave}
                  className={`${estilos.opcion} ${elegida === o.clave ? estilos.opcionElegida : ''}`}
                >
                  <input
                    type="radio"
                    name={`meta-${canal}`}
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
            {opciones.length === 0 ? (
              <button type="button" className={compartidos.primario} onClick={abrir}>
                Volver a intentarlo
              </button>
            ) : (
              <button
                type="button"
                className={compartidos.primario}
                disabled={!elegida || ocupado !== null}
                onClick={() => void conectar()}
              >
                {ocupado === 'conectando' ? 'Conectando…' : textos.conectar}
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <p className={`${compartidos.aviso} ${compartidos.aviso_error}`} role="alert">
          {error}
        </p>
      )}

      <button type="button" className={estilos.otraForma} onClick={alPegarCredenciales}>
        Tengo mi propia app de Meta: prefiero pegar sus credenciales
      </button>
    </div>
  );
}

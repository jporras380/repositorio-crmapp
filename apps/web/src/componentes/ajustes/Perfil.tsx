import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { Perfil as Datos, SesionAbierta } from '../../api/tipos.ts';
import { hace } from '../../vista/tiempo.ts';
import estilos from './Perfil.module.css';

/**
 * Mi cuenta: quién soy, cómo entro, y desde dónde.
 *
 * ## Por qué el nombre y la foto van solos, y el correo no
 *
 * El nombre es cómo te ven tus compañeros; equivocarse cuesta un momento de
 * vergüenza. **El correo y la contraseña son las llaves de la cuenta**, así
 * que piden la contraseña de ahora: quien se deje la sesión abierta en el
 * ordenador de recepción no debería poder quedarse con ella para siempre.
 *
 * ## Las sesiones no son adorno
 *
 * Ver desde dónde se entró es lo único que permite reconocer lo que no es
 * tuyo. Y cerrarlas funciona de verdad desde 0033: antes el token valía hasta
 * caducar, pasara lo que pasara.
 */

interface Props {
  api: Api;
}

export function Perfil({ api }: Props) {
  const [datos, setDatos] = useState<Datos | null>(null);
  const [sesiones, setSesiones] = useState<SesionAbierta[]>([]);
  const [foto, setFoto] = useState<string | null>(null);
  const [nombre, setNombre] = useState('');
  const [aviso, setAviso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const archivo = useRef<HTMLInputElement>(null);

  const cargar = useCallback(async () => {
    const [p, s] = await Promise.all([api.perfil(), api.sesiones()]);
    setDatos(p);
    setNombre(p.nombre);
    setSesiones(s);
    if (p.fotoId) {
      try {
        setFoto((await api.urlDeMedio(p.fotoId)).url);
      } catch {
        setFoto(null);
      }
    } else {
      setFoto(null);
    }
  }, [api]);

  useEffect(() => {
    void cargar().catch(() => setError('No se pudo cargar tu perfil.'));
  }, [cargar]);

  async function guardarNombre() {
    if (!datos || nombre.trim() === datos.nombre) return;
    try {
      await api.editarPerfil({ nombre: nombre.trim() });
      setAviso('Nombre guardado.');
      await cargar();
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo guardar el nombre.');
    }
  }

  async function subirFoto(f: File) {
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
      await api.editarPerfil({ fotoId: mediaAssetId });
      await cargar();
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo subir la foto.');
    } finally {
      if (archivo.current) archivo.current.value = '';
    }
  }

  async function cerrar(id: string | 'otras') {
    try {
      await api.cerrarSesion(id);
      await cargar();
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo cerrar la sesión.');
    }
  }

  if (!datos) return <p className={estilos.cargando}>Cargando tu perfil…</p>;

  return (
    <div className={estilos.perfil}>
      <section className={estilos.bloque}>
        <h3 className={estilos.titulo}>Tu perfil</h3>
        <div className={estilos.identidad}>
          <span className={estilos.foto}>
            {foto ? (
              <img src={foto} alt="" className={estilos.fotoImg} />
            ) : (
              <span aria-hidden="true">{datos.nombre.charAt(0).toUpperCase()}</span>
            )}
          </span>
          <div className={estilos.acciones}>
            <button className={estilos.secundario} onClick={() => archivo.current?.click()}>
              {datos.fotoId ? 'Cambiar foto' : 'Subir foto'}
            </button>
            {datos.fotoId && (
              <button
                className={estilos.secundario}
                onClick={() => void api.editarPerfil({ fotoId: null }).then(cargar)}
              >
                Quitar
              </button>
            )}
            <input
              ref={archivo}
              type="file"
              className="visually-hidden"
              accept="image/*"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void subirFoto(f);
              }}
            />
          </div>
        </div>

        <label className={estilos.campo}>
          <span className={estilos.etiqueta}>Nombre</span>
          <input
            className={estilos.entrada}
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            onBlur={() => void guardarNombre()}
          />
        </label>
        <p className={estilos.pista}>
          Así te ven tus compañeros en el hilo y en el reparto. Se guarda al salir del campo.
        </p>
      </section>

      <CambiarAcceso api={api} email={datos.email} alHecho={cargar} />

      <DosPasos api={api} activo={datos.dobleFactor} alHecho={cargar} />

      <section className={estilos.bloque}>
        <h3 className={estilos.titulo}>Dónde has entrado</h3>
        <p className={estilos.pista}>
          Si no reconoces alguna, ciérrala. Su acceso deja de valer al momento.
        </p>
        <ul className={estilos.sesiones}>
          {sesiones.map((s) => (
            <li key={s.id} className={estilos.sesion}>
              <span className={estilos.sesionDatos}>
                <span className={estilos.dispositivo}>
                  {s.dispositivo ?? 'Dispositivo desconocido'}
                </span>
                <span className={estilos.pista}>
                  {s.ip ?? 'sin IP'} · {hace(s.ultimaVezEn) ?? 'ahora'}
                  {s.esLaActual ? ' · esta sesión' : ''}
                </span>
              </span>
              {!s.esLaActual && (
                <button className={estilos.secundario} onClick={() => void cerrar(s.id)}>
                  Cerrar
                </button>
              )}
            </li>
          ))}
        </ul>
        {sesiones.length > 1 && (
          <button className={estilos.secundario} onClick={() => void cerrar('otras')}>
            Cerrar todas menos esta
          </button>
        )}
      </section>

      {aviso && <p className={estilos.aviso}>{aviso}</p>}
      {error && (
        <p className={estilos.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Correo y contraseña, juntos porque los dos piden la contraseña de ahora. */
function CambiarAcceso({
  api,
  email,
  alHecho,
}: {
  api: Api;
  email: string;
  alHecho: () => Promise<void>;
}) {
  const [actual, setActual] = useState('');
  const [correo, setCorreo] = useState(email);
  const [nueva, setNueva] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [resultado, setResultado] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function guardar() {
    setOcupado(true);
    setError(null);
    setResultado(null);
    try {
      const r = await api.cambiarAcceso({
        contrasenaActual: actual,
        ...(correo.trim() && correo.trim() !== email ? { email: correo.trim() } : {}),
        ...(nueva ? { contrasenaNueva: nueva } : {}),
      });
      setResultado(
        r.sesionesCerradas > 0
          ? `Hecho. Se cerraron ${r.sesionesCerradas} sesión(es) en otros dispositivos.`
          : 'Hecho.',
      );
      setActual('');
      setNueva('');
      await alHecho();
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo cambiar.');
    } finally {
      setOcupado(false);
    }
  }

  const cambiaAlgo = (correo.trim() !== '' && correo.trim() !== email) || nueva !== '';

  return (
    <section className={estilos.bloque}>
      <h3 className={estilos.titulo}>Correo y contraseña</h3>
      <p className={estilos.pista}>
        Son las llaves de tu cuenta, así que hace falta la contraseña de ahora. Cambiarla cierra las
        sesiones de los demás dispositivos.
      </p>

      <label className={estilos.campo}>
        <span className={estilos.etiqueta}>Correo</span>
        <input
          className={estilos.entrada}
          value={correo}
          onChange={(e) => setCorreo(e.target.value)}
        />
      </label>
      <label className={estilos.campo}>
        <span className={estilos.etiqueta}>Contraseña nueva (opcional)</span>
        <input
          className={estilos.entrada}
          type="password"
          value={nueva}
          placeholder="Al menos 12 caracteres"
          onChange={(e) => setNueva(e.target.value)}
        />
      </label>
      <label className={estilos.campo}>
        <span className={estilos.etiqueta}>Contraseña actual</span>
        <input
          className={estilos.entrada}
          type="password"
          value={actual}
          onChange={(e) => setActual(e.target.value)}
        />
      </label>

      <button
        className={estilos.primario}
        onClick={() => void guardar()}
        disabled={ocupado || !actual || !cambiaAlgo}
      >
        {ocupado ? 'Guardando…' : 'Guardar cambios'}
      </button>

      {resultado && <p className={estilos.aviso}>{resultado}</p>}
      {error && (
        <p className={estilos.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * Verificación en dos pasos.
 *
 * ## Por qué no hay código QR
 *
 * Pintar un QR en el navegador exige una librería, y el acuerdo de este
 * proyecto es no meter dependencias por comodidad. Las aplicaciones de
 * autenticación (Google Authenticator, Authy, 1Password, el gestor del
 * propio móvil) aceptan todas escribir la clave a mano. Cuesta veinte
 * segundos una sola vez. Está apuntado como pendiente, no como olvido.
 *
 * ## Por qué los códigos de recuperación se enseñan una vez
 *
 * Se guardan hasheados, igual que las contraseñas: ni el servidor puede
 * volver a leerlos. Es incómodo a propósito — si el CRM pudiera enseñarlos
 * otra vez, quien entrara al CRM también podría.
 */
function DosPasos({
  api,
  activo,
  alHecho,
}: {
  api: Api;
  activo: boolean;
  alHecho: () => Promise<void>;
}) {
  const [preparado, setPreparado] = useState<{ secreto: string; enlace: string } | null>(null);
  const [codigo, setCodigo] = useState('');
  const [recuperacion, setRecuperacion] = useState<string[] | null>(null);
  const [quitando, setQuitando] = useState(false);
  const [contrasena, setContrasena] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function fallo(e: unknown, porDefecto: string) {
    setError(e instanceof ErrorDeApi ? e.message : porDefecto);
  }

  async function preparar() {
    setError(null);
    setOcupado(true);
    try {
      setPreparado(await api.prepararDosPasos());
    } catch (e) {
      fallo(e, 'No se pudo preparar la verificación.');
    } finally {
      setOcupado(false);
    }
  }

  async function confirmar() {
    setError(null);
    setOcupado(true);
    try {
      const r = await api.confirmarDosPasos(codigo.trim());
      setRecuperacion(r.codigosDeRecuperacion);
      setPreparado(null);
      setCodigo('');
      await alHecho();
    } catch (e) {
      fallo(e, 'No se pudo activar la verificación.');
      setCodigo('');
    } finally {
      setOcupado(false);
    }
  }

  async function quitar() {
    setError(null);
    setOcupado(true);
    try {
      await api.quitarDosPasos(contrasena);
      setQuitando(false);
      setContrasena('');
      setRecuperacion(null);
      await alHecho();
    } catch (e) {
      fallo(e, 'No se pudo desactivar la verificación.');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <section className={estilos.bloque}>
      <h3 className={estilos.titulo}>Verificación en dos pasos</h3>
      <p className={estilos.pista}>
        {activo
          ? 'Activada. Al entrar se te pedirá un código de tu aplicación de autenticación.'
          : 'Una contraseña robada basta para entrar. Con esto, además hace falta tu móvil.'}
      </p>

      {/* Los códigos recién generados mandan sobre todo lo demás: si se van de
          la pantalla sin copiarlos, no vuelven. */}
      {recuperacion && (
        <div className={estilos.recuperacion}>
          <p className={estilos.avisoFuerte}>
            Guarda estos códigos ahora. Es la única vez que se muestran, y son lo único que te deja
            entrar si pierdes el móvil.
          </p>
          <ul className={estilos.codigos}>
            {recuperacion.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className={estilos.acciones}>
            <button
              className={estilos.secundario}
              onClick={() => void navigator.clipboard.writeText(recuperacion.join('\n'))}
            >
              Copiar los ocho
            </button>
            <button className={estilos.primario} onClick={() => setRecuperacion(null)}>
              Ya los guardé
            </button>
          </div>
        </div>
      )}

      {!activo && !preparado && !recuperacion && (
        <button className={estilos.primario} onClick={() => void preparar()} disabled={ocupado}>
          {ocupado ? 'Preparando…' : 'Activar'}
        </button>
      )}

      {preparado && (
        <div className={estilos.preparado}>
          <p className={estilos.pista}>
            Escribe esta clave en tu aplicación de autenticación y luego teclea el código que te dé.
            (Todavía no está activada: si cierras aquí, nada cambia.)
          </p>
          <code className={estilos.secreto}>{enGrupos(preparado.secreto)}</code>
          <div className={estilos.acciones}>
            <button
              className={estilos.secundario}
              onClick={() => void navigator.clipboard.writeText(preparado.secreto)}
            >
              Copiar la clave
            </button>
            {/* Desde el móvil, el enlace abre la app y la configura sin teclear. */}
            <a className={estilos.secundario} href={preparado.enlace}>
              Abrir en la app
            </a>
          </div>
          <p className={estilos.pistaMenor}>
            Todavía no hay código QR: pintarlo exigiría una librería nueva. Todas las aplicaciones
            aceptan la clave escrita a mano.
          </p>
          <label className={estilos.campo}>
            <span className={estilos.etiqueta}>Código de la aplicación</span>
            <input
              className={`${estilos.entrada} ${estilos.entradaCodigo}`}
              autoComplete="one-time-code"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
            />
          </label>
          <button
            className={estilos.primario}
            onClick={() => void confirmar()}
            disabled={ocupado || codigo.trim().length < 6}
          >
            {ocupado ? 'Comprobando…' : 'Confirmar y activar'}
          </button>
        </div>
      )}

      {activo &&
        !recuperacion &&
        (quitando ? (
          <div className={estilos.preparado}>
            <label className={estilos.campo}>
              <span className={estilos.etiqueta}>Tu contraseña</span>
              <input
                className={estilos.entrada}
                type="password"
                autoComplete="current-password"
                value={contrasena}
                onChange={(e) => setContrasena(e.target.value)}
              />
            </label>
            <p className={estilos.pistaMenor}>
              Se pide la contraseña porque si no, una sesión olvidada abierta bastaría para quitar
              la protección.
            </p>
            <div className={estilos.acciones}>
              <button
                className={estilos.secundario}
                onClick={() => {
                  setQuitando(false);
                  setContrasena('');
                  setError(null);
                }}
              >
                Dejarlo como está
              </button>
              <button
                className={estilos.primario}
                onClick={() => void quitar()}
                disabled={ocupado || !contrasena}
              >
                {ocupado ? 'Quitando…' : 'Desactivar'}
              </button>
            </div>
          </div>
        ) : (
          <button className={estilos.secundario} onClick={() => setQuitando(true)}>
            Desactivar
          </button>
        ))}

      {error && (
        <p className={estilos.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** La clave en grupos de cuatro: así se copia a mano sin perder la cuenta. */
function enGrupos(secreto: string): string {
  return (secreto.match(/.{1,4}/g) ?? [secreto]).join(' ');
}

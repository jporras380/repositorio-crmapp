import { useState, type FormEvent } from 'react';
import { crearApi, ErrorDeApi } from '../../api/cliente.ts';
import type { Sesion } from '../../api/tipos.ts';
import estilos from './Acceso.module.css';

/**
 * Entrar.
 *
 * ## Por qué el código va en un segundo paso y no en el mismo formulario
 *
 * Un campo «código» siempre visible confunde a las nueve de cada diez cuentas
 * que no tienen segundo factor: parece obligatorio y no lo es. Además, el
 * código de una app de autenticación caduca cada 30 segundos — pedirlo antes
 * de escribir la contraseña es pedir uno que ya habrá vencido.
 *
 * Así que el servidor manda: si contesta `codigo_requerido`, la contraseña
 * era buena y solo falta el segundo factor.
 */

interface Props {
  alEntrar: (sesion: Sesion) => void;
}

export function Acceso({ alEntrar }: Props) {
  const [email, setEmail] = useState('');
  const [contrasena, setContrasena] = useState('');
  const [codigo, setCodigo] = useState('');
  const [pideCodigo, setPideCodigo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function entrar(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      const s = await crearApi(null).iniciarSesion(email, contrasena, codigo.trim() || undefined);
      alEntrar({ token: s.token, tenantId: s.tenantId, userId: s.userId, rol: s.rol });
    } catch (err) {
      if (err instanceof ErrorDeApi && err.codigo === 'codigo_requerido') {
        // La contraseña era buena. No es un error que haya que enseñar como
        // tal: es el siguiente paso.
        setPideCodigo(true);
      } else {
        setError(
          err instanceof ErrorDeApi
            ? err.message
            : 'No se pudo conectar con el servidor. Reintenta.',
        );
        if (err instanceof ErrorDeApi && err.codigo === 'codigo_invalido') setCodigo('');
      }
    } finally {
      setEnviando(false);
    }
  }

  function volverAEmpezar() {
    setPideCodigo(false);
    setCodigo('');
    setError(null);
  }

  return (
    <main className={estilos.pantalla}>
      <form className={`glass-strong ${estilos.tarjeta}`} onSubmit={entrar} noValidate>
        <div className={estilos.marca} aria-hidden="true">
          <span className={estilos.marcaPunto} />
        </div>

        {pideCodigo ? (
          <>
            <h1 className={estilos.titulo}>Confirma que eres tú</h1>
            <p className={estilos.subtitulo}>
              Escribe el código de tu aplicación de autenticación. Si perdiste el móvil, sirve uno
              de los códigos de recuperación que guardaste.
            </p>
            <label className={estilos.campo}>
              <span>Código</span>
              <input
                className={estilos.codigo}
                name="codigo"
                /* `one-time-code` hace que el móvil lo ofrezca del teclado. */
                autoComplete="one-time-code"
                inputMode="text"
                autoFocus
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
                required
              />
            </label>
          </>
        ) : (
          <>
            <h1 className={estilos.titulo}>Entra a tu bandeja</h1>
            <p className={estilos.subtitulo}>Todas tus conversaciones, en un solo lugar.</p>
            <label className={estilos.campo}>
              <span>Correo</span>
              <input
                type="email"
                name="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label className={estilos.campo}>
              <span>Contraseña</span>
              <input
                type="password"
                name="contrasena"
                autoComplete="current-password"
                value={contrasena}
                onChange={(e) => setContrasena(e.target.value)}
                required
              />
            </label>
          </>
        )}

        {error && (
          <p className={estilos.error} role="alert">
            {error}
          </p>
        )}

        <button className={estilos.boton} type="submit" disabled={enviando}>
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>

        {pideCodigo && (
          <button className={estilos.volver} type="button" onClick={volverAEmpezar}>
            Usar otra cuenta
          </button>
        )}
      </form>
    </main>
  );
}

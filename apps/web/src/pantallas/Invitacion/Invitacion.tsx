import { useState, type FormEvent } from 'react';
import { crearApi, ErrorDeApi } from '../../api/cliente.ts';
import type { Sesion } from '../../api/tipos.ts';
import estilos from './Invitacion.module.css';

/**
 * Entrar a una cuenta a la que te han invitado.
 *
 * ## Por qué faltaba esto
 *
 * La API aceptaba invitaciones desde fase 0 —crea el usuario si no existe, lo
 * da de alta en la cuenta y devuelve sesión— y **no había ninguna pantalla
 * que llamara a esa ruta**. El enlace no llevaba a ningún sitio, así que en
 * la práctica no se podía dar de alta a un compañero.
 *
 * ## Por qué va antes de la comprobación de sesión
 *
 * Igual que el alta: quien acepta una invitación **todavía no tiene cuenta**.
 * Mandarlo al formulario de acceso es pedirle una contraseña que aún no
 * existe.
 *
 * ## Por qué no se pide el correo
 *
 * El correo ya está en la invitación, y es el que eligió quien invitó. Pedirlo
 * otra vez solo abre la puerta a escribir uno distinto del que se aprobó.
 */

interface Props {
  token: string;
  alEntrar: (sesion: Sesion) => void;
  /** Para quien llega con un enlace roto: la puerta normal sigue ahí. */
  alVolver: () => void;
}

/** Igual que en el alta: por debajo de esto no lo acepta el servidor. */
const MINIMO_DE_CONTRASENA = 10;

export function Invitacion({ token, alEntrar, alVolver }: Props) {
  const [nombreCompleto, setNombre] = useState('');
  const [contrasena, setContrasena] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const corta = contrasena.length > 0 && contrasena.length < MINIMO_DE_CONTRASENA;

  async function entrar(e: FormEvent) {
    e.preventDefault();
    if (corta) return;
    setOcupado(true);
    setError(null);
    try {
      const s = await crearApi(null).aceptarInvitacion({
        token,
        contrasena,
        nombreCompleto: nombreCompleto.trim(),
      });
      // Se entra directo: aceptar ya devuelve sesión, y mandar al formulario
      // de acceso sería pedir la contraseña recién escrita.
      alEntrar(s);
    } catch (err) {
      setError(err instanceof ErrorDeApi ? err.message : 'No se pudo entrar con esa invitación.');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className={estilos.pantalla}>
      <main className={`glass ${estilos.tarjeta}`}>
        <h1 className={estilos.titulo}>Te han invitado</h1>
        <p className={estilos.subtitulo}>
          Elige tu contraseña y entras. Tu correo ya está en la invitación.
        </p>

        {error && (
          <p className={estilos.error} role="alert">
            {error}
          </p>
        )}

        <form className={estilos.formulario} onSubmit={entrar}>
          <label className={estilos.campo}>
            Tu nombre
            <input
              value={nombreCompleto}
              required
              minLength={2}
              maxLength={120}
              autoComplete="name"
              placeholder="Rosa Quispe"
              onChange={(e) => setNombre(e.target.value)}
            />
            {/* Es el nombre que verá el resto del equipo al asignar una
                conversación, no un dato administrativo. */}
            <span className={estilos.ayuda}>Así te verán tus compañeros en la bandeja.</span>
          </label>

          <label className={estilos.campo}>
            Contraseña
            <input
              type="password"
              value={contrasena}
              required
              minLength={MINIMO_DE_CONTRASENA}
              autoComplete="new-password"
              onChange={(e) => setContrasena(e.target.value)}
            />
            <span className={corta ? estilos.ayudaMal : estilos.ayuda}>
              Al menos {MINIMO_DE_CONTRASENA} caracteres.
            </span>
          </label>

          <div className={estilos.acciones}>
            <button className={estilos.entrar} disabled={ocupado || corta}>
              {ocupado ? 'Entrando…' : 'Entrar'}
            </button>
          </div>
        </form>

        <p className={estilos.pie}>
          <button type="button" className={estilos.enlace} onClick={alVolver}>
            Ya tengo cuenta
          </button>
        </p>
      </main>
    </div>
  );
}

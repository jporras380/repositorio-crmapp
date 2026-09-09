import { useState, type FormEvent } from 'react';
import { crearApi, ErrorDeApi } from '../../api/cliente.ts';
import type { Sesion } from '../../api/tipos.ts';
import estilos from './Acceso.module.css';

interface Props {
  alEntrar: (sesion: Sesion) => void;
}

export function Acceso({ alEntrar }: Props) {
  const [email, setEmail] = useState('');
  const [contrasena, setContrasena] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function entrar(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      const s = await crearApi(null).iniciarSesion(email, contrasena);
      alEntrar({ token: s.token, tenantId: s.tenantId, userId: s.userId, rol: s.rol });
    } catch (err) {
      setError(
        err instanceof ErrorDeApi ? err.message : 'No se pudo conectar con el servidor. Reintenta.',
      );
    } finally {
      setEnviando(false);
    }
  }

  return (
    <main className={estilos.pantalla}>
      <form className={`glass-strong ${estilos.tarjeta}`} onSubmit={entrar} noValidate>
        <div className={estilos.marca} aria-hidden="true">
          <span className={estilos.marcaPunto} />
        </div>
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

        {error && (
          <p className={estilos.error} role="alert">
            {error}
          </p>
        )}

        <button className={estilos.boton} type="submit" disabled={enviando}>
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </main>
  );
}

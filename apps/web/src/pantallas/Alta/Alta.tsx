import { useEffect, useState, type FormEvent } from 'react';
import { crearApi, ErrorDeApi } from '../../api/cliente.ts';
import type { PlanPublico, Sesion } from '../../api/tipos.ts';
import { importe } from '../../vista/dinero.ts';
import estilos from './Alta.module.css';

/**
 * Darse de alta: elegir plan y crear la cuenta.
 *
 * Hasta ahora la API sabía crear una cuenta entera —inquilino, dueño,
 * suscripción en prueba, embudo sembrado— y **no había forma de llegar a
 * ella**: la única puerta de la web era el formulario de acceso, así que dar
 * de alta a un cliente exigía consola. Esto es lo que hace falta antes de
 * poder vender a nadie.
 *
 * ## Por qué el plan se elige primero y el formulario después
 *
 * Quien llega no sabe todavía si le sirve. Pedir correo y contraseña antes de
 * enseñar el precio es el orden de quien quiere capturar un contacto, no el
 * de quien quiere que le compren. Primero qué cuesta y qué incluye; después,
 * cinco campos.
 *
 * ## Por qué se entra directo y no se manda a iniciar sesión
 *
 * El alta ya devuelve una sesión. Mandar a la pantalla de acceso después de
 * registrarse es pedir la contraseña que la persona acaba de escribir.
 */

interface Props {
  alEntrar: (sesion: Sesion) => void;
  /** Volver al formulario de acceso: quien ya es cliente llegó aquí por error. */
  alVolver: () => void;
}

export function Alta({ alEntrar, alVolver }: Props) {
  const [planes, setPlanes] = useState<PlanPublico[] | null>(null);
  const [elegido, setElegido] = useState<PlanPublico | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    crearApi(null)
      .planes()
      .then(setPlanes)
      .catch(() => setError('No se pudieron cargar los planes. Reintenta en un momento.'));
  }, []);

  return (
    <main className={estilos.pantalla}>
      <header className={estilos.cabecera}>
        <h1 className={estilos.titulo}>
          {elegido ? `Crea tu cuenta · plan ${elegido.nombre}` : 'Elige tu plan'}
        </h1>
        <p className={estilos.subtitulo}>
          {elegido
            ? `${elegido.mesesDePrueba === 1 ? 'Un mes' : `${elegido.mesesDePrueba} meses`} de prueba. No se pide tarjeta.`
            : 'Todos incluyen prueba sin tarjeta. Se paga por asiento ocupado, no por asiento contratado.'}
        </p>
      </header>

      {error && (
        <p className={estilos.error} role="alert">
          {error}
        </p>
      )}

      {!elegido && (
        <div className={estilos.planes}>
          {planes?.map((p) => (
            <Plan key={p.codigo} plan={p} alElegir={() => setElegido(p)} />
          ))}
        </div>
      )}

      {elegido && (
        <Formulario plan={elegido} alEntrar={alEntrar} alCambiarDePlan={() => setElegido(null)} />
      )}

      <p className={estilos.pie}>
        ¿Ya tienes cuenta?{' '}
        <button type="button" className={estilos.enlace} onClick={alVolver}>
          Entra aquí
        </button>
      </p>
    </main>
  );
}

/** Nombres de los topes, en el idioma de quien compra y no en el de la tabla. */
const LIMITE: Record<string, string> = {
  agentes: 'agentes',
  canales: 'canales conectados',
  conversaciones_mes: 'conversaciones al mes',
  bot_runs_mes: 'ejecuciones de bot al mes',
  creditos_ia_mes: 'borradores de IA al mes',
};

function Plan({ plan, alElegir }: { plan: PlanPublico; alElegir: () => void }) {
  return (
    <article className={`glass ${estilos.plan}`}>
      <h2 className={estilos.planNombre}>{plan.nombre}</h2>
      <p className={estilos.precio}>
        {importe(plan.precioPorAsientoCentimos, plan.moneda)}
        <span className={estilos.porAsiento}>por asiento al mes</span>
      </p>
      {/*
        Los topes van con el precio y no en una tabla comparativa aparte:
        elegir plan sin saber qué incluye es elegir a ciegas, y el tope se
        descubre el mes siguiente con el equipo ya dentro.
      */}
      <ul className={estilos.limites}>
        {Object.entries(plan.limites).map(([clave, valor]) => (
          <li key={clave}>
            <strong>{valor.toLocaleString('es-PE')}</strong> {LIMITE[clave] ?? clave}
          </li>
        ))}
      </ul>
      <button className={estilos.elegir} onClick={alElegir}>
        Elegir {plan.nombre}
      </button>
    </article>
  );
}

/** `Hotel El Paraíso` → `hotel-el-paraiso`. Lo que nadie quiere teclear a mano. */
export function comoIdentificador(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function Formulario({
  plan,
  alEntrar,
  alCambiarDePlan,
}: {
  plan: PlanPublico;
  alEntrar: (s: Sesion) => void;
  alCambiarDePlan: () => void;
}) {
  const [nombreDeCuenta, setNombreDeCuenta] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTocado, setSlugTocado] = useState(false);
  const [disponible, setDisponible] = useState<{ libre: boolean; motivo: string | null } | null>(
    null,
  );
  const [nombreCompleto, setNombreCompleto] = useState('');
  const [email, setEmail] = useState('');
  const [contrasena, setContrasena] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  // El identificador se deriva del nombre mientras nadie lo toque a mano.
  // Quien quiera otro lo escribe y deja de seguir al nombre.
  const identificador = slugTocado ? slug : comoIdentificador(nombreDeCuenta);

  useEffect(() => {
    if (identificador.length < 2) {
      setDisponible(null);
      return;
    }
    // Se pregunta mientras se escribe, con una espera: descubrir que está
    // ocupado DESPUÉS de rellenar cinco campos y una contraseña es la forma
    // más rápida de perder a alguien que ya había decidido comprar.
    const id = setTimeout(() => {
      crearApi(null)
        .slugDisponible(identificador)
        .then(setDisponible)
        .catch(() => setDisponible(null));
    }, 400);
    return () => clearTimeout(id);
  }, [identificador]);

  async function crear(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      const s = await crearApi(null).crearCuenta({
        nombreDeCuenta: nombreDeCuenta.trim(),
        slug: identificador,
        email: email.trim(),
        contrasena,
        nombreCompleto: nombreCompleto.trim(),
        planCode: plan.codigo,
      });
      alEntrar({ token: s.token, tenantId: s.tenantId, userId: s.userId, rol: s.rol });
    } catch (err) {
      setError(err instanceof ErrorDeApi ? err.message : 'No se pudo crear la cuenta. Reintenta.');
    } finally {
      setEnviando(false);
    }
  }

  const cortaLaContrasena = contrasena.length > 0 && contrasena.length < 10;

  return (
    <form className={`glass-strong ${estilos.formulario}`} onSubmit={crear} noValidate>
      <label className={estilos.campo}>
        <span>Nombre del negocio</span>
        <input
          required
          maxLength={100}
          value={nombreDeCuenta}
          onChange={(e) => setNombreDeCuenta(e.target.value)}
          placeholder="Apart Hotel El Paraíso"
        />
      </label>

      <label className={estilos.campo}>
        <span>Identificador de la cuenta</span>
        <input
          required
          value={identificador}
          onChange={(e) => {
            setSlugTocado(true);
            setSlug(comoIdentificador(e.target.value));
          }}
        />
        <span className={estilos.ayuda}>
          {disponible?.motivo === 'formato'
            ? 'Entre 3 y 40 caracteres: letras, números y guiones.'
            : disponible?.libre === false
              ? 'Ya hay una cuenta con ese identificador. Prueba otro.'
              : disponible?.libre
                ? 'Libre.'
                : 'Se saca del nombre; puedes cambiarlo.'}
        </span>
      </label>

      <label className={estilos.campo}>
        <span>Tu nombre</span>
        <input
          required
          maxLength={120}
          value={nombreCompleto}
          onChange={(e) => setNombreCompleto(e.target.value)}
        />
      </label>

      <label className={estilos.campo}>
        <span>Correo</span>
        <input
          required
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>

      <label className={estilos.campo}>
        <span>Contraseña</span>
        <input
          required
          type="password"
          autoComplete="new-password"
          value={contrasena}
          onChange={(e) => setContrasena(e.target.value)}
        />
        {/* Se dice el mínimo ANTES de enviar, no después de rechazarlo. */}
        <span className={cortaLaContrasena ? estilos.ayudaMal : estilos.ayuda}>
          Al menos 10 caracteres.
        </span>
      </label>

      {error && (
        <p className={estilos.error} role="alert">
          {error}
        </p>
      )}

      <div className={estilos.acciones}>
        <button type="button" className={estilos.secundario} onClick={alCambiarDePlan}>
          Cambiar de plan
        </button>
        <button
          type="submit"
          className={estilos.elegir}
          disabled={enviando || disponible?.libre === false || cortaLaContrasena}
        >
          {enviando ? 'Creando…' : 'Crear cuenta'}
        </button>
      </div>
    </form>
  );
}

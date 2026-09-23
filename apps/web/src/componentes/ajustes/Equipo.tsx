import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { Equipo as EquipoDeLaCuenta, Miembro } from '../../api/tipos.ts';
import { faltan } from '../../vista/tiempo.ts';
import estilos from './ajustes.module.css';
import propios from './Equipo.module.css';

/**
 * Las personas que usan esta cuenta.
 *
 * ## Por qué faltaba
 *
 * El plan se vende por agentes —Growth incluye 10— y la API sabía invitar
 * desde fase 0, con su límite de asientos y sus cuatro roles. **Lo que no
 * existía era la pantalla**: un cliente que pagaba por diez solo podía usar
 * uno, y dar de alta al segundo exigía entrar a la base de datos.
 *
 * Lo encontró el usuario preguntando dónde estaba, no una guarda. La de
 * «declarado y sin usar» vigila métodos del cliente web que nadie llama, y
 * aquí el método ni se había escrito.
 *
 * ## Por qué el enlace se copia y no se envía por correo
 *
 * Mandar el correo exige contratar un proveedor de envío, verificar el
 * dominio y montar SPF y DKIM: coste recurrente y trabajo de infraestructura
 * antes de que sirva de nada. Copiar el enlace y pasarlo por WhatsApp
 * funciona hoy, y es como se comunica de verdad este equipo.
 *
 * El token aparece **una sola vez**, al crear la invitación: en la base solo
 * queda su hash. Si se pierde, se cancela y se invita de nuevo.
 *
 * ## Por qué las invitaciones pendientes ocupan asiento
 *
 * Si no contaran, la pantalla diría «te quedan 7» con tres enlaces dando
 * vueltas, y el aviso llegaría cuando ya no se puede deshacer. Por eso hay
 * un botón de retirar: un correo mal escrito bloquearía una plaza siete días.
 */

interface Props {
  api: Api;
  /** Solo owner o admin; el resto no llega ni a ver esta sección. */
  gestor: boolean;
}

/**
 * Qué puede hacer cada rol, en las palabras de quien lo elige.
 *
 * No son etiquetas decorativas: la API las aplica en dieciséis servicios. Se
 * explican aquí porque elegir «supervisor» sin saber qué abre es elegir a
 * ciegas, y quien invita decide sobre la correspondencia de sus huéspedes.
 */
const ROLES: { valor: Miembro['rol']; nombre: string; explica: string }[] = [
  {
    valor: 'agent',
    nombre: 'Agente',
    explica: 'Atiende conversaciones. No toca canales, plantillas ni ajustes de la cuenta.',
  },
  {
    valor: 'supervisor',
    nombre: 'Supervisor',
    explica: 'Todo lo del agente, y además edita contactos, plantillas y respuestas rápidas.',
  },
  {
    valor: 'admin',
    nombre: 'Administrador',
    explica: 'Gestiona la cuenta entera: canales, equipo, IA y quién puede mirar la bandeja.',
  },
];

const NOMBRE_DE_ROL: Record<string, string> = {
  owner: 'Propietario',
  admin: 'Administrador',
  supervisor: 'Supervisor',
  agent: 'Agente',
};

export function Equipo({ api, gestor }: Props) {
  const [equipo, setEquipo] = useState<EquipoDeLaCuenta | null>(null);
  const [email, setEmail] = useState('');
  const [rol, setRol] = useState<Miembro['rol']>('agent');
  const [enlace, setEnlace] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      setEquipo(await api.equipo());
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo cargar el equipo.');
    }
  }, [api]);
  useEffect(() => void cargar(), [cargar]);

  async function invitar(e: FormEvent) {
    e.preventDefault();
    const correo = email.trim();
    if (!correo) return;
    setOcupado(true);
    setError(null);
    setEnlace(null);
    setCopiado(false);
    try {
      const { token } = await api.invitar(correo, rol);
      // El enlace se arma aquí con el origen real: si se guardara en el
      // servidor habría que configurarle la URL pública, y en desarrollo
      // apuntaría a producción.
      setEnlace(`${location.origin}/#invitacion=${encodeURIComponent(token)}`);
      setEmail('');
      await cargar();
    } catch (err) {
      setError(err instanceof ErrorDeApi ? err.message : 'No se pudo invitar.');
    } finally {
      setOcupado(false);
    }
  }

  async function cancelar(id: string) {
    setError(null);
    try {
      await api.cancelarInvitacion(id);
      await cargar();
    } catch (err) {
      setError(err instanceof ErrorDeApi ? err.message : 'No se pudo retirar.');
    }
  }

  async function copiar() {
    if (!enlace) return;
    try {
      await navigator.clipboard.writeText(enlace);
      setCopiado(true);
    } catch {
      // Sin permiso de portapapeles el enlace sigue a la vista y se
      // selecciona a mano. No es un error que merezca una alerta.
      setCopiado(false);
    }
  }

  const asientos = equipo?.asientos;
  const lleno = asientos ? asientos.tope !== null && asientos.ocupados >= asientos.tope : false;

  return (
    <section className={estilos.seccion}>
      <header className={estilos.cabecera}>
        <div>
          <h2 className={estilos.titulo}>Equipo</h2>
          <p className={estilos.descripcion}>
            Las personas que entran a esta cuenta. Cada una con su usuario y su contraseña, y con lo
            que puede hacer según su rol.
          </p>
        </div>
      </header>

      {error && (
        <p className={`${estilos.aviso} ${estilos.aviso_error}`} role="alert">
          {error}
        </p>
      )}

      {!gestor && (
        <p className={estilos.descripcion}>Solo el propietario o un administrador gestiona esto.</p>
      )}

      {/* Cuánto sitio queda, arriba: es lo que decide si se puede invitar a
          alguien más, y enterarse DESPUÉS de escribir el correo es peor. */}
      {asientos && (
        <p className={`${estilos.aviso} ${lleno ? estilos.aviso_error : estilos.aviso_info}`}>
          {asientos.tope === null
            ? `${asientos.ocupados} en el equipo. Tu plan no limita los asientos.`
            : `${asientos.ocupados} de ${asientos.tope} asientos usados.`}
          {lleno && ' Para invitar a alguien más, sube de plan.'}
        </p>
      )}

      {gestor && (
        <form className={estilos.formulario} onSubmit={invitar}>
          <div className={estilos.campos}>
            <label className={estilos.campo}>
              Correo de la persona
              <input
                type="email"
                value={email}
                required
                disabled={ocupado || lleno}
                placeholder="rosa@elparaiso.pe"
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className={estilos.campo}>
              Qué podrá hacer
              <select
                value={rol}
                disabled={ocupado || lleno}
                onChange={(e) => setRol(e.target.value as Miembro['rol'])}
              >
                {ROLES.map((r) => (
                  <option key={r.valor} value={r.valor}>
                    {r.nombre}
                  </option>
                ))}
              </select>
              {/* La explicación del rol elegido, aquí y no en una ayuda
                  aparte: elegir «supervisor» sin saber qué abre es elegir a
                  ciegas. */}
              <span className={estilos.ayuda}>{ROLES.find((r) => r.valor === rol)?.explica}</span>
            </label>
          </div>
          <div className={estilos.formularioAcciones}>
            <button className={estilos.primario} disabled={ocupado || lleno}>
              {ocupado ? 'Creando…' : 'Crear invitación'}
            </button>
          </div>
        </form>
      )}

      {/* El token se ve UNA vez: en la base solo queda su hash. */}
      {enlace && (
        <div className={`${estilos.aviso} ${estilos.aviso_ok}`}>
          <p className={propios.enlaceTitulo}>
            Pásale este enlace a la persona. No se vuelve a mostrar.
          </p>
          <code className={propios.enlace}>{enlace}</code>
          <div className={estilos.formularioAcciones}>
            <button type="button" className={estilos.secundario} onClick={() => void copiar()}>
              {copiado ? 'Copiado' : 'Copiar enlace'}
            </button>
          </div>
        </div>
      )}

      <h3 className={estilos.tarjetaTitulo}>Quién está dentro</h3>
      <div className={estilos.tablaEnvoltorio}>
        <table className={estilos.tabla}>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Correo</th>
              <th>Rol</th>
            </tr>
          </thead>
          <tbody>
            {(equipo?.miembros ?? []).map((m) => (
              <tr key={m.id}>
                <td>
                  {m.nombre}
                  {m.esTu && <span className={propios.tu}>tú</span>}
                </td>
                <td>{m.email}</td>
                <td>{NOMBRE_DE_ROL[m.rol] ?? m.rol}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {equipo && equipo.invitaciones.length > 0 && (
        <>
          <h3 className={estilos.tarjetaTitulo}>Invitados, sin entrar todavía</h3>
          <p className={estilos.descripcion}>
            Cada uno ocupa un asiento mientras el enlace siga vivo. Si te equivocaste de correo,
            retíralo y vuelve a invitar.
          </p>
          <div className={estilos.tarjetas}>
            {equipo.invitaciones.map((i) => (
              <article key={i.id} className={estilos.tarjeta}>
                <div>
                  <p className={estilos.tarjetaTitulo}>{i.email}</p>
                  <p className={estilos.tarjetaDetalle}>
                    {NOMBRE_DE_ROL[i.rol] ?? i.rol} · caduca {faltan(i.caducaEn) ?? 'pronto'}
                  </p>
                </div>
                {gestor && (
                  <div className={propios.accionDeTarjeta}>
                    <button
                      className={estilos.peligro}
                      onClick={() => void cancelar(i.id)}
                      aria-label={`Retirar la invitación de ${i.email}`}
                    >
                      Retirar
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

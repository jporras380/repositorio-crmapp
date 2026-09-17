import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ejecutarConContexto } from '../db.js';
import { TOKEN_AUTH } from '../tokens.js';
import { AuthService, ErrorDeNegocio } from './auth.service.js';
import { randomUUID } from 'node:crypto';

/**
 * Valida el token y establece el contexto de inquilino.
 *
 * Es el unico sitio donde nace el `tenantId` que usara RLS. Si el guard no
 * corre, `BaseDeDatos.enTransaccion()` lanza en vez de consultar sin
 * inquilino: fallar ruidoso en lugar de devolver cero filas sin explicacion.
 *
 * El contexto se establece con AsyncLocalStorage y NO se propaga solo a traves
 * del pipeline de NestJS, asi que se envuelve el resto de la peticion con
 * `ejecutarConContexto` desde el interceptor de abajo.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(TOKEN_AUTH) private readonly auth: AuthService) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const req = contexto.switchToHttp().getRequest();
    const cabecera: string | undefined = req.headers?.authorization;

    if (!cabecera?.startsWith('Bearer ')) {
      throw new ErrorDeNegocio('sin_sesion', 'Falta la cabecera Authorization.', 401);
    }

    const payload = this.auth.verificarToken(cabecera.slice(7));
    // La firma dice que el token es nuestro; esto dice que la sesión sigue
    // abierta. Son dos preguntas distintas y hacen falta las dos (0033).
    await this.auth.sesionViva(payload);
    req.contexto = {
      tenantId: payload.tid,
      userId: payload.sub,
      rol: payload.rol,
      correlationId: req.headers['x-correlation-id'] ?? randomUUID(),
      ...(payload.sid ? { sessionId: payload.sid } : {}),
    };
    return true;
  }
}

/** Envuelve el manejador con el AsyncLocalStorage del contexto. */
export function conContextoDePeticion<T>(req: { contexto?: unknown }, fn: () => Promise<T>) {
  const ctx = req.contexto as Parameters<typeof ejecutarConContexto>[0] | undefined;
  if (!ctx) return fn();
  return ejecutarConContexto(ctx, fn);
}

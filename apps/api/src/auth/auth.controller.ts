import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { TOKEN_AUTH } from '../tokens.js';
import { AuthService, ErrorDeNegocio } from './auth.service.js';
import { AuthGuard, conContextoDePeticion } from './auth.guard.js';

/**
 * Validacion con Zod y no con class-validator.
 *
 * class-validator necesita `emitDecoratorMetadata` para inferir tipos, que es
 * justo lo que no tenemos (ver tokens.ts). Zod valida en tiempo de ejecucion y
 * ademas deriva el tipo TypeScript de la misma definicion, asi que el DTO no
 * puede desincronizarse de su validacion.
 */
const AltaDto = z.object({
  nombreDeCuenta: z.string().min(2).max(100),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'solo minusculas, digitos y guiones'),
  email: z.string().email(),
  contrasena: z.string().min(10),
  nombreCompleto: z.string().min(2).max(120),
  planCode: z.string().optional(),
});

const LoginDto = z.object({
  email: z.string().email(),
  contrasena: z.string().min(1),
  tenantSlug: z.string().optional(),
});

const InvitacionDto = z.object({
  email: z.string().email(),
  rol: z.enum(['admin', 'supervisor', 'agent']),
});

const AceptarDto = z.object({
  token: z.string().min(10),
  contrasena: z.string().min(10),
  nombreCompleto: z.string().min(2).max(120),
});

function validar<T>(esquema: z.ZodType<T>, datos: unknown): T {
  const r = esquema.safeParse(datos);
  if (!r.success) {
    const detalle = r.error.issues
      .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('; ');
    throw new ErrorDeNegocio('datos_invalidos', detalle, 400);
  }
  return r.data;
}

@Controller()
export class AuthController {
  constructor(@Inject(TOKEN_AUTH) private readonly auth: AuthService) {}

  @Post('v1/cuentas')
  @HttpCode(201)
  async registrar(@Body() body: unknown) {
    return this.auth.registrar(validar(AltaDto, body));
  }

  @Post('v1/sesiones')
  @HttpCode(200)
  async login(@Body() body: unknown) {
    const d = validar(LoginDto, body);
    return this.auth.iniciarSesion(d.email, d.contrasena, d.tenantSlug);
  }

  @Post('v1/invitaciones/aceptar')
  @HttpCode(200)
  async aceptar(@Body() body: unknown) {
    return this.auth.aceptarInvitacion(validar(AceptarDto, body));
  }

  @Post('v1/invitaciones')
  @HttpCode(201)
  @UseGuards(AuthGuard)
  async invitar(@Req() req: { contexto?: unknown }, @Body() body: unknown) {
    const d = validar(InvitacionDto, body);
    return conContextoDePeticion(req, () => this.auth.invitar(d));
  }

  @Get('v1/yo')
  @UseGuards(AuthGuard)
  async yo(@Req() req: { contexto?: { tenantId: string; userId: string; rol: string } }) {
    const ctx = req.contexto!;
    const { estado } = await this.auth.estadoDeSuscripcion(ctx.tenantId);
    return { userId: ctx.userId, tenantId: ctx.tenantId, rol: ctx.rol, suscripcion: estado };
  }
}

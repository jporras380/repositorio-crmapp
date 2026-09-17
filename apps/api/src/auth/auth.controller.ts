import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
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

/** Lo que la petición sabe de quien entra. Nada de esto se cree a ciegas. */
type Req = {
  contexto?: unknown;
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
};

/**
 * IP y dispositivo de quien inicia sesión.
 *
 * `x-forwarded-for` lo pone el proxy y puede venir con varias: la primera es
 * el cliente. Se recorta el agente porque un `User-Agent` puede ser larguísimo
 * y aquí solo sirve para que su dueño reconozca «Chrome en Windows».
 */
function accesoDe(req: Req): { ip?: string; userAgent?: string } {
  const reenviada = req.headers?.['x-forwarded-for'];
  const ip =
    (typeof reenviada === 'string' ? reenviada.split(',')[0]?.trim() : undefined) ?? req.ip;
  const agente = req.headers?.['user-agent'];
  return {
    ...(ip ? { ip } : {}),
    ...(typeof agente === 'string' ? { userAgent: agente.slice(0, 200) } : {}),
  };
}

const PerfilDto = z
  .object({
    nombre: z.string().min(1).max(120).optional(),
    /** `null` quita la foto. Distinto de no mandar el campo. */
    fotoId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nada que cambiar.');

const AccesoDto = z
  .object({
    contrasenaActual: z.string().min(1),
    email: z.string().email('El correo no tiene buena pinta.').max(160).optional(),
    contrasenaNueva: z.string().min(12, 'Al menos 12 caracteres.').max(200).optional(),
  })
  .refine(
    (v) => v.email !== undefined || v.contrasenaNueva !== undefined,
    'Di qué quieres cambiar.',
  );

@Controller()
export class AuthController {
  constructor(@Inject(TOKEN_AUTH) private readonly auth: AuthService) {}

  @Post('v1/cuentas')
  @HttpCode(201)
  async registrar(@Req() req: Req, @Body() body: unknown) {
    return this.auth.registrar(validar(AltaDto, body), accesoDe(req));
  }

  @Post('v1/sesiones')
  @HttpCode(200)
  async login(@Req() req: Req, @Body() body: unknown) {
    const d = validar(LoginDto, body);
    return this.auth.iniciarSesion(d.email, d.contrasena, d.tenantSlug, accesoDe(req));
  }

  @Post('v1/invitaciones/aceptar')
  @HttpCode(200)
  async aceptar(@Req() req: Req, @Body() body: unknown) {
    return this.auth.aceptarInvitacion(validar(AceptarDto, body), accesoDe(req));
  }

  @Post('v1/invitaciones')
  @HttpCode(201)
  @UseGuards(AuthGuard)
  async invitar(@Req() req: { contexto?: unknown }, @Body() body: unknown) {
    const d = validar(InvitacionDto, body);
    return conContextoDePeticion(req, () => this.auth.invitar(d));
  }

  @Get('v1/usuarios')
  @UseGuards(AuthGuard)
  miembros(@Req() req: { contexto?: unknown }) {
    return conContextoDePeticion(req, () => this.auth.miembros());
  }

  @Get('v1/perfil')
  @UseGuards(AuthGuard)
  async perfil(@Req() req: { contexto?: unknown }) {
    return conContextoDePeticion(req, () => this.auth.perfil());
  }

  @Patch('v1/perfil')
  @UseGuards(AuthGuard)
  @HttpCode(204)
  async editarPerfil(@Req() req: { contexto?: unknown }, @Body() body: unknown) {
    const d = validar(PerfilDto, body);
    await conContextoDePeticion(req, () => this.auth.editarPerfil(d));
  }

  /** Correo y contraseña van juntos porque los dos piden la contraseña actual. */
  @Post('v1/perfil/acceso')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async cambiarAcceso(@Req() req: { contexto?: unknown }, @Body() body: unknown) {
    const d = validar(AccesoDto, body);
    return conContextoDePeticion(req, () => this.auth.cambiarAcceso(d));
  }

  /** Las sesiones abiertas de quien pregunta, para reconocerlas o cerrarlas. */
  @Get('v1/sesiones')
  @UseGuards(AuthGuard)
  async sesiones(@Req() req: { contexto?: unknown }) {
    return conContextoDePeticion(req, () => this.auth.sesiones());
  }

  /** `otras` cierra todas menos la actual: el caso de «esto no era yo». */
  @Delete('v1/sesiones/:id')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async cerrarSesion(@Req() req: { contexto?: unknown }, @Param('id') id: string) {
    return conContextoDePeticion(req, async () => ({
      cerradas: await this.auth.cerrarSesion(id === 'otras' ? 'otras' : id),
    }));
  }

  @Get('v1/yo')
  @UseGuards(AuthGuard)
  async yo(@Req() req: { contexto?: { tenantId: string; userId: string; rol: string } }) {
    const ctx = req.contexto!;
    // El nombre y la foto viajan aquí y no en una petición aparte: los pinta
    // el riel de navegación, que está en todas las pantallas.
    const [{ estado }, perfil] = await Promise.all([
      this.auth.estadoDeSuscripcion(ctx.tenantId),
      conContextoDePeticion(req, () => this.auth.perfil()),
    ]);
    return {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      rol: ctx.rol,
      suscripcion: estado,
      nombre: perfil.nombre,
      fotoId: perfil.fotoId,
    };
  }
}

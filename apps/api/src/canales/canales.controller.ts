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
import { TOKEN_CANALES } from '../tokens.js';
import { AuthGuard, conContextoDePeticion } from '../auth/auth.guard.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import type { CanalesService } from './canales.service.js';

const AltaWhatsapp = z.object({
  phoneNumberId: z.string().regex(/^\d{5,25}$/, 'phone_number_id numérico'),
  wabaId: z.string().regex(/^\d{5,25}$/, 'id de WABA numérico'),
  accessToken: z.string().min(20),
  appSecret: z.string().min(16),
  displayName: z.string().min(1).max(80).optional(),
});

const AltaInstagram = z.object({
  igUserId: z.string().regex(/^\d{5,25}$/, 'id de cuenta de Instagram numérico'),
  accessToken: z.string().min(20),
  appSecret: z.string().min(16),
  displayName: z.string().min(1).max(80).optional(),
});

/** Solo el token: la clave secreta no hace falta para preguntar a Meta. */
const DescubrirWhatsapp = z.object({
  accessToken: z.string().min(20),
  wabaId: z
    .string()
    .regex(/^\d{5,25}$/, 'id de WABA numérico')
    .optional(),
});

const DescubrirInstagram = z.object({
  accessToken: z.string().min(20),
});

const RenovarCredenciales = z.object({
  accessToken: z.string().min(20),
  /** Opcional: normalmente solo caduca el token, no la clave secreta de la app. */
  appSecret: z.string().min(16).optional(),
});

function validar<T>(esquema: z.ZodType<T, z.ZodTypeDef, unknown>, datos: unknown): T {
  const r = esquema.safeParse(datos);
  if (!r.success) {
    const detalle = r.error.issues
      .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('; ');
    throw new ErrorDeNegocio('datos_invalidos', detalle, 400);
  }
  return r.data;
}

type Req = { contexto?: unknown };

@Controller('v1/canales')
@UseGuards(AuthGuard)
export class CanalesController {
  constructor(@Inject(TOKEN_CANALES) private readonly canales: CanalesService) {}

  @Get()
  listar(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.canales.listar());
  }

  /**
   * Qué números ve un token, para elegir en vez de copiar ids. POST y no GET:
   * el token no puede viajar en la URL (acaba en logs y en el historial).
   */
  @Post('whatsapp/descubrir')
  @HttpCode(200)
  descubrirWhatsapp(@Req() req: Req, @Body() body: unknown) {
    const d = validar(DescubrirWhatsapp, body);
    return conContextoDePeticion(req, () =>
      this.canales.descubrirWhatsapp({
        accessToken: d.accessToken,
        ...(d.wabaId ? { wabaId: d.wabaId } : {}),
      }),
    );
  }

  @Post('instagram/descubrir')
  @HttpCode(200)
  descubrirInstagram(@Req() req: Req, @Body() body: unknown) {
    const d = validar(DescubrirInstagram, body);
    return conContextoDePeticion(req, () => this.canales.descubrirInstagram(d));
  }

  /**
   * Conexión BYO de WhatsApp. El cuerpo lleva el token y el app secret UNA
   * vez; la respuesta no los devuelve y ningún endpoint los devuelve después.
   */
  @Post('whatsapp')
  @HttpCode(201)
  conectarWhatsapp(@Req() req: Req, @Body() body: unknown) {
    const cred = validar(AltaWhatsapp, body);
    return conContextoDePeticion(req, () => this.canales.conectarWhatsapp(cred));
  }

  /** Conexión BYO de Instagram (cuenta profesional + token de página). */
  @Post('instagram')
  @HttpCode(201)
  conectarInstagram(@Req() req: Req, @Body() body: unknown) {
    const cred = validar(AltaInstagram, body);
    return conContextoDePeticion(req, () => this.canales.conectarInstagram(cred));
  }

  /**
   * Renueva el token (y opcionalmente el app secret) de un canal conectado.
   * PATCH y no POST: la cuenta ya existe y sigue siendo la misma.
   */
  @Patch(':id/credenciales')
  renovar(@Req() req: Req, @Param('id') id: string, @Body() body: unknown) {
    const d = validar(RenovarCredenciales, body);
    return conContextoDePeticion(req, () =>
      this.canales.renovarCredenciales(id, {
        accessToken: d.accessToken,
        ...(d.appSecret ? { appSecret: d.appSecret } : {}),
      }),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  async desconectar(@Req() req: Req, @Param('id') id: string) {
    await conContextoDePeticion(req, () => this.canales.desconectar(id));
  }
}

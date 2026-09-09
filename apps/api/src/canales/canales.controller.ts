import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
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
   * Conexión BYO de WhatsApp. El cuerpo lleva el token y el app secret UNA
   * vez; la respuesta no los devuelve y ningún endpoint los devuelve después.
   */
  @Post('whatsapp')
  @HttpCode(201)
  conectarWhatsapp(@Req() req: Req, @Body() body: unknown) {
    const cred = validar(AltaWhatsapp, body);
    return conContextoDePeticion(req, () => this.canales.conectarWhatsapp(cred));
  }

  @Delete(':id')
  @HttpCode(204)
  async desconectar(@Req() req: Req, @Param('id') id: string) {
    await conContextoDePeticion(req, () => this.canales.desconectar(id));
  }
}

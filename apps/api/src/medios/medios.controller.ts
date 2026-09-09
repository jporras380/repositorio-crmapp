import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { TOKEN_MEDIOS } from '../tokens.js';
import { AuthGuard, conContextoDePeticion } from '../auth/auth.guard.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import type { MediosService } from './medios.service.js';

const Subida = z.object({
  mime: z.string().min(3).max(100),
  bytes: z.number().int().positive(),
  nombre: z.string().max(200).optional(),
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

@Controller('v1/medios')
@UseGuards(AuthGuard)
export class MediosController {
  constructor(@Inject(TOKEN_MEDIOS) private readonly medios: MediosService) {}

  @Get(':id/url')
  url(@Req() req: Req, @Param('id') id: string) {
    return conContextoDePeticion(req, () => this.medios.urlDeLectura(id));
  }

  @Post('subidas')
  @HttpCode(201)
  preparar(@Req() req: Req, @Body() body: unknown) {
    const d = validar(Subida, body);
    return conContextoDePeticion(req, () => this.medios.prepararSubida(d));
  }

  @Post('subidas/:id/confirmar')
  @HttpCode(200)
  confirmar(@Req() req: Req, @Param('id') id: string) {
    return conContextoDePeticion(req, () => this.medios.confirmarSubida(id));
  }
}

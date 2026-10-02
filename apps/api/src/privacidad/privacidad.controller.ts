import { Body, Controller, Get, Inject, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { TOKEN_PRIVACIDAD } from '../tokens.js';
import { AuthGuard, conContextoDePeticion } from '../auth/auth.guard.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import type { PrivacidadService } from './privacidad.service.js';

/** Los mismos plazos que `PLAZOS_DE_RETENCION` y que el CHECK de 0052. */
const Cambios = z.object({
  /** `null` = para siempre. */
  retencionMeses: z.union([z.literal(12), z.literal(24), z.literal(36), z.literal(60), z.null()]),
});

type Req = { contexto?: unknown };

@Controller('v1/cuenta/privacidad')
@UseGuards(AuthGuard)
export class PrivacidadController {
  constructor(@Inject(TOKEN_PRIVACIDAD) private readonly privacidad: PrivacidadService) {}

  @Get()
  leer(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.privacidad.leer());
  }

  @Put()
  guardar(@Req() req: Req, @Body() body: unknown) {
    const r = Cambios.safeParse(body);
    if (!r.success) {
      throw new ErrorDeNegocio(
        'datos_invalidos',
        'retencionMeses: elige 12, 24, 36, 60 meses, o null para guardar siempre.',
        400,
      );
    }
    return conContextoDePeticion(req, () => this.privacidad.guardar(r.data.retencionMeses));
  }
}

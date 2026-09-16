import { Body, Controller, Get, Inject, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { TOKEN_HORARIO } from '../tokens.js';
import { AuthGuard, conContextoDePeticion } from '../auth/auth.guard.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import type { HorarioService } from './horario.service.js';

const Hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'hora HH:MM');

const Cambios = z.object({
  zonaHoraria: z.string().min(1).max(60).optional(),
  /** Día ISO (1 = lunes … 7 = domingo) → tramos `["09:00","13:00"]`. */
  horario: z.record(z.string().regex(/^[1-7]$/), z.array(z.tuple([Hora, Hora])).max(4)).optional(),
  avisoActivo: z.boolean().optional(),
  avisoTexto: z.string().max(1000).optional(),
});

type Req = { contexto?: unknown };

@Controller('v1/cuenta/horario')
@UseGuards(AuthGuard)
export class HorarioController {
  constructor(@Inject(TOKEN_HORARIO) private readonly horario: HorarioService) {}

  @Get()
  leer(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.horario.leer());
  }

  @Put()
  guardar(@Req() req: Req, @Body() body: unknown) {
    const r = Cambios.safeParse(body);
    if (!r.success) {
      throw new ErrorDeNegocio(
        'datos_invalidos',
        r.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; '),
        400,
      );
    }
    return conContextoDePeticion(req, () => this.horario.guardar(r.data));
  }
}

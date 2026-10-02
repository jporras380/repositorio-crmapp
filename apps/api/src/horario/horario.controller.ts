import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
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

/** `?equipo=<id>`: el horario de ese equipo. Sin él, el general. */
const Equipo = z.string().uuid().optional();

function equipoDe(valor: unknown): string | null {
  const r = Equipo.safeParse(valor);
  if (!r.success) throw new ErrorDeNegocio('datos_invalidos', 'equipo: no es un id válido', 400);
  return r.data ?? null;
}

@Controller('v1/cuenta/horario')
@UseGuards(AuthGuard)
export class HorarioController {
  constructor(@Inject(TOKEN_HORARIO) private readonly horario: HorarioService) {}

  @Get()
  leer(@Req() req: Req, @Query('equipo') equipo?: string) {
    const equipoId = equipoDe(equipo);
    return conContextoDePeticion(req, () => this.horario.leer(equipoId));
  }

  /** El equipo vuelve a usar el horario general. */
  @Delete('equipos/:equipoId')
  quitar(@Req() req: Req, @Param('equipoId') equipoId: string) {
    const id = equipoDe(equipoId);
    if (!id) throw new ErrorDeNegocio('datos_invalidos', 'Falta el equipo.', 400);
    return conContextoDePeticion(req, () => this.horario.quitarDeEquipo(id));
  }

  @Put()
  guardar(@Req() req: Req, @Body() body: unknown, @Query('equipo') equipo?: string) {
    const equipoId = equipoDe(equipo);
    const r = Cambios.safeParse(body);
    if (!r.success) {
      throw new ErrorDeNegocio(
        'datos_invalidos',
        r.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; '),
        400,
      );
    }
    return conContextoDePeticion(req, () => this.horario.guardar(r.data, equipoId));
  }
}

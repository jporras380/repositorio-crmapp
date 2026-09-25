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
import { TOKEN_EQUIPOS } from '../tokens.js';
import { AuthGuard, conContextoDePeticion } from '../auth/auth.guard.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import type { EquiposService } from './equipos.service.js';

const Nombre = z.object({ nombre: z.string().trim().min(1).max(60) });

const Miembro = z.object({ userId: z.string().uuid(), dentro: z.boolean() });

type Req = { contexto?: unknown };

/**
 * Equipos de la cuenta: Recepción, Reservas, Mantenimiento.
 *
 * Listarlos lo puede cualquiera —un agente necesita saber a qué equipo mandar
 * una conversación—; montarlos, solo propietario o administrador.
 */
@Controller('v1/equipos')
@UseGuards(AuthGuard)
export class EquiposController {
  constructor(@Inject(TOKEN_EQUIPOS) private readonly equipos: EquiposService) {}

  @Get()
  listar(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.equipos.listar());
  }

  @Post()
  @HttpCode(201)
  crear(@Req() req: Req, @Body() body: unknown) {
    const r = Nombre.safeParse(body);
    if (!r.success) throw new ErrorDeNegocio('nombre_invalido', 'Ponle un nombre al equipo.', 422);
    return conContextoDePeticion(req, () => this.equipos.crear(r.data.nombre));
  }

  @Patch(':id')
  renombrar(@Req() req: Req, @Param('id') id: string, @Body() body: unknown) {
    const r = Nombre.safeParse(body);
    if (!r.success) throw new ErrorDeNegocio('nombre_invalido', 'Ponle un nombre al equipo.', 422);
    return conContextoDePeticion(req, () => this.equipos.renombrar(id, r.data.nombre));
  }

  /** Borrarlo NO cierra sus conversaciones: quedan sin equipo (0004). */
  @Delete(':id')
  borrar(@Req() req: Req, @Param('id') id: string) {
    return conContextoDePeticion(req, () => this.equipos.borrar(id));
  }

  @Patch(':id/miembros')
  miembro(@Req() req: Req, @Param('id') id: string, @Body() body: unknown) {
    const r = Miembro.safeParse(body);
    if (!r.success) throw new ErrorDeNegocio('datos_invalidos', 'Falta la persona.', 400);
    return conContextoDePeticion(req, () =>
      this.equipos.cambiarMiembro(id, r.data.userId, r.data.dentro),
    );
  }
}

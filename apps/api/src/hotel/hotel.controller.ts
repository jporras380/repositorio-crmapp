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
import { TOKEN_HOTEL } from '../tokens.js';
import { AuthGuard, conContextoDePeticion } from '../auth/auth.guard.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import type { HotelService } from './hotel.service.js';

type Req = { contexto?: unknown };

const Fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha en formato AAAA-MM-DD');
/** Céntimos, entero y no negativo: el dinero no viaja con decimales. */
const Centimos = z.number().int().min(0).max(100_000_000);
const Unidad = z.enum(['por_estancia', 'por_noche', 'por_persona_noche']);

const NuevoTipo = z.object({
  nombre: z.string().min(1).max(60),
  descripcion: z.string().max(500).nullable().optional(),
  capacidad: z.number().int().min(1).max(50),
  precioBase: Centimos.nullable().optional(),
});
const EdicionTipo = NuevoTipo.partial().extend({ activo: z.boolean().optional() });

const NuevaHabitacion = z.object({
  tipoId: z.string().uuid(),
  nombre: z.string().min(1).max(40),
  notas: z.string().max(500).nullable().optional(),
});
const EdicionHabitacion = NuevaHabitacion.partial().extend({
  estado: z.enum(['disponible', 'mantenimiento', 'fuera_de_servicio']).optional(),
});

const NuevaTarifa = z.object({
  tipoId: z.string().uuid(),
  nombre: z.string().min(1).max(60),
  desde: Fecha,
  hasta: Fecha,
  precio: Centimos,
  minNoches: z.number().int().min(1).max(60).default(1),
  dias: z.array(z.number().int().min(0).max(6)).max(7).nullable().default(null),
});
const EdicionTarifa = z.object({
  nombre: z.string().min(1).max(60).optional(),
  desde: Fecha.optional(),
  hasta: Fecha.optional(),
  precio: Centimos.optional(),
  minNoches: z.number().int().min(1).max(60).optional(),
  dias: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
});

const NuevoServicio = z.object({
  nombre: z.string().min(1).max(60),
  precio: Centimos,
  unidad: Unidad,
});
const EdicionServicio = NuevoServicio.partial().extend({ activo: z.boolean().optional() });

const Cotizar = z.object({
  tipoId: z.string().uuid(),
  entrada: Fecha,
  salida: Fecha,
  personas: z.number().int().min(1).max(50),
  servicios: z.array(z.string().uuid()).max(20).optional(),
});

function validar<T>(esquema: z.ZodType<T, z.ZodTypeDef, unknown>, cuerpo: unknown): T {
  const r = esquema.safeParse(cuerpo);
  if (!r.success) {
    const primero = r.error.issues[0];
    throw new ErrorDeNegocio(
      'datos_invalidos',
      primero ? `${primero.path.join('.')}: ${primero.message}` : 'Datos inválidos.',
      400,
    );
  }
  return r.data;
}

/** Quita las claves `undefined`: con `exactOptionalPropertyTypes` no son lo mismo que ausentes. */
function presentes<T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as never;
}

@Controller('v1/hotel')
@UseGuards(AuthGuard)
export class HotelController {
  constructor(@Inject(TOKEN_HOTEL) private readonly hotel: HotelService) {}

  @Get()
  catalogo(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.hotel.catalogo());
  }

  /** POST y no GET: lleva cuerpo, y una cotización no es un recurso que se guarde. */
  @Post('cotizar')
  @HttpCode(200)
  cotizar(@Req() req: Req, @Body() cuerpo: unknown) {
    const d = validar(Cotizar, cuerpo);
    return conContextoDePeticion(req, () => this.hotel.cotizar(d));
  }

  // --- Tipos ----------------------------------------------------------------

  @Post('tipos')
  crearTipo(@Req() req: Req, @Body() cuerpo: unknown) {
    const d = validar(NuevoTipo, cuerpo);
    return conContextoDePeticion(req, () => this.hotel.crearTipo(d));
  }

  @Patch('tipos/:id')
  @HttpCode(204)
  async editarTipo(@Req() req: Req, @Param('id') id: string, @Body() cuerpo: unknown) {
    const d = validar(EdicionTipo, cuerpo);
    await conContextoDePeticion(req, () => this.hotel.editarTipo(id, presentes(d)));
  }

  @Delete('tipos/:id')
  @HttpCode(204)
  async borrarTipo(@Req() req: Req, @Param('id') id: string) {
    await conContextoDePeticion(req, () => this.hotel.borrarTipo(id));
  }

  // --- Habitaciones ---------------------------------------------------------

  @Post('habitaciones')
  crearHabitacion(@Req() req: Req, @Body() cuerpo: unknown) {
    const d = validar(NuevaHabitacion, cuerpo);
    return conContextoDePeticion(req, () => this.hotel.crearHabitacion(d));
  }

  @Patch('habitaciones/:id')
  @HttpCode(204)
  async editarHabitacion(@Req() req: Req, @Param('id') id: string, @Body() cuerpo: unknown) {
    const d = validar(EdicionHabitacion, cuerpo);
    await conContextoDePeticion(req, () => this.hotel.editarHabitacion(id, presentes(d)));
  }

  @Delete('habitaciones/:id')
  @HttpCode(204)
  async borrarHabitacion(@Req() req: Req, @Param('id') id: string) {
    await conContextoDePeticion(req, () => this.hotel.borrarHabitacion(id));
  }

  // --- Tarifas --------------------------------------------------------------

  @Post('tarifas')
  crearTarifa(@Req() req: Req, @Body() cuerpo: unknown) {
    const d = validar(NuevaTarifa, cuerpo);
    return conContextoDePeticion(req, () => this.hotel.crearTarifa(d));
  }

  @Patch('tarifas/:id')
  @HttpCode(204)
  async editarTarifa(@Req() req: Req, @Param('id') id: string, @Body() cuerpo: unknown) {
    const d = validar(EdicionTarifa, cuerpo);
    await conContextoDePeticion(req, () => this.hotel.editarTarifa(id, presentes(d)));
  }

  @Delete('tarifas/:id')
  @HttpCode(204)
  async borrarTarifa(@Req() req: Req, @Param('id') id: string) {
    await conContextoDePeticion(req, () => this.hotel.borrarTarifa(id));
  }

  // --- Servicios ------------------------------------------------------------

  @Post('servicios')
  crearServicio(@Req() req: Req, @Body() cuerpo: unknown) {
    const d = validar(NuevoServicio, cuerpo);
    return conContextoDePeticion(req, () => this.hotel.crearServicio(d));
  }

  @Patch('servicios/:id')
  @HttpCode(204)
  async editarServicio(@Req() req: Req, @Param('id') id: string, @Body() cuerpo: unknown) {
    const d = validar(EdicionServicio, cuerpo);
    await conContextoDePeticion(req, () => this.hotel.editarServicio(id, presentes(d)));
  }

  @Delete('servicios/:id')
  @HttpCode(204)
  async borrarServicio(@Req() req: Req, @Param('id') id: string) {
    await conContextoDePeticion(req, () => this.hotel.borrarServicio(id));
  }
}

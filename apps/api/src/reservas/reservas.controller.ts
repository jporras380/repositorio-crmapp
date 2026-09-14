import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { TOKEN_RESERVAS } from '../tokens.js';
import { AuthGuard, conContextoDePeticion } from '../auth/auth.guard.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import type { ReservasService } from './reservas.service.js';

type Req = { contexto?: unknown };

const Fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha en formato AAAA-MM-DD');

const Nueva = z
  .object({
    conversacionId: z.string().uuid().optional(),
    contactoId: z.string().uuid().optional(),
    tipoId: z.string().uuid(),
    entrada: Fecha,
    salida: Fecha,
    personas: z.number().int().min(1).max(50),
    servicios: z.array(z.string().uuid()).max(20).optional(),
    habitacionId: z.string().uuid().optional(),
    descuento: z
      .object({ importe: z.number().int().min(1), motivo: z.string().max(120) })
      .optional(),
    notas: z.string().max(2000).optional(),
    aceptarAvisos: z.boolean().optional(),
    // Lo que NO está aquí es tan importante como lo que sí: ni `total` ni
    // precios. El precio lo pone el cotizador del servidor, nunca la pantalla.
  })
  .strict()
  .refine((v) => v.conversacionId || v.contactoId, 'Hace falta conversacionId o contactoId.');

const Accion = z.object({ accion: z.enum(['confirmar', 'llegar', 'salir', 'cancelar']) });
const Habitacion = z.object({ habitacionId: z.string().uuid().nullable() });
const Pago = z.object({
  importe: z.number().int().min(1).max(100_000_000),
  metodo: z.enum(['efectivo', 'transferencia', 'yape', 'plin', 'tarjeta', 'otro']),
  referencia: z.string().max(120).optional(),
});
const Filtros = z.object({
  estado: z.enum(['pendiente', 'confirmada', 'en_casa', 'finalizada', 'cancelada']).optional(),
  desde: Fecha.optional(),
  hasta: Fecha.optional(),
  contactoId: z.string().uuid().optional(),
  conversacionId: z.string().uuid().optional(),
});

function validar<T>(esquema: z.ZodType<T, z.ZodTypeDef, unknown>, cuerpo: unknown): T {
  const r = esquema.safeParse(cuerpo);
  if (!r.success) {
    const primero = r.error.issues[0];
    throw new ErrorDeNegocio(
      'datos_invalidos',
      primero ? `${primero.path.join('.') || 'cuerpo'}: ${primero.message}` : 'Datos inválidos.',
      400,
    );
  }
  return r.data;
}

@Controller('v1/reservas')
@UseGuards(AuthGuard)
export class ReservasController {
  constructor(@Inject(TOKEN_RESERVAS) private readonly reservas: ReservasService) {}

  @Get()
  listar(@Req() req: Req, @Query() query: unknown) {
    const f = validar(Filtros, query);
    return conContextoDePeticion(req, () => this.reservas.listar(f));
  }

  @Get(':id')
  detalle(@Req() req: Req, @Param('id') id: string) {
    return conContextoDePeticion(req, () => this.reservas.detalle(id));
  }

  @Post()
  crear(@Req() req: Req, @Body() cuerpo: unknown) {
    const d = validar(Nueva, cuerpo);
    return conContextoDePeticion(req, () => this.reservas.crear(d));
  }

  @Patch(':id/estado')
  @HttpCode(200)
  mover(@Req() req: Req, @Param('id') id: string, @Body() cuerpo: unknown) {
    const { accion } = validar(Accion, cuerpo);
    return conContextoDePeticion(req, () => this.reservas.mover(id, accion));
  }

  @Patch(':id/habitacion')
  @HttpCode(200)
  habitacion(@Req() req: Req, @Param('id') id: string, @Body() cuerpo: unknown) {
    const { habitacionId } = validar(Habitacion, cuerpo);
    return conContextoDePeticion(req, () => this.reservas.asignarHabitacion(id, habitacionId));
  }

  @Post(':id/pagos')
  pagar(@Req() req: Req, @Param('id') id: string, @Body() cuerpo: unknown) {
    const d = validar(Pago, cuerpo);
    return conContextoDePeticion(req, () => this.reservas.registrarPago(id, d));
  }
}

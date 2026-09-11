import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { TOKEN_EMBUDO } from '../tokens.js';
import { AuthGuard, conContextoDePeticion } from '../auth/auth.guard.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import type { EmbudoService, TipoDeEtapa } from './embudo.service.js';

const Tipo = z.enum(['abierta', 'ganada', 'perdida']);
/** Color en hex, como las etiquetas. Nada de nombres CSS: se pintan en SVG. */
const Color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'El color tiene que ser hexadecimal, como #0A84FF');

const NuevaEtapa = z.object({
  nombre: z.string().min(1).max(40),
  color: Color.nullable().optional(),
  tipo: Tipo.optional(),
});

const EdicionEtapa = z
  .object({
    nombre: z.string().min(1).max(40).optional(),
    color: Color.nullable().optional(),
    tipo: Tipo.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nada que cambiar.');

const Orden = z.object({ ids: z.array(z.string().uuid()).min(1).max(40) });

const NuevoLead = z.object({
  contactoId: z.string().uuid(),
  titulo: z.string().min(1).max(120),
  // En céntimos y entero: el cliente escribe soles, la interfaz multiplica.
  importe: z.number().int().min(0).max(1_000_000_000_000).optional(),
  etapaId: z.string().uuid().optional(),
  responsableId: z.string().uuid().nullable().optional(),
});

const EdicionLead = z
  .object({
    etapaId: z.string().uuid().optional(),
    titulo: z.string().min(1).max(120).optional(),
    importe: z.number().int().min(0).max(1_000_000_000_000).optional(),
    responsableId: z.string().uuid().nullable().optional(),
    etiquetas: z.array(z.string().uuid()).max(20).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nada que cambiar.');

type Req = { contexto?: unknown };

function validar<T>(esquema: z.ZodType<T>, cuerpo: unknown): T {
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

/**
 * El embudo por HTTP.
 *
 * Las etapas las cambia quien manda (propietario o administrador) y los leads
 * los mueve cualquiera: mover una tarjeta es el trabajo diario de un agente,
 * cambiar las columnas es rediseñar cómo vende la empresa.
 */
@Controller('v1')
@UseGuards(AuthGuard)
export class EmbudoController {
  constructor(@Inject(TOKEN_EMBUDO) private readonly embudo: EmbudoService) {}

  @Get('embudos')
  async lista(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.embudo.embudos());
  }

  @Post('embudos/:id/etapas')
  async crearEtapa(@Req() req: Req, @Param('id') id: string, @Body() cuerpo: unknown) {
    const datos = validar(NuevaEtapa, cuerpo);
    return conContextoDePeticion(req, () =>
      this.embudo.crearEtapa(id, {
        nombre: datos.nombre,
        ...(datos.color !== undefined ? { color: datos.color } : {}),
        ...(datos.tipo !== undefined ? { tipo: datos.tipo as TipoDeEtapa } : {}),
      }),
    );
  }

  @Patch('embudos/:id/etapas/orden')
  async ordenar(@Req() req: Req, @Param('id') id: string, @Body() cuerpo: unknown) {
    const { ids } = validar(Orden, cuerpo);
    await conContextoDePeticion(req, () => this.embudo.ordenarEtapas(id, ids));
    return { ordenadas: ids.length };
  }

  @Patch('etapas/:id')
  async editarEtapa(@Req() req: Req, @Param('id') id: string, @Body() cuerpo: unknown) {
    const datos = validar(EdicionEtapa, cuerpo);
    await conContextoDePeticion(req, () =>
      this.embudo.editarEtapa(id, {
        ...(datos.nombre !== undefined ? { nombre: datos.nombre } : {}),
        ...(datos.color !== undefined ? { color: datos.color } : {}),
        ...(datos.tipo !== undefined ? { tipo: datos.tipo } : {}),
      }),
    );
    return { editada: true };
  }

  @Delete('etapas/:id')
  async borrarEtapa(@Req() req: Req, @Param('id') id: string, @Query('destino') destino?: string) {
    await conContextoDePeticion(req, () => this.embudo.borrarEtapa(id, destino ?? null));
    return { borrada: true };
  }

  @Get('leads/tablero')
  async tablero(
    @Req() req: Req,
    @Query('embudo') embudoId?: string,
    @Query('q') q?: string,
    @Query('responsable') responsableId?: string,
    @Query('etiqueta') etiquetaId?: string,
  ) {
    return conContextoDePeticion(req, () =>
      this.embudo.tablero({ embudoId, q, responsableId, etiquetaId }),
    );
  }

  @Get('leads/:id')
  async lead(@Req() req: Req, @Param('id') id: string) {
    return conContextoDePeticion(req, () => this.embudo.lead(id));
  }

  @Post('leads')
  async crear(@Req() req: Req, @Body() cuerpo: unknown) {
    const datos = validar(NuevoLead, cuerpo);
    return conContextoDePeticion(req, () =>
      this.embudo.crear({
        contactoId: datos.contactoId,
        titulo: datos.titulo,
        ...(datos.importe !== undefined ? { importe: datos.importe } : {}),
        ...(datos.etapaId !== undefined ? { etapaId: datos.etapaId } : {}),
        ...(datos.responsableId !== undefined ? { responsableId: datos.responsableId } : {}),
      }),
    );
  }

  @Patch('leads/:id')
  async editar(@Req() req: Req, @Param('id') id: string, @Body() cuerpo: unknown) {
    const datos = validar(EdicionLead, cuerpo);
    await conContextoDePeticion(req, () =>
      this.embudo.editar(id, {
        ...(datos.etapaId !== undefined ? { etapaId: datos.etapaId } : {}),
        ...(datos.titulo !== undefined ? { titulo: datos.titulo } : {}),
        ...(datos.importe !== undefined ? { importe: datos.importe } : {}),
        ...(datos.responsableId !== undefined ? { responsableId: datos.responsableId } : {}),
        ...(datos.etiquetas !== undefined ? { etiquetas: datos.etiquetas } : {}),
      }),
    );
    return { editado: true };
  }

  @Delete('leads/:id')
  async borrar(@Req() req: Req, @Param('id') id: string) {
    await conContextoDePeticion(req, () => this.embudo.borrar(id));
    return { borrado: true };
  }
}

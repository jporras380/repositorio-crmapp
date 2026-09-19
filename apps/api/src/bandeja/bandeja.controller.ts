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
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { TOKEN_BANDEJA } from '../tokens.js';
import { AuthGuard, conContextoDePeticion } from '../auth/auth.guard.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import type { BandejaService, PeticionDeEnvio } from './bandeja.service.js';

const CierreEnBloque = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});

const Filtros = z.object({
  canal: z.enum(['whatsapp', 'instagram', 'facebook', 'tiktok']).optional(),
  tipo: z.enum(['dm', 'comment_thread']).optional(),
  estado: z.enum(['open', 'pending', 'snoozed', 'closed']).optional(),
  agenteId: z.string().uuid().optional(),
  etiquetaId: z.string().uuid().optional(),
  sinRespuesta: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  relevo: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  atencion: z
    .enum(['nueva', 'por_responder', 'esperando_cliente', 'seguimiento', 'cerrada'])
    .optional(),
  q: z.string().min(1).max(80).optional(),
  desde: z.string().datetime().optional(),
  hasta: z.string().datetime().optional(),
  etapaId: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limite: z.coerce.number().int().min(1).max(100).optional(),
});

const Aplazar = z.object({ hasta: z.string().datetime().nullable() });

const Espera = z.object({ enEspera: z.boolean() });

const Nota = z.object({ cuerpo: z.string().min(1).max(4000) });

const Vista = z.object({
  nombre: z.string().min(1).max(40),
  // Los mismos filtros que acepta la lista, tal cual. Validar aquí una copia
  // de ese esquema significaría mantener dos, y la vista guardada dejaría de
  // aceptar el filtro nuevo el día que se añada uno.
  filtros: z.record(z.string(), z.string()).default({}),
});

const Paginacion = z.object({
  cursor: z.string().optional(),
  limite: z.coerce.number().int().min(1).max(100).optional(),
});

const Envio: z.ZodType<PeticionDeEnvio, z.ZodTypeDef, unknown> = z.discriminatedUnion('tipo', [
  z.object({
    tipo: z.literal('text'),
    texto: z.string().min(1).max(4096),
    generadoPorIa: z.boolean().optional(),
  }),
  z.object({
    tipo: z.enum(['image', 'video', 'audio', 'document']),
    url: z.string().url().optional(),
    mediaAssetId: z.string().uuid().optional(),
    pieDeFoto: z.string().max(1024).optional(),
  }),
  z.object({
    tipo: z.literal('template'),
    nombre: z.string().min(1),
    idioma: z.string().min(2).max(10),
    parametros: z.array(z.string()).max(20),
  }),
  z.object({ tipo: z.literal('quick_reply'), quickReplyId: z.string().uuid() }),
  z.object({
    tipo: z.literal('comment_reply'),
    modo: z.enum(['publica', 'privada']).default('privada'),
    texto: z.string().min(1).max(1000),
    comentarioId: z.string().min(1).max(200).optional(),
  }),
]);

const Asignacion = z.object({ agenteId: z.string().uuid().nullable() });
const Visibilidad = z.object({ modo: z.enum(['all', 'team', 'assigned']) });
const Estado = z.object({ estado: z.enum(['open', 'pending', 'snoozed', 'closed']) });
const Etiquetado = z.object({ tagId: z.string().uuid(), poner: z.boolean().default(true) });
const Reparto = z.object({
  modo: z.enum(['off', 'least_busy']).optional(),
  miembros: z
    .array(z.object({ userId: z.string().uuid(), recibe: z.boolean() }))
    .max(200)
    .optional(),
});

const NuevaEtiqueta = z.object({
  nombre: z.string().min(1).max(40),
  // Color como en Zenvia: es el filtro visual de primer nivel.
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color en formato #RRGGBB')
    .nullable()
    .default(null),
});

const EdicionDeEtiqueta = z
  .object({
    nombre: z.string().trim().min(1).max(40).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'color en formato #RRGGBB')
      .nullable()
      .optional(),
  })
  .refine((d) => d.nombre !== undefined || d.color !== undefined, 'nada que cambiar');

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

@Controller('v1')
@UseGuards(AuthGuard)
export class BandejaController {
  constructor(@Inject(TOKEN_BANDEJA) private readonly bandeja: BandejaService) {}

  @Get('conversaciones')
  listar(@Req() req: Req, @Query() query: unknown) {
    const f = validar(Filtros, query);
    return conContextoDePeticion(req, () => this.bandeja.listar(f));
  }

  @Get('conversaciones/:id/mensajes')
  mensajes(@Req() req: Req, @Param('id') id: string, @Query() query: unknown) {
    const p = validar(Paginacion, query);
    return conContextoDePeticion(req, () => this.bandeja.mensajes(id, p));
  }

  /** 202: el mensaje queda encolado; la entrega la confirma el worker. */
  @Post('conversaciones/:id/mensajes')
  @HttpCode(202)
  enviar(@Req() req: Req, @Param('id') id: string, @Body() body: unknown) {
    const peticion = validar(Envio, body);
    return conContextoDePeticion(req, () => this.bandeja.enviar(id, peticion));
  }

  @Patch('conversaciones/:id/asignacion')
  @HttpCode(204)
  async asignar(@Req() req: Req, @Param('id') id: string, @Body() body: unknown) {
    const { agenteId } = validar(Asignacion, body);
    await conContextoDePeticion(req, () => this.bandeja.asignar(id, agenteId));
  }

  @Patch('conversaciones/:id/estado')
  @HttpCode(204)
  async estado(@Req() req: Req, @Param('id') id: string, @Body() body: unknown) {
    const { estado } = validar(Estado, body);
    await conContextoDePeticion(req, () => this.bandeja.cambiarEstado(id, estado));
  }

  /** `hasta: null` la despierta ya. */
  /** Cerrar varias de una vez: la bandeja se limpia sin cincuenta clics. */
  @Post('conversaciones/cerrar')
  @HttpCode(200)
  async cerrarVarias(@Req() req: Req, @Body() body: unknown) {
    const d = validar(CierreEnBloque, body);
    return conContextoDePeticion(req, () => this.bandeja.cerrarVarias(d.ids));
  }

  @Patch('conversaciones/:id/aplazar')
  @HttpCode(204)
  async aplazar(@Req() req: Req, @Param('id') id: string, @Body() body: unknown) {
    const { hasta } = validar(Aplazar, body);
    await conContextoDePeticion(req, () =>
      this.bandeja.aplazar(id, hasta ? new Date(hasta) : null),
    );
  }

  /** «Ya lo he visto»: apaga el globo de sin leer, sin responder nada. */
  @Patch('conversaciones/:id/leida')
  @HttpCode(204)
  async leida(@Req() req: Req, @Param('id') id: string) {
    await conContextoDePeticion(req, () => this.bandeja.marcarLeida(id));
  }

  /**
   * Poner en espera o levantarla.
   *
   * Un solo endpoint con un booleano, y no dos verbos: quien lo llama tiene
   * delante un interruptor, y dos rutas obligarían a mirar el estado actual
   * para saber cuál pulsar.
   */
  @Patch('conversaciones/:id/espera')
  @HttpCode(204)
  async espera(@Req() req: Req, @Param('id') id: string, @Body() body: unknown) {
    const { enEspera } = validar(Espera, body);
    await conContextoDePeticion(req, () => this.bandeja.ponerEnEspera(id, enEspera));
  }

  @Get('conversaciones/:id/notas')
  notas(@Req() req: Req, @Param('id') id: string) {
    return conContextoDePeticion(req, () => this.bandeja.notas(id));
  }

  @Post('conversaciones/:id/notas')
  @HttpCode(201)
  anotar(@Req() req: Req, @Param('id') id: string, @Body() body: unknown) {
    const { cuerpo } = validar(Nota, body);
    return conContextoDePeticion(req, () => this.bandeja.anotar(id, cuerpo));
  }

  @Delete('notas/:id')
  @HttpCode(204)
  async borrarNota(@Req() req: Req, @Param('id') id: string) {
    await conContextoDePeticion(req, () => this.bandeja.borrarNota(id));
  }

  @Get('vistas')
  vistas(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.bandeja.vistas());
  }

  @Post('vistas')
  @HttpCode(201)
  guardarVista(@Req() req: Req, @Body() body: unknown) {
    const { nombre, filtros } = validar(Vista, body);
    return conContextoDePeticion(req, () => this.bandeja.guardarVista(nombre, filtros));
  }

  @Delete('vistas/:id')
  @HttpCode(204)
  async borrarVista(@Req() req: Req, @Param('id') id: string) {
    await conContextoDePeticion(req, () => this.bandeja.borrarVista(id));
  }

  @Patch('conversaciones/:id/etiquetas')
  @HttpCode(204)
  async etiquetar(@Req() req: Req, @Param('id') id: string, @Body() body: unknown) {
    const { tagId, poner } = validar(Etiquetado, body);
    await conContextoDePeticion(req, () => this.bandeja.etiquetar(id, tagId, poner));
  }

  @Get('cuenta/reparto')
  reparto(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.bandeja.reparto());
  }

  @Put('cuenta/reparto')
  guardarReparto(@Req() req: Req, @Body() body: unknown) {
    const d = validar(Reparto, body);
    return conContextoDePeticion(req, () => this.bandeja.guardarReparto(d));
  }

  /** Política de visibilidad entre agentes (ADR-008). Solo owner/admin. */
  @Patch('cuenta/visibilidad-conversaciones')
  @HttpCode(204)
  async visibilidad(@Req() req: Req, @Body() body: unknown) {
    const { modo } = validar(Visibilidad, body);
    await conContextoDePeticion(req, () => this.bandeja.cambiarVisibilidad(modo));
  }

  @Get('etiquetas')
  listarEtiquetas(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.bandeja.listarEtiquetas());
  }

  /** Para el apartado de administración: con dónde se usa cada una. */
  @Get('etiquetas/uso')
  etiquetasConUso(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.bandeja.etiquetasConUso());
  }

  @Patch('etiquetas/:id')
  @HttpCode(204)
  async editarEtiqueta(@Req() req: Req, @Param('id') id: string, @Body() body: unknown) {
    const cambios = validar(EdicionDeEtiqueta, body);
    await conContextoDePeticion(req, () => this.bandeja.editarEtiqueta(id, cambios));
  }

  @Delete('etiquetas/:id')
  @HttpCode(204)
  async borrarEtiqueta(@Req() req: Req, @Param('id') id: string) {
    await conContextoDePeticion(req, () => this.bandeja.borrarEtiqueta(id));
  }

  @Post('etiquetas')
  @HttpCode(201)
  crearEtiqueta(@Req() req: Req, @Body() body: unknown) {
    const { nombre, color } = validar(NuevaEtiqueta, body);
    return conContextoDePeticion(req, () => this.bandeja.crearEtiqueta(nombre, color));
  }
}

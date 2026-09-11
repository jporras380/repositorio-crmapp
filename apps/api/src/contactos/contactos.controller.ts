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
import { TOKEN_CONTACTOS } from '../tokens.js';
import { AuthGuard, conContextoDePeticion } from '../auth/auth.guard.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import type { ContactosService, OrigenDeContacto } from './contactos.service.js';

type Req = { contexto?: unknown };

const Origen = z.enum(['whatsapp', 'instagram', 'facebook', 'tiktok', 'web', 'otro']);

const Datos = z.object({
  nombre: z.string().max(120).nullable().optional(),
  telefono: z.string().max(40).nullable().optional(),
  email: z.string().email('El correo no tiene buena pinta.').max(160).nullable().optional(),
  ciudad: z.string().max(80).nullable().optional(),
  origen: Origen.optional(),
  tipoDeHuesped: z.string().max(60).nullable().optional(),
  notas: z.string().max(4000).nullable().optional(),
  etiquetas: z.array(z.string().uuid()).max(30).optional(),
});

const Edicion = Datos.refine((v) => Object.keys(v).length > 0, 'Nada que cambiar.');

const Importacion = z.object({
  // El CSV viaja dentro del JSON en vez de como multipart: evita una
  // dependencia de subida de archivos para un caso que es texto plano.
  csv: z.string().min(1).max(4_000_000),
  /** Prefijo con el que completar los teléfonos sin `+`. Lo elige el usuario. */
  prefijo: z
    .string()
    .regex(/^\+?\d{1,4}$/, 'El prefijo es algo como +51')
    .optional(),
});

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

/** Solo los campos que vienen, para no pisar con `undefined` lo que ya había. */
function soloPresentes(d: z.infer<typeof Datos>) {
  return {
    ...(d.nombre !== undefined ? { nombre: d.nombre } : {}),
    ...(d.telefono !== undefined ? { telefono: d.telefono } : {}),
    ...(d.email !== undefined ? { email: d.email } : {}),
    ...(d.ciudad !== undefined ? { ciudad: d.ciudad } : {}),
    ...(d.origen !== undefined ? { origen: d.origen as OrigenDeContacto } : {}),
    ...(d.tipoDeHuesped !== undefined ? { tipoDeHuesped: d.tipoDeHuesped } : {}),
    ...(d.notas !== undefined ? { notas: d.notas } : {}),
    ...(d.etiquetas !== undefined ? { etiquetas: d.etiquetas } : {}),
  };
}

@Controller('v1/contactos')
@UseGuards(AuthGuard)
export class ContactosController {
  constructor(@Inject(TOKEN_CONTACTOS) private readonly contactos: ContactosService) {}

  @Get()
  async listar(
    @Req() req: Req,
    @Query('q') q?: string,
    @Query('origen') origen?: string,
    @Query('etiqueta') etiquetaId?: string,
    @Query('cursor') cursor?: string,
    @Query('limite') limite?: string,
  ) {
    return conContextoDePeticion(req, () =>
      this.contactos.listar({
        q,
        origen,
        etiquetaId,
        cursor,
        ...(limite ? { limite: Number(limite) } : {}),
      }),
    );
  }

  /**
   * Va ANTES de `:id` a propósito: si no, «exportar» se leería como el
   * identificador de un cliente y devolvería un 404 desconcertante.
   *
   * Devuelve el CSV dentro de un JSON en vez de como descarga directa porque
   * la petición necesita la cabecera de sesión, y un enlace de descarga del
   * navegador no la lleva. El archivo lo arma la web.
   */
  @Get('exportar')
  async exportar(
    @Req() req: Req,
    @Query('q') q?: string,
    @Query('origen') origen?: string,
    @Query('etiqueta') etiquetaId?: string,
  ) {
    const csv = await conContextoDePeticion(req, () =>
      this.contactos.exportar({ q, origen, etiquetaId }),
    );
    const hoy = new Date().toISOString().slice(0, 10);
    return { csv, nombreDeArchivo: `clientes-${hoy}.csv` };
  }

  @Get(':id')
  async ficha(@Req() req: Req, @Param('id') id: string) {
    return conContextoDePeticion(req, () => this.contactos.ficha(id));
  }

  @Post()
  async crear(@Req() req: Req, @Body() cuerpo: unknown) {
    const datos = validar(Datos, cuerpo);
    return conContextoDePeticion(req, () => this.contactos.crear(soloPresentes(datos)));
  }

  @Post('importar')
  async importar(@Req() req: Req, @Body() cuerpo: unknown) {
    const { csv, prefijo } = validar(Importacion, cuerpo);
    return conContextoDePeticion(req, () =>
      this.contactos.importar(csv, { ...(prefijo ? { prefijo } : {}) }),
    );
  }

  @Patch(':id')
  async editar(@Req() req: Req, @Param('id') id: string, @Body() cuerpo: unknown) {
    const datos = validar(Edicion, cuerpo);
    await conContextoDePeticion(req, () => this.contactos.editar(id, soloPresentes(datos)));
    return { editado: true };
  }

  @Delete(':id')
  async borrar(@Req() req: Req, @Param('id') id: string) {
    return conContextoDePeticion(req, () => this.contactos.borrar(id));
  }
}

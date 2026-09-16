import { Controller, Get, Inject, Req, Res, UseGuards } from '@nestjs/common';
import { TOKEN_EVENTOS } from '../tokens.js';
import { AuthGuard } from '../auth/auth.guard.js';
import type { EventosService } from './eventos.service.js';

/** Lo mínimo de la respuesta HTTP que hace falta para un flujo SSE. */
interface RespuestaEnFlujo {
  writeHead(estado: number, cabeceras: Record<string, string>): void;
  write(trozo: string): void;
  end(): void;
  on(evento: string, fn: () => void): void;
  flushHeaders?: () => void;
}

/** Cada cuánto se manda un comentario para que nadie corte la conexión por inactividad. */
const LATIDO_MS = 25_000;

@Controller('v1/eventos')
@UseGuards(AuthGuard)
export class EventosController {
  constructor(@Inject(TOKEN_EVENTOS) private readonly eventos: EventosService) {}

  /**
   * Flujo de eventos de la cuenta (SSE).
   *
   * No devuelve nada que no se pueda ver ya: solo tipos e identificadores, y
   * solo del inquilino de la sesión. Quien recibe uno vuelve a pedir la lista
   * o la conversación por los endpoints de siempre, con sus permisos.
   */
  @Get()
  flujo(@Req() req: { contexto?: { tenantId: string } }, @Res() res: RespuestaEnFlujo): void {
    const tenantId = req.contexto?.tenantId;
    if (!tenantId) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.write(JSON.stringify({ codigo: 'sin_sesion', mensaje: 'Se requiere sesión.' }));
      res.end();
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Sin esto, un proxy que agrupe la salida retrasa justo lo que este
      // endpoint existe para evitar.
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(': conectado\n\n');

    const baja = this.eventos.suscribir(tenantId, (evento) => {
      res.write(`event: ${evento.tipo}\ndata: ${JSON.stringify(evento)}\n\n`);
    });
    const latido = setInterval(() => res.write(': latido\n\n'), LATIDO_MS);

    const cerrar = () => {
      clearInterval(latido);
      baja();
    };
    // Cerrar la pestaña, perder la red o reiniciar el navegador: todas acaban
    // aquí. Sin darse de baja, las escuchas muertas se acumularían.
    res.on('close', cerrar);
    res.on('error', cerrar);
  }
}

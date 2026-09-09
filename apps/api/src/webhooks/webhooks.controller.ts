import { Controller, Get, Head, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { TOKEN_INGESTA } from '../tokens.js';
import { FirmaInvalida, IngestaService } from './ingesta.service.js';

/**
 * Rutas de webhook.
 *
 * No llevan `AuthGuard`: quien llama es Meta, no un usuario con sesión. La
 * autenticación aquí **es la firma HMAC**, y por eso su verificación no es
 * negociable ni se puede saltar en desarrollo.
 *
 * Tampoco llevan prefijo de versión. Las URL de webhook se registran en el
 * panel de Meta y cambiarlas obliga a que cada cliente vuelva a configurar la
 * suya; una ruta estable vale más aquí que la coherencia con `/v1`.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(@Inject(TOKEN_INGESTA) private readonly ingesta: IngestaService) {}

  /**
   * Reto de alta del webhook.
   *
   * Meta llama en GET con `hub.challenge` y espera ese valor **en texto
   * plano**. Devolverlo como JSON hace que el alta falle sin explicar por qué.
   */
  @Get(':canal')
  desafio(
    @Param('canal') canal: string,
    @Query() parametros: Record<string, string | undefined>,
    @Res() res: { status: (n: number) => { send: (b: string) => void } },
  ): void {
    const respuesta = this.ingesta.desafio(canal, parametros);
    if (respuesta === null) {
      res.status(403).send('forbidden');
      return;
    }
    res.status(200).send(respuesta);
  }

  /** Algunos proveedores comprueban la URL con HEAD antes de darla de alta. */
  @Head(':canal')
  cabecera(): void {}

  /**
   * Recepción.
   *
   * Devuelve 200 en cuanto persiste y encola. Todo lo demás ocurre en workers.
   */
  @Post(':canal')
  async recibir(
    @Param('canal') canal: string,
    @Req() req: { rawBody?: Buffer; body?: unknown; headers: Record<string, string | undefined> },
    @Res() res: { status: (n: number) => { json: (b: unknown) => void } },
  ): Promise<void> {
    // `rawBody` y no `body`: la firma se calcula sobre los bytes exactos que
    // envió el proveedor. Re-serializar el objeto parseado cambia el orden de
    // las claves o el escapado de Unicode, y la firma deja de coincidir con un
    // error que parece de clave y no lo es.
    const cuerpoCrudo = req.rawBody ?? Buffer.alloc(0);

    try {
      const r = await this.ingesta.recibir(canal, { cuerpoCrudo, cabeceras: req.headers });
      res.status(200).json({ recibido: true, eventos: r.eventos });
    } catch (error) {
      if (error instanceof FirmaInvalida) {
        res.status(401).json({ codigo: 'firma_invalida' });
        return;
      }
      // Un 500 hace que Meta reintente, que es lo correcto ante un fallo
      // nuestro: el mensaje no se pierde. Lo que no se debe hacer es
      // devolver 200 tras un fallo, porque entonces sí se pierde.
      throw error;
    }
  }
}

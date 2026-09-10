/**
 * Salesbots: definir, versionar, publicar y auditar (ARCH §5.7, ADR-002).
 *
 * Aquí no corre ningún flujo. Esto es el editor: guarda grafos, los valida y
 * decide cuál es la versión publicada. Quien los ejecuta es el worker, que
 * lee la versión desde `flow_runs`.
 *
 * ## Dos reglas que no son negociables
 *
 * **Cada cambio es una versión nueva, nunca un `UPDATE` del grafo.** Si se
 * sobrescribiera, las cuatrocientas ejecuciones a medias saltarían a un grafo
 * distinto del que empezaron: nodos que ya no existen, ramas que cambiaron de
 * sentido. `flow_runs` apunta a `flow_version_id` justamente para eso.
 *
 * **Publicar valida.** Un flujo con un bucle sin espera manda mensajes hasta
 * que alguien lo apaga: cuesta dinero del cliente y su número acaba
 * reportado. Guardar un borrador roto es gratis; publicarlo, no.
 */
import type { PoolClient } from 'pg';
import { simular, validarGrafo, type Grafo, type Simulacion } from '@crmapp/core';
import { contextoActual, type BaseDeDatos } from '../db.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';

export interface Disparador {
  tipo: 'conversacion_abierta' | 'palabra_clave';
  palabras?: string[];
  activo?: boolean;
}

export interface ResumenDeFlujo {
  id: string;
  nombre: string;
  estado: 'borrador' | 'activo' | 'pausado' | string;
  version: number | null;
  disparadores: Disparador[];
  ejecucionesVivas: number;
  creadoEn: Date;
}

export interface DetalleDeFlujo extends ResumenDeFlujo {
  grafo: Grafo | null;
  /** Problemas del último grafo guardado. Vacío no significa publicado. */
  problemas: ReturnType<typeof validarGrafo>;
}

export interface PasoDeEjecucion {
  nodoId: string;
  tipo: string;
  entrada: unknown;
  salida: unknown;
  error: string | null;
  en: Date;
}

export interface EjecucionDeFlujo {
  id: string;
  conversacionId: string;
  estado: string;
  nodoActual: string | null;
  esperaHasta: Date | null;
  error: string | null;
  iniciadaEn: Date;
  terminadaEn: Date | null;
  pasos: PasoDeEjecucion[];
}

export class FlujosService {
  readonly #db: BaseDeDatos;

  constructor(opciones: { db: BaseDeDatos }) {
    this.#db = opciones.db;
  }

  async listar(): Promise<ResumenDeFlujo[]> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{
        id: string;
        nombre: string;
        estado: string;
        version: number | null;
        disparadores: Disparador[] | null;
        vivas: string;
        creado_en: Date;
      }>(
        `SELECT f.id, f.name AS nombre, f.status AS estado, v.version,
                (SELECT json_agg(json_build_object(
                          'tipo', t.type, 'palabras', t.config -> 'palabras', 'activo', t.enabled)
                        ORDER BY t.created_at)
                   FROM flow_triggers t WHERE t.flow_id = f.id) AS disparadores,
                (SELECT count(*) FROM flow_runs r
                  WHERE r.flow_id = f.id AND r.status IN ('running', 'waiting')) AS vivas,
                f.created_at AS creado_en
           FROM flows f
           LEFT JOIN flow_versions v ON v.id = f.current_version_id
          ORDER BY f.created_at`,
      );
      return rows.map((r) => ({
        id: r.id,
        nombre: r.nombre,
        estado: r.estado,
        version: r.version,
        disparadores: r.disparadores ?? [],
        ejecucionesVivas: Number(r.vivas),
        creadoEn: r.creado_en,
      }));
    });
  }

  async detalle(id: string): Promise<DetalleDeFlujo> {
    const resumen = (await this.listar()).find((f) => f.id === id);
    if (!resumen) throw new ErrorDeNegocio('flujo_no_encontrado', 'El flujo no existe.', 404);
    const grafo = await this.#db.enTransaccion(async (c) => this.#ultimoGrafo(c, id));
    return {
      ...resumen,
      grafo,
      problemas: grafo ? validarGrafo(grafo) : [],
    };
  }

  /** Crea el flujo con su primera versión, en borrador. Publicar es otro paso. */
  async crear(datos: {
    nombre: string;
    grafo: Grafo;
    disparadores: Disparador[];
  }): Promise<{ id: string; version: number }> {
    const ctx = this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const id = await this.#db.nuevoId(c);
      try {
        await c.query(
          `INSERT INTO flows (id, tenant_id, name, status, created_by) VALUES ($1, $2, $3, 'borrador', $4)`,
          [id, ctx.tenantId, datos.nombre, ctx.userId],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new ErrorDeNegocio('flujo_repetido', 'Ya existe un flujo con ese nombre.', 409);
        }
        throw error;
      }
      const version = await this.#nuevaVersion(c, ctx.tenantId, id, datos.grafo, ctx.userId);
      await this.#reemplazarDisparadores(c, ctx.tenantId, id, datos.disparadores);
      return { id, version };
    });
  }

  /** Guardar cambios es crear una versión. El grafo anterior no se toca jamás. */
  async guardarVersion(
    id: string,
    datos: { nombre?: string; grafo?: Grafo; disparadores?: Disparador[] },
  ): Promise<{ version: number | null }> {
    const ctx = this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      await this.#exigirFlujo(c, id);
      if (datos.nombre) {
        await c.query(`UPDATE flows SET name = $2, updated_at = now() WHERE id = $1`, [
          id,
          datos.nombre,
        ]);
      }
      if (datos.disparadores) {
        await this.#reemplazarDisparadores(c, ctx.tenantId, id, datos.disparadores);
      }
      if (!datos.grafo) return { version: null };
      const version = await this.#nuevaVersion(c, ctx.tenantId, id, datos.grafo, ctx.userId);
      return { version };
    });
  }

  /**
   * Publica la última versión guardada: la valida y la deja como la que
   * dispara. Las ejecuciones en vuelo siguen con la suya.
   */
  async publicar(id: string): Promise<{ version: number }> {
    const ctx = this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      await this.#exigirFlujo(c, id);
      const { rows } = await c.query<{ id: string; version: number; graph: Grafo }>(
        `SELECT id, version, graph FROM flow_versions
          WHERE flow_id = $1 ORDER BY version DESC LIMIT 1`,
        [id],
      );
      const ultima = rows[0];
      if (!ultima) throw new ErrorDeNegocio('flujo_sin_version', 'El flujo no tiene pasos.', 409);

      const problemas = validarGrafo(ultima.graph);
      if (problemas.length > 0) {
        throw new ErrorDeNegocio(
          'flujo_invalido',
          'El flujo tiene errores que hay que corregir antes de activarlo.',
          422,
          { problemas },
        );
      }

      const { rows: disparadores } = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM flow_triggers WHERE flow_id = $1 AND enabled`,
        [id],
      );
      if (Number(disparadores[0]?.n ?? 0) === 0) {
        throw new ErrorDeNegocio(
          'flujo_sin_disparador',
          'Un flujo sin disparador no se ejecutaría nunca. Añade uno antes de activarlo.',
          422,
        );
      }

      await c.query(
        `UPDATE flows SET current_version_id = $2, status = 'activo', updated_at = now() WHERE id = $1`,
        [id, ultima.id],
      );
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'flujo.publicado', 'flow', $3, $4)`,
        [ctx.tenantId, ctx.userId, id, JSON.stringify({ version: ultima.version })],
      );
      return { version: ultima.version };
    });
  }

  /**
   * Pausar NO cancela lo que ya está corriendo: deja de disparar y punto.
   * Cortar a mitad una conversación con un contacto es peor que dejar que
   * termine — el contacto se queda esperando una respuesta que no llega.
   */
  async pausar(id: string): Promise<void> {
    const ctx = this.#exigirContexto();
    await this.#db.enTransaccion(async (c) => {
      await this.#exigirFlujo(c, id);
      await c.query(`UPDATE flows SET status = 'pausado', updated_at = now() WHERE id = $1`, [id]);
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id)
         VALUES ($1, $2, 'flujo.pausado', 'flow', $3)`,
        [ctx.tenantId, ctx.userId, id],
      );
    });
  }

  /** Ejecuciones con su log paso a paso: la respuesta a «¿por qué dijo eso?». */
  async ejecuciones(id: string, limite = 20): Promise<EjecucionDeFlujo[]> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      await this.#exigirFlujo(c, id);
      const { rows } = await c.query<{
        id: string;
        conversation_id: string;
        status: string;
        current_node_id: string | null;
        wait_until: Date | null;
        error: string | null;
        started_at: Date;
        ended_at: Date | null;
        pasos:
          | {
              nodoId: string;
              tipo: string;
              entrada: unknown;
              salida: unknown;
              error: string | null;
              en: string;
            }[]
          | null;
      }>(
        `SELECT r.id, r.conversation_id, r.status, r.current_node_id, r.wait_until, r.error,
                r.started_at, r.ended_at,
                (SELECT json_agg(json_build_object(
                          'nodoId', s.node_id, 'tipo', s.kind, 'entrada', s.input,
                          'salida', s.output, 'error', s.error, 'en', s.at) ORDER BY s.at)
                   FROM flow_run_steps s WHERE s.flow_run_id = r.id) AS pasos
           FROM flow_runs r
          WHERE r.flow_id = $1
          ORDER BY r.started_at DESC
          LIMIT $2`,
        [id, limite],
      );
      return rows.map((r) => ({
        id: r.id,
        conversacionId: r.conversation_id,
        estado: r.status,
        nodoActual: r.current_node_id,
        esperaHasta: r.wait_until,
        error: r.error,
        iniciadaEn: r.started_at,
        terminadaEn: r.ended_at,
        pasos: (r.pasos ?? []).map((p) => ({ ...p, en: new Date(p.en) })),
      }));
    });
  }

  /**
   * Modo prueba: recorre el flujo con respuestas de mentira y devuelve lo que
   * HABRÍA hecho. No toca la base ni la cola — es `packages/core` puro, así
   * que no hay forma de que se escape un mensaje real.
   */
  probar(
    grafo: Grafo,
    respuestas: string[],
  ): Simulacion & { problemas: ReturnType<typeof validarGrafo> } {
    this.#exigirContexto();
    const problemas = validarGrafo(grafo);
    return { ...simular(grafo, respuestas), problemas };
  }

  // -------------------------------------------------------------------------

  async #nuevaVersion(
    c: PoolClient,
    tenantId: string,
    flowId: string,
    grafo: Grafo,
    userId: string,
  ): Promise<number> {
    const { rows } = await c.query<{ siguiente: number }>(
      `SELECT COALESCE(max(version), 0) + 1 AS siguiente FROM flow_versions WHERE flow_id = $1`,
      [flowId],
    );
    const version = rows[0]!.siguiente;
    await c.query(
      `INSERT INTO flow_versions (tenant_id, flow_id, version, graph, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, flowId, version, JSON.stringify(grafo), userId],
    );
    await c.query(`UPDATE flows SET updated_at = now() WHERE id = $1`, [flowId]);
    return version;
  }

  async #reemplazarDisparadores(
    c: PoolClient,
    tenantId: string,
    flowId: string,
    disparadores: Disparador[],
  ): Promise<void> {
    await c.query(`DELETE FROM flow_triggers WHERE flow_id = $1`, [flowId]);
    for (const d of disparadores) {
      await c.query(
        `INSERT INTO flow_triggers (tenant_id, flow_id, type, config, enabled)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          tenantId,
          flowId,
          d.tipo,
          JSON.stringify(d.tipo === 'palabra_clave' ? { palabras: d.palabras ?? [] } : {}),
          d.activo !== false,
        ],
      );
    }
  }

  async #ultimoGrafo(c: PoolClient, flowId: string): Promise<Grafo | null> {
    const { rows } = await c.query<{ graph: Grafo }>(
      `SELECT graph FROM flow_versions WHERE flow_id = $1 ORDER BY version DESC LIMIT 1`,
      [flowId],
    );
    return rows[0]?.graph ?? null;
  }

  async #exigirFlujo(c: PoolClient, id: string): Promise<void> {
    const { rows } = await c.query(`SELECT 1 FROM flows WHERE id = $1`, [id]);
    // RLS ya filtra por inquilino: uno ajeno simplemente no existe desde aquí.
    if (rows.length === 0)
      throw new ErrorDeNegocio('flujo_no_encontrado', 'El flujo no existe.', 404);
  }

  #exigirContexto() {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    return ctx;
  }
}

/**
 * El embudo de ventas: tablero, etapas y leads (migración 0018).
 *
 * ## Qué es un lead aquí, y qué no
 *
 * Un lead es una **oportunidad de venta**, no un hilo de conversación. Cuelga
 * del contacto y guarda la conversación que lo originó. El mismo cliente que
 * vuelve en agosto abre un lead nuevo sin tocar el de marzo: así el historial
 * sigue valiendo y el pronóstico cuenta una vez cada venta.
 *
 * ## Lo que decide el pronóstico es el TIPO de la etapa, no su nombre
 *
 * El cliente llama a sus columnas como quiere —«Recojo en tienda» es una
 * etapa perfectamente legítima— pero cada una declara si es `abierta`,
 * `ganada` o `perdida`. Sumar «lo que está en juego» mirando nombres de
 * columna sería una cuenta que se rompe la primera vez que alguien renombra
 * algo.
 *
 * ## Visibilidad
 *
 * La política de la cuenta (ADR-008) se escribió para conversaciones y habla
 * de equipos; los leads no tienen equipo. Aquí se aplica por **responsable**:
 * con `assigned`, el agente ve los suyos; con `team`, los suyos y los que no
 * tienen dueño. Es algo MÁS restrictivo que en la bandeja, y ese es el lado
 * correcto en el que equivocarse.
 */
import type { PoolClient } from 'pg';
import { contextoActual, type BaseDeDatos } from '../db.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';

/** Cuántas tarjetas se cargan por columna. El resto se cuenta, no se manda. */
const TARJETAS_POR_COLUMNA = 25;

export type TipoDeEtapa = 'abierta' | 'ganada' | 'perdida';

export interface EtapaDeEmbudo {
  id: string;
  nombre: string;
  color: string | null;
  tipo: TipoDeEtapa;
  posicion: number;
}

export interface Embudo {
  id: string;
  nombre: string;
  moneda: string;
  porDefecto: boolean;
  etapas: EtapaDeEmbudo[];
}

export interface EtiquetaDeLead {
  id: string;
  nombre: string;
  color: string | null;
}

export interface TarjetaDeLead {
  id: string;
  titulo: string;
  importe: number;
  contacto: { id: string; nombre: string | null };
  conversacionId: string | null;
  canal: string | null;
  responsableId: string | null;
  etiquetas: EtiquetaDeLead[];
  creadoEn: Date;
  actualizadoEn: Date;
}

export interface ColumnaDelTablero {
  etapa: EtapaDeEmbudo;
  /** Todas las de la etapa, aunque solo viajen las primeras. */
  total: number;
  importe: number;
  tarjetas: TarjetaDeLead[];
}

export interface Tablero {
  embudo: { id: string; nombre: string; moneda: string };
  columnas: ColumnaDelTablero[];
  /** Suma de lo que sigue en juego: solo etapas abiertas. */
  pronostico: number;
  leadsAbiertos: number;
}

export interface DetalleDeLead extends TarjetaDeLead {
  embudoId: string;
  etapaId: string;
  estado: 'abierto' | 'ganado' | 'perdido';
  cerradoEn: Date | null;
  historial: {
    tipo: string;
    desde: string | null;
    hasta: string | null;
    actorId: string | null;
    en: Date;
  }[];
}

interface FiltrosDeTablero {
  embudoId?: string | undefined;
  /** Busca en el título del lead y en el nombre del contacto. */
  q?: string | undefined;
  responsableId?: string | undefined;
  etiquetaId?: string | undefined;
}

export class EmbudoService {
  readonly #db: BaseDeDatos;

  constructor(opciones: { db: BaseDeDatos }) {
    this.#db = opciones.db;
  }

  // -------------------------------------------------------------------------
  // Embudos y etapas
  // -------------------------------------------------------------------------

  async embudos(): Promise<Embudo[]> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows: embudos } = await c.query<{
        id: string;
        name: string;
        currency: string;
        is_default: boolean;
      }>(`SELECT id, name, currency, is_default FROM pipelines ORDER BY position, created_at`);
      const { rows: etapas } = await c.query<{
        id: string;
        pipeline_id: string;
        name: string;
        color: string | null;
        kind: TipoDeEtapa;
        position: number;
      }>(
        `SELECT id, pipeline_id, name, color, kind, position
           FROM pipeline_stages ORDER BY position, created_at`,
      );
      return embudos.map((e) => ({
        id: e.id,
        nombre: e.name,
        moneda: e.currency,
        porDefecto: e.is_default,
        etapas: etapas
          .filter((s) => s.pipeline_id === e.id)
          .map((s) => ({
            id: s.id,
            nombre: s.name,
            color: s.color,
            tipo: s.kind,
            posicion: s.position,
          })),
      }));
    });
  }

  async crearEtapa(
    embudoId: string,
    datos: { nombre: string; color?: string | null; tipo?: TipoDeEtapa },
  ): Promise<EtapaDeEmbudo> {
    const ctx = this.#exigirContexto();
    this.#exigirMando(ctx.rol);
    return this.#db.enTransaccion(async (c) => {
      await this.#exigirEmbudo(c, embudoId);
      // La etapa nueva entra ANTES de las terminales: nadie quiere una columna
      // nueva detrás de «Venta perdida», y arrastrarla hasta su sitio cada vez
      // sería una tarea inventada.
      const tipo = datos.tipo ?? 'abierta';
      const { rows: sitio } = await c.query<{ antes: number | null; final: number | null }>(
        `SELECT min(position) FILTER (WHERE kind <> 'abierta') AS antes,
                max(position) + 1 AS final
           FROM pipeline_stages WHERE pipeline_id = $1`,
        [embudoId],
      );
      const antes = tipo === 'abierta' ? (sitio[0]?.antes ?? null) : null;
      const posicion = antes ?? sitio[0]?.final ?? 0;
      if (antes !== null) {
        await c.query(
          `UPDATE pipeline_stages SET position = position + 1, updated_at = now()
            WHERE pipeline_id = $1 AND position >= $2`,
          [embudoId, posicion],
        );
      }
      const creada = await c
        .query<{
          id: string;
          name: string;
          color: string | null;
          kind: TipoDeEtapa;
          position: number;
        }>(
          `INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, color, kind, position)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, name, color, kind, position`,
          [ctx.tenantId, embudoId, datos.nombre.trim(), datos.color ?? null, tipo, posicion],
        )
        .catch(this.#nombreRepetido);
      const f = creada.rows[0]!;
      return { id: f.id, nombre: f.name, color: f.color, tipo: f.kind, posicion: f.position };
    });
  }

  async editarEtapa(
    etapaId: string,
    datos: { nombre?: string; color?: string | null; tipo?: TipoDeEtapa },
  ): Promise<void> {
    const ctx = this.#exigirContexto();
    this.#exigirMando(ctx.rol);
    await this.#db.enTransaccion(async (c) => {
      const etapa = await this.#exigirEtapa(c, etapaId);
      const tipo = datos.tipo ?? etapa.kind;
      await c
        .query(
          `UPDATE pipeline_stages
              SET name = COALESCE($2, name),
                  color = CASE WHEN $3::boolean THEN $4 ELSE color END,
                  kind = $5,
                  updated_at = now()
            WHERE id = $1`,
          [
            etapaId,
            datos.nombre?.trim() ?? null,
            datos.color !== undefined,
            datos.color ?? null,
            tipo,
          ],
        )
        .catch(this.#nombreRepetido);

      // Cambiar el tipo de una etapa cambia el estado de lo que hay dentro: si
      // «Cotización enviada» pasa a contar como ganada, esos leads están
      // cerrados desde ya. Dejar el estado viejo haría que el pronóstico y el
      // tablero contaran cosas distintas.
      if (tipo !== etapa.kind) {
        const estado = tipo === 'abierta' ? 'abierto' : tipo === 'ganada' ? 'ganado' : 'perdido';
        await c.query(
          `UPDATE leads
              SET status = $2,
                  closed_at = CASE WHEN $2 = 'abierto' THEN NULL ELSE COALESCE(closed_at, now()) END,
                  updated_at = now()
            WHERE stage_id = $1`,
          [etapaId, estado],
        );
      }
    });
  }

  /**
   * Borra una etapa. Los leads que tuviera se mueven a `destinoId`, que es
   * obligatorio si hay alguno: una etapa no se lleva por delante trabajo del
   * cliente, y «¿seguro?» no es un sitio donde guardar veinte ventas.
   */
  async borrarEtapa(etapaId: string, destinoId: string | null): Promise<void> {
    const ctx = this.#exigirContexto();
    this.#exigirMando(ctx.rol);
    await this.#db.enTransaccion(async (c) => {
      const etapa = await this.#exigirEtapa(c, etapaId);
      const { rows: resto } = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM pipeline_stages WHERE pipeline_id = $1 AND id <> $2`,
        [etapa.pipeline_id, etapaId],
      );
      if (Number(resto[0]?.n ?? 0) === 0) {
        throw new ErrorDeNegocio(
          'ultima_etapa',
          'Un embudo sin etapas no es un embudo. Crea otra antes de borrar esta.',
          409,
        );
      }
      const { rows: dentro } = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM leads WHERE stage_id = $1`,
        [etapaId],
      );
      const cuantos = Number(dentro[0]?.n ?? 0);
      if (cuantos > 0) {
        if (!destinoId) {
          throw new ErrorDeNegocio(
            'etapa_con_leads',
            `La etapa tiene ${cuantos} lead(s). Elige a qué etapa se mueven.`,
            409,
            { leads: cuantos },
          );
        }
        const destino = await this.#exigirEtapa(c, destinoId);
        if (destino.pipeline_id !== etapa.pipeline_id) {
          throw new ErrorDeNegocio('etapa_de_otro_embudo', 'Esa etapa es de otro embudo.', 422);
        }
        const estado =
          destino.kind === 'abierta' ? 'abierto' : destino.kind === 'ganada' ? 'ganado' : 'perdido';
        // Los ids se toman ANTES de mover: después, «los que están en el
        // destino» incluiría a los que ya estaban allí.
        const { rows: movidos } = await c.query<{ id: string }>(
          `UPDATE leads SET stage_id = $2, status = $3,
                  closed_at = CASE WHEN $3 = 'abierto' THEN NULL ELSE COALESCE(closed_at, now()) END,
                  updated_at = now()
            WHERE stage_id = $1
            RETURNING id`,
          [etapaId, destinoId, estado],
        );
        for (const m of movidos) {
          await c.query(
            `INSERT INTO lead_events (tenant_id, lead_id, type, to_stage_id, actor_user_id, meta)
             VALUES ($1, $2, 'etapa_borrada', $3, $4, $5)`,
            [ctx.tenantId, m.id, destinoId, ctx.userId, JSON.stringify({ etapa: etapa.name })],
          );
        }
      }
      await c.query(`DELETE FROM pipeline_stages WHERE id = $1`, [etapaId]);
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'embudo.etapa_borrada', 'pipeline_stage', $3, $4)`,
        [ctx.tenantId, ctx.userId, etapaId, JSON.stringify({ nombre: etapa.name, destinoId })],
      );
    });
  }

  /** Reordena por la lista entera: es lo único que no deja huecos ni empates. */
  async ordenarEtapas(embudoId: string, ids: string[]): Promise<void> {
    const ctx = this.#exigirContexto();
    this.#exigirMando(ctx.rol);
    await this.#db.enTransaccion(async (c) => {
      await this.#exigirEmbudo(c, embudoId);
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM pipeline_stages WHERE pipeline_id = $1`,
        [embudoId],
      );
      const propias = new Set(rows.map((r) => r.id));
      if (ids.length !== propias.size || ids.some((id) => !propias.has(id))) {
        throw new ErrorDeNegocio(
          'orden_incompleto',
          'El orden tiene que incluir todas las etapas del embudo, y solo esas.',
          422,
        );
      }
      for (const [i, id] of ids.entries()) {
        await c.query(
          `UPDATE pipeline_stages SET position = $2, updated_at = now() WHERE id = $1`,
          [id, i],
        );
      }
    });
  }

  // -------------------------------------------------------------------------
  // El tablero
  // -------------------------------------------------------------------------

  async tablero(filtros: FiltrosDeTablero = {}): Promise<Tablero> {
    const ctx = this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const embudo = await this.#embudoElegido(c, filtros.embudoId);
      const etapas = (
        await c.query<{
          id: string;
          name: string;
          color: string | null;
          kind: TipoDeEtapa;
          position: number;
        }>(
          `SELECT id, name, color, kind, position FROM pipeline_stages
            WHERE pipeline_id = $1 ORDER BY position, created_at`,
          [embudo.id],
        )
      ).rows;

      const params: unknown[] = [embudo.id];
      const p = (v: unknown) => `$${params.push(v)}`;
      const donde = [`l.pipeline_id = $1`];
      if (filtros.q) {
        const patron = `%${filtros.q.trim()}%`;
        donde.push(`(l.title ILIKE ${p(patron)} OR ct.display_name ILIKE ${p(patron)})`);
      }
      if (filtros.responsableId) donde.push(`l.assignee_user_id = ${p(filtros.responsableId)}`);
      if (filtros.etiquetaId) {
        donde.push(
          `EXISTS (SELECT 1 FROM lead_tags lt WHERE lt.lead_id = l.id AND lt.tag_id = ${p(filtros.etiquetaId)})`,
        );
      }
      const vis = await this.#visibilidadDeLeads(c, ctx);
      if (vis === 'propios') donde.push(`l.assignee_user_id = ${p(ctx.userId)}`);
      if (vis === 'propios_y_libres') {
        donde.push(`(l.assignee_user_id = ${p(ctx.userId)} OR l.assignee_user_id IS NULL)`);
      }
      const filtro = donde.join(' AND ');

      const { rows: totales } = await c.query<{
        stage_id: string;
        n: string;
        importe: string | null;
      }>(
        `SELECT l.stage_id, count(*) AS n, sum(l.amount_cents) AS importe
           FROM leads l JOIN contacts ct ON ct.id = l.contact_id
          WHERE ${filtro}
          GROUP BY l.stage_id`,
        params,
      );

      // Las primeras N de cada columna en UNA consulta. La alternativa —una
      // consulta por columna— multiplica los viajes por el número de etapas,
      // que es justo lo que el cliente puede aumentar desde la interfaz.
      const { rows: tarjetas } = await c.query<{
        id: string;
        stage_id: string;
        title: string;
        amount_cents: string;
        contact_id: string;
        display_name: string | null;
        conversation_id: string | null;
        canal: string | null;
        assignee_user_id: string | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT * FROM (
           SELECT l.id, l.stage_id, l.title, l.amount_cents, l.contact_id,
                  ct.display_name, l.conversation_id, ca.channel AS canal,
                  l.assignee_user_id, l.created_at, l.updated_at,
                  row_number() OVER (PARTITION BY l.stage_id ORDER BY l.updated_at DESC) AS rn
             FROM leads l
             JOIN contacts ct ON ct.id = l.contact_id
             LEFT JOIN conversations cv ON cv.id = l.conversation_id
             LEFT JOIN channel_accounts ca ON ca.id = cv.channel_account_id
            WHERE ${filtro}
         ) x WHERE rn <= ${TARJETAS_POR_COLUMNA}`,
        params,
      );

      const etiquetas = await this.#etiquetasDe(
        c,
        tarjetas.map((t) => t.id),
      );

      const columnas: ColumnaDelTablero[] = etapas.map((e) => {
        const t = totales.find((x) => x.stage_id === e.id);
        return {
          etapa: { id: e.id, nombre: e.name, color: e.color, tipo: e.kind, posicion: e.position },
          total: Number(t?.n ?? 0),
          importe: Number(t?.importe ?? 0),
          tarjetas: tarjetas
            .filter((x) => x.stage_id === e.id)
            .map((x) => ({
              id: x.id,
              titulo: x.title,
              importe: Number(x.amount_cents),
              contacto: { id: x.contact_id, nombre: x.display_name },
              conversacionId: x.conversation_id,
              canal: x.canal,
              responsableId: x.assignee_user_id,
              etiquetas: etiquetas.get(x.id) ?? [],
              creadoEn: x.created_at,
              actualizadoEn: x.updated_at,
            })),
        };
      });

      const abiertas = new Set(etapas.filter((e) => e.kind === 'abierta').map((e) => e.id));
      const enJuego = columnas.filter((c2) => abiertas.has(c2.etapa.id));
      return {
        embudo: { id: embudo.id, nombre: embudo.name, moneda: embudo.currency },
        columnas,
        pronostico: enJuego.reduce((s, c2) => s + c2.importe, 0),
        leadsAbiertos: enJuego.reduce((s, c2) => s + c2.total, 0),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Leads
  // -------------------------------------------------------------------------

  async lead(id: string): Promise<DetalleDeLead> {
    const ctx = this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{
        id: string;
        pipeline_id: string;
        stage_id: string;
        title: string;
        amount_cents: string;
        status: 'abierto' | 'ganado' | 'perdido';
        contact_id: string;
        display_name: string | null;
        conversation_id: string | null;
        canal: string | null;
        assignee_user_id: string | null;
        created_at: Date;
        updated_at: Date;
        closed_at: Date | null;
      }>(
        `SELECT l.id, l.pipeline_id, l.stage_id, l.title, l.amount_cents, l.status,
                l.contact_id, ct.display_name, l.conversation_id, ca.channel AS canal,
                l.assignee_user_id, l.created_at, l.updated_at, l.closed_at
           FROM leads l
           JOIN contacts ct ON ct.id = l.contact_id
           LEFT JOIN conversations cv ON cv.id = l.conversation_id
           LEFT JOIN channel_accounts ca ON ca.id = cv.channel_account_id
          WHERE l.id = $1`,
        [id],
      );
      const f = rows[0];
      if (!f) throw new ErrorDeNegocio('lead_no_encontrado', 'Ese lead no existe.', 404);
      const vis = await this.#visibilidadDeLeads(c, ctx);
      if (vis === 'propios' && f.assignee_user_id !== ctx.userId) {
        throw new ErrorDeNegocio('lead_no_encontrado', 'Ese lead no existe.', 404);
      }
      if (
        vis === 'propios_y_libres' &&
        f.assignee_user_id !== null &&
        f.assignee_user_id !== ctx.userId
      ) {
        throw new ErrorDeNegocio('lead_no_encontrado', 'Ese lead no existe.', 404);
      }

      const { rows: historial } = await c.query<{
        type: string;
        desde: string | null;
        hasta: string | null;
        actor_user_id: string | null;
        at: Date;
      }>(
        `SELECT e.type, d.name AS desde, h.name AS hasta, e.actor_user_id, e.at
           FROM lead_events e
           LEFT JOIN pipeline_stages d ON d.id = e.from_stage_id
           LEFT JOIN pipeline_stages h ON h.id = e.to_stage_id
          WHERE e.lead_id = $1
          ORDER BY e.at DESC
          LIMIT 50`,
        [id],
      );
      const etiquetas = await this.#etiquetasDe(c, [id]);
      return {
        id: f.id,
        embudoId: f.pipeline_id,
        etapaId: f.stage_id,
        titulo: f.title,
        importe: Number(f.amount_cents),
        estado: f.status,
        contacto: { id: f.contact_id, nombre: f.display_name },
        conversacionId: f.conversation_id,
        canal: f.canal,
        responsableId: f.assignee_user_id,
        etiquetas: etiquetas.get(id) ?? [],
        creadoEn: f.created_at,
        actualizadoEn: f.updated_at,
        cerradoEn: f.closed_at,
        historial: historial.map((h) => ({
          tipo: h.type,
          desde: h.desde,
          hasta: h.hasta,
          actorId: h.actor_user_id,
          en: h.at,
        })),
      };
    });
  }

  async crear(datos: {
    contactoId: string;
    titulo: string;
    importe?: number;
    etapaId?: string;
    responsableId?: string | null;
  }): Promise<{ id: string }> {
    const ctx = this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows: contacto } = await c.query(`SELECT 1 FROM contacts WHERE id = $1`, [
        datos.contactoId,
      ]);
      if (contacto.length === 0) {
        throw new ErrorDeNegocio('contacto_no_encontrado', 'Ese contacto no existe.', 404);
      }
      const etapa = datos.etapaId
        ? await this.#exigirEtapa(c, datos.etapaId)
        : await this.#primeraEtapa(c);
      const estado =
        etapa.kind === 'abierta' ? 'abierto' : etapa.kind === 'ganada' ? 'ganado' : 'perdido';
      const { rows } = await c
        .query<{ id: string }>(
          `INSERT INTO leads (tenant_id, pipeline_id, stage_id, contact_id, title,
                              amount_cents, status, assignee_user_id, created_by, closed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                   CASE WHEN $7 = 'abierto' THEN NULL ELSE now() END)
           RETURNING id`,
          [
            ctx.tenantId,
            etapa.pipeline_id,
            etapa.id,
            datos.contactoId,
            datos.titulo.trim(),
            Math.max(0, Math.round(datos.importe ?? 0)),
            estado,
            datos.responsableId ?? null,
            ctx.userId,
          ],
        )
        .catch((e: { code?: string }) => {
          if (e.code === '23505') {
            throw new ErrorDeNegocio(
              'lead_abierto_existente',
              'Ese contacto ya tiene un lead abierto en este embudo. Ciérralo o edita el que hay.',
              409,
            );
          }
          throw e;
        });
      const id = rows[0]!.id;
      await c.query(
        `INSERT INTO lead_events (tenant_id, lead_id, type, to_stage_id, actor_user_id)
         VALUES ($1, $2, 'creado', $3, $4)`,
        [ctx.tenantId, id, etapa.id, ctx.userId],
      );
      return { id };
    });
  }

  async editar(
    id: string,
    datos: {
      etapaId?: string;
      titulo?: string;
      importe?: number;
      responsableId?: string | null;
      etiquetas?: string[];
    },
  ): Promise<void> {
    const ctx = this.#exigirContexto();
    await this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{ stage_id: string; pipeline_id: string }>(
        `SELECT stage_id, pipeline_id FROM leads WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const actual = rows[0];
      if (!actual) throw new ErrorDeNegocio('lead_no_encontrado', 'Ese lead no existe.', 404);

      let estado: string | null = null;
      if (datos.etapaId && datos.etapaId !== actual.stage_id) {
        const etapa = await this.#exigirEtapa(c, datos.etapaId);
        if (etapa.pipeline_id !== actual.pipeline_id) {
          throw new ErrorDeNegocio('etapa_de_otro_embudo', 'Esa etapa es de otro embudo.', 422);
        }
        estado =
          etapa.kind === 'abierta' ? 'abierto' : etapa.kind === 'ganada' ? 'ganado' : 'perdido';
      }

      await c.query(
        `UPDATE leads
            SET stage_id = COALESCE($2, stage_id),
                title = COALESCE($3, title),
                amount_cents = COALESCE($4, amount_cents),
                assignee_user_id = CASE WHEN $5::boolean THEN $6 ELSE assignee_user_id END,
                status = COALESCE($7, status),
                closed_at = CASE
                  WHEN $7 IS NULL THEN closed_at
                  WHEN $7 = 'abierto' THEN NULL
                  ELSE COALESCE(closed_at, now()) END,
                updated_at = now()
          WHERE id = $1`,
        [
          id,
          datos.etapaId ?? null,
          datos.titulo?.trim() ?? null,
          datos.importe === undefined ? null : Math.max(0, Math.round(datos.importe)),
          datos.responsableId !== undefined,
          datos.responsableId ?? null,
          estado,
        ],
      );

      if (estado !== null) {
        await c.query(
          `INSERT INTO lead_events (tenant_id, lead_id, type, from_stage_id, to_stage_id, actor_user_id)
           VALUES ($1, $2, 'movido', $3, $4, $5)`,
          [ctx.tenantId, id, actual.stage_id, datos.etapaId, ctx.userId],
        );
      }

      if (datos.etiquetas) {
        await c.query(`DELETE FROM lead_tags WHERE lead_id = $1`, [id]);
        for (const tagId of datos.etiquetas) {
          await c.query(
            `INSERT INTO lead_tags (tenant_id, lead_id, tag_id)
             SELECT $1, $2, id FROM tags WHERE id = $3
             ON CONFLICT DO NOTHING`,
            [ctx.tenantId, id, tagId],
          );
        }
      }
    });
  }

  async borrar(id: string): Promise<void> {
    const ctx = this.#exigirContexto();
    this.#exigirMando(ctx.rol);
    await this.#db.enTransaccion(async (c) => {
      const { rowCount } = await c.query(`DELETE FROM leads WHERE id = $1`, [id]);
      if (rowCount === 0) {
        throw new ErrorDeNegocio('lead_no_encontrado', 'Ese lead no existe.', 404);
      }
      // Borrar un lead borra una venta del historial: queda en la auditoría de
      // la cuenta aunque la fila ya no esté.
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id)
         VALUES ($1, $2, 'lead.borrado', 'lead', $3)`,
        [ctx.tenantId, ctx.userId, id],
      );
    });
  }

  // -------------------------------------------------------------------------
  // Interno
  // -------------------------------------------------------------------------

  async #etiquetasDe(c: PoolClient, ids: string[]): Promise<Map<string, EtiquetaDeLead[]>> {
    const mapa = new Map<string, EtiquetaDeLead[]>();
    if (ids.length === 0) return mapa;
    const { rows } = await c.query<{
      lead_id: string;
      id: string;
      name: string;
      color: string | null;
    }>(
      `SELECT lt.lead_id, t.id, t.name, t.color
         FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id
        WHERE lt.lead_id = ANY($1::uuid[])
        ORDER BY t.name`,
      [ids],
    );
    for (const r of rows) {
      const lista = mapa.get(r.lead_id) ?? [];
      lista.push({ id: r.id, nombre: r.name, color: r.color });
      mapa.set(r.lead_id, lista);
    }
    return mapa;
  }

  async #embudoElegido(
    c: PoolClient,
    id?: string,
  ): Promise<{ id: string; name: string; currency: string }> {
    const { rows } = await c.query<{ id: string; name: string; currency: string }>(
      id
        ? `SELECT id, name, currency FROM pipelines WHERE id = $1`
        : `SELECT id, name, currency FROM pipelines ORDER BY is_default DESC, position LIMIT 1`,
      id ? [id] : [],
    );
    const f = rows[0];
    if (!f) throw new ErrorDeNegocio('embudo_no_encontrado', 'Ese embudo no existe.', 404);
    return f;
  }

  async #exigirEmbudo(c: PoolClient, id: string): Promise<void> {
    await this.#embudoElegido(c, id);
  }

  async #exigirEtapa(
    c: PoolClient,
    id: string,
  ): Promise<{ id: string; pipeline_id: string; name: string; kind: TipoDeEtapa }> {
    const { rows } = await c.query<{
      id: string;
      pipeline_id: string;
      name: string;
      kind: TipoDeEtapa;
    }>(`SELECT id, pipeline_id, name, kind FROM pipeline_stages WHERE id = $1`, [id]);
    const f = rows[0];
    if (!f) throw new ErrorDeNegocio('etapa_no_encontrada', 'Esa etapa no existe.', 404);
    return f;
  }

  async #primeraEtapa(
    c: PoolClient,
  ): Promise<{ id: string; pipeline_id: string; name: string; kind: TipoDeEtapa }> {
    const { rows } = await c.query<{
      id: string;
      pipeline_id: string;
      name: string;
      kind: TipoDeEtapa;
    }>(
      `SELECT s.id, s.pipeline_id, s.name, s.kind
         FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
        ORDER BY p.is_default DESC, p.position, s.position
        LIMIT 1`,
    );
    const f = rows[0];
    if (!f) throw new ErrorDeNegocio('embudo_sin_etapas', 'El embudo no tiene etapas.', 409);
    return f;
  }

  /** Mismo criterio que la bandeja: quien supervisa, ve todo. */
  async #visibilidadDeLeads(
    c: PoolClient,
    ctx: { tenantId: string; rol: string },
  ): Promise<'todos' | 'propios' | 'propios_y_libres'> {
    if (ctx.rol !== 'agent') return 'todos';
    const { rows } = await c.query<{ modo: 'all' | 'team' | 'assigned' }>(
      `SELECT conversation_visibility AS modo FROM tenants WHERE id = $1`,
      [ctx.tenantId],
    );
    const modo = rows[0]?.modo ?? 'all';
    if (modo === 'all') return 'todos';
    return modo === 'assigned' ? 'propios' : 'propios_y_libres';
  }

  #nombreRepetido = (e: { code?: string }): never => {
    if (e.code === '23505') {
      throw new ErrorDeNegocio('etapa_repetida', 'Ya hay una etapa con ese nombre.', 409);
    }
    throw e;
  };

  #exigirMando(rol: string): void {
    if (rol !== 'owner' && rol !== 'admin') {
      throw new ErrorDeNegocio(
        'permiso_insuficiente',
        'Solo el propietario o un administrador puede cambiar el embudo.',
        403,
      );
    }
  }

  #exigirContexto() {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    return ctx;
  }
}

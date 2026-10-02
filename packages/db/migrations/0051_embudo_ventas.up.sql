-- 0051 · El embudo por defecto deja de llamarse «Reservas».
--
-- Chocaba con la pantalla Reservas, que son reservas de verdad —habitación,
-- fechas, importe—, mientras que el embudo son consultas que quizá acaben en
-- una. Dos cosas distintas con el mismo nombre en el mismo menú: el dueño lo
-- vio y pidió elegir otro. «Ventas» es lo que el tablero mide, y no se
-- confunde con nada del producto.
--
-- Solo se renombra el embudo por defecto que siga llamándose exactamente
-- «Reservas»: si el hotel ya le puso otro nombre, ese nombre es suyo. Y no
-- se toca si ya tiene otro embudo llamado «Ventas», para no chocar con él.
UPDATE pipelines p SET name = 'Ventas', updated_at = now()
 WHERE p.is_default AND p.name = 'Reservas'
   AND NOT EXISTS (SELECT 1 FROM pipelines q WHERE q.tenant_id = p.tenant_id AND q.name = 'Ventas');

-- Las cuentas nuevas nacen con el nombre nuevo. Misma función de 0018, solo
-- cambia el nombre.
CREATE OR REPLACE FUNCTION app.sembrar_embudo(p_tenant uuid) RETURNS uuid AS $$
DECLARE
  v_pipeline uuid;
BEGIN
  INSERT INTO pipelines (tenant_id, name, is_default)
  VALUES (p_tenant, 'Ventas', true)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_pipeline;

  -- Ya tenía embudo por defecto: no se toca nada. Sembrar dos veces
  -- duplicaría columnas en el tablero de alguien que ya las renombró.
  IF v_pipeline IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, color, kind, position)
  SELECT p_tenant, v_pipeline, e.name, e.color, e.kind, e.position
    FROM (VALUES
      ('Consulta',           '#0A84FF', 'abierta', 0),
      ('Interesado',         '#5E5CE6', 'abierta', 1),
      ('Cotización enviada', '#FF9F0A', 'abierta', 2),
      ('Reserva pendiente',  '#FF375F', 'abierta', 3),
      ('Confirmada',         '#30D158', 'ganada',  4),
      ('Perdida',            '#8E8E93', 'perdida', 5)
    ) AS e(name, color, kind, position);

  RETURN v_pipeline;
END;
$$ LANGUAGE plpgsql;

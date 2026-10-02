-- Reversa de 0051. No se pierden datos: vuelve el nombre «Reservas» al
-- embudo por defecto que se siga llamando «Ventas», y las cuentas nuevas
-- vuelven a nacer con él.
UPDATE pipelines p SET name = 'Reservas', updated_at = now()
 WHERE p.is_default AND p.name = 'Ventas'
   AND NOT EXISTS (SELECT 1 FROM pipelines q WHERE q.tenant_id = p.tenant_id AND q.name = 'Reservas');

CREATE OR REPLACE FUNCTION app.sembrar_embudo(p_tenant uuid) RETURNS uuid AS $$
DECLARE
  v_pipeline uuid;
BEGIN
  INSERT INTO pipelines (tenant_id, name, is_default)
  VALUES (p_tenant, 'Reservas', true)
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

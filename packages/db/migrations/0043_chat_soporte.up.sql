-- 0043 · Chat con soporte técnico.
--
-- Hoy, un cliente con un problema escribe por WhatsApp a un número personal.
-- Eso tiene tres consecuencias: el historial se pierde, nadie sabe qué se
-- respondió, y quien atiende no tiene delante ni el plan ni el estado de los
-- canales de esa cuenta.
--
-- Esto lo mete donde ya está trabajando: un hilo por cuenta, dentro del CRM.
--
-- ## Por qué un hilo por cuenta y no tickets
--
-- Un sistema de tickets pide categorías, prioridades, estados y una persona
-- que los mantenga. Para un producto con tres clientes, eso es ceremonia. Un
-- hilo continuo por cuenta —como hablar por WhatsApp, que es lo que ya hacen—
-- resuelve el 100 % de los casos de hoy, y el día que no baste, los mensajes
-- ya están guardados y se pueden agrupar.
--
-- ## Por qué NO reutiliza `conversations`
--
-- Esa tabla es la correspondencia con los HUÉSPEDES del hotel: la mira la
-- bandeja, cuenta para los topes del plan, la tocan los bots y la ventana de
-- 24 horas de Meta. Meter aquí los mensajes a soporte contaminaría las cifras
-- que el cliente usa para saber cuánto consume, y un bot podría acabar
-- respondiéndole a soporte.
CREATE TABLE support_messages (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- Quién lo escribió. Se guarda aunque luego deje el equipo: un hilo con
  -- «alguien dijo» no sirve para entender qué pasó.
  author_id  uuid        NOT NULL REFERENCES users (id),
  -- De quién viene: `true` lo escribió la plataforma, `false` el cliente.
  -- Un booleano y no el rol del autor, porque el rol cambia y esto no.
  from_platform boolean  NOT NULL,
  body       text        NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  -- Cuándo lo leyó el OTRO lado. Es lo que permite el contador de sin leer
  -- sin guardar un contador, que es lo que se desincroniza.
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX support_messages_hilo_idx ON support_messages (tenant_id, created_at DESC);
-- Lo que pregunta la consola del operador: quién espera respuesta.
CREATE INDEX support_messages_sin_leer_idx ON support_messages (tenant_id)
  WHERE read_at IS NULL AND NOT from_platform;

SELECT app.enable_tenant_rls('support_messages');

-- El operador lee todos los hilos y marca como leído lo que ya miró. No
-- escribe mensajes por aquí: para responder entra en el contexto del
-- inquilino con el rol de la aplicación, igual que al subir un comprobante
-- (0039), y así la respuesta queda dentro de la cuenta del cliente.
GRANT SELECT, UPDATE (read_at) ON support_messages TO crmapp_operador;
CREATE POLICY operador_lee_soporte ON support_messages
  FOR SELECT TO crmapp_operador USING (true);
CREATE POLICY operador_marca_leido ON support_messages
  FOR UPDATE TO crmapp_operador USING (true) WITH CHECK (true);

-- El rol de soporte (0042) también lo ve: quien entra a diagnosticar necesita
-- leer lo que el cliente contó.
GRANT SELECT ON support_messages TO crmapp_soporte;

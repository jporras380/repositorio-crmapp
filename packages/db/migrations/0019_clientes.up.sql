-- 0019 · La ficha del cliente: datos que pone el negocio, no el canal.
--
-- ## Qué va aquí y qué NO
--
-- `contact_identities` guarda lo que dice el proveedor —el id de WhatsApp, el
-- teléfono que Meta entrega, el @ de Instagram— y es un hecho inmutable suyo
-- (ADR-007). Lo que se añade en esta migración es lo contrario: lo que sabe
-- **el hotel** de esa persona y que ningún canal le va a contar. Correo,
-- ciudad, de dónde salió, sus manías.
--
-- Por eso `phone` vive aquí Y `phone_e164` sigue viviendo en la identidad. No
-- es duplicado: uno es «el número por el que escribió» y el otro «el número
-- que el hotel tiene de este señor». Coinciden casi siempre y el día que no
-- coincidan, el importante es el del negocio.
--
-- ## Lo hotelero que NO entra aquí, y por qué
--
-- El encargo pedía guardar en el contacto la fecha de ingreso, la de salida,
-- el tipo de habitación y las noches. **Eso no es del cliente, es de la
-- estancia.** Una familia que viene en julio y vuelve en enero tiene dos
-- fechas de ingreso, y con columnas en el contacto la segunda reserva borra
-- la primera — que es justo el error que ya evitamos con los leads
-- (ADR-013). Esos campos son de `reservations` (PR-37), y el «historial de
-- reservas» de la ficha es la lista de las suyas.
--
-- Aquí sí entra lo que describe a la persona y no cambia con cada estancia:
-- qué tipo de huésped es y las observaciones.

ALTER TABLE contacts
  ADD COLUMN phone        text,
  ADD COLUMN email        citext,
  ADD COLUMN city         text,
  ADD COLUMN photo_url    text,
  -- De dónde salió. `otro` existe para que nadie tenga que mentir.
  ADD COLUMN source       text NOT NULL DEFAULT 'otro'
               CHECK (source IN ('whatsapp', 'instagram', 'facebook', 'tiktok', 'web', 'otro')),
  -- Pareja, familia, corporativo… lo pone el hotel y puede cambiar de idea.
  -- Texto libre a propósito: una lista cerrada aquí obliga a una migración
  -- cada vez que aparece un tipo nuevo de huésped.
  ADD COLUMN guest_type   text,
  ADD COLUMN notes        text,
  -- Un contacto borrado que tenía conversaciones no se puede tirar: los
  -- mensajes son del negocio y su historial tiene que seguir cuadrando. Se
  -- vacía y se marca. Ver `anonimizar()` en la API.
  ADD COLUMN anonymized_at timestamptz;

COMMENT ON COLUMN contacts.phone IS
  'Teléfono que el NEGOCIO tiene de esta persona. El del canal vive en contact_identities.phone_e164.';

-- Dos personas con el mismo teléfono en la misma cuenta son la misma persona.
-- El índice lo impone en la importación, que es donde de verdad se duplican
-- los contactos: un CSV de 2.000 filas con el mismo número tres veces.
CREATE UNIQUE INDEX contacts_telefono_uq ON contacts (tenant_id, phone)
  WHERE phone IS NOT NULL AND anonymized_at IS NULL;

-- Con el correo igual, cuando lo hay.
CREATE UNIQUE INDEX contacts_email_uq ON contacts (tenant_id, email)
  WHERE email IS NOT NULL AND anonymized_at IS NULL;

-- La lista de clientes se ordena por actividad y se pagina por cursor.
CREATE INDEX contacts_listado_idx ON contacts (tenant_id, created_at DESC, id DESC);

-- 0049 · Por cuántos meses se contrata.
--
-- ## Lo que pasaba
--
-- La suscripción tenía `current_period_ends_at` y **ningún concepto de
-- plazo**: el periodo era mensual porque sí. El cliente no podía contratar
-- seis meses ni un año, y no había dónde premiar que lo hiciera.
--
-- ## Esto toca el modelo de cobro, que estaba en la lista de no tocar
--
-- Lo pidió el dueño del producto, y queda dicho aquí para que dentro de un año
-- nadie se pregunte por qué se cambió algo que ADR-011 dejaba fijo.
--
-- Lo que NO cambia: se sigue cobrando por asiento ocupado, los asientos se
-- siguen contando al mirar en vez de guardarse, y el cobro sigue siendo
-- manual. El plazo solo dice **cuántos meses se pagan de una vez**.
--
-- ## Por qué cuatro valores y no un número libre
--
-- Un campo libre invita a escribir 7, y entonces hay que decidir qué descuento
-- lleva un plazo que nadie pensó. El CHECK obliga a que ampliar la lista sea
-- una decisión, no un accidente.
ALTER TABLE subscriptions
  ADD COLUMN term_months smallint NOT NULL DEFAULT 1
    CHECK (term_months IN (1, 3, 6, 12));

COMMENT ON COLUMN subscriptions.term_months IS
  'Meses que se contratan de una vez. Un año se paga a once: el descuento vive en packages/core.';

-- Reversa de 0049.
--
-- Las cuentas que contrataron seis meses o un año **se quedan cubiertas hasta
-- donde pagaron**: eso vive en `current_period_ends_at`, que esta migración no
-- toca. Lo que se pierde es saber por cuánto contrataron, así que al renovar
-- habrá que preguntárselo.
ALTER TABLE subscriptions DROP COLUMN IF EXISTS term_months;

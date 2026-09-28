-- Reversa de 0048.
--
-- Se pierden las declaraciones de pago que los clientes hubieran subido y sin
-- resolver. Las confirmadas NO se pierden: al confirmarlas se escribió una
-- fila en `subscription_payments`, que es el libro del dinero y no se toca
-- aquí. Lo que desaparece es el rastro de quién dijo qué y con qué voucher.
--
-- Los datos de cobro de la plataforma también se van, y con ellos la pantalla
-- que le dice al cliente a dónde transferir. Volvería a decir «se hacen por
-- transferencia» sin decir a dónde, que es el problema que 0048 arregló.
-- Los pagos cobrados por Yape o Plin pasan a 'otro' antes de devolver el CHECK
-- a como estaba: si no, la reversa falla contra las filas que ella misma
-- permitió crear. Se pierde CÓMO se cobró, no el pago.
UPDATE subscription_payments SET method = 'otro' WHERE method IN ('yape', 'plin');
ALTER TABLE subscription_payments DROP CONSTRAINT subscription_payments_method_check;
ALTER TABLE subscription_payments
  ADD CONSTRAINT subscription_payments_method_check
  CHECK (method IN ('transferencia', 'efectivo', 'tarjeta', 'otro'));

DROP FUNCTION IF EXISTS app.confirmar_pago_declarado(uuid, uuid, date, date);
DROP TABLE IF EXISTS payment_claims;
DROP TABLE IF EXISTS platform_payment_settings;

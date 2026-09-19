-- Sin reversa posible, y a propósito.
--
-- Los contadores anteriores no se guardaron en ninguna parte, así que no hay
-- de dónde sacarlos. Revertir 0037 deja las conversaciones cerradas sin globo,
-- que es el estado correcto según la regla de PR-82; lo que vuelve al revertir
-- es el CÓDIGO que dejaba de apagarlo, no los números viejos.
SELECT 1;

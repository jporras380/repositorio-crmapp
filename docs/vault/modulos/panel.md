---
estado: vivo
fecha: 2026-09-14
modulo: panel
tags: [panel, dashboard, informe, metricas, mediana]
---

# Módulo — Panel e informe

API en `apps/api/src/panel/`, pantalla en `apps/web/src/pantallas/Panel/` y el informe en `apps/web/src/componentes/panel/Informe.tsx`.

Dos preguntas distintas, dos bloques:

- **Arriba, «Hoy»** (PR-23): qué hay que hacer **ahora**. Lo accionable primero y enlazado a la bandeja.
- **Abajo, «Cómo va»** (PR-38, `GET /v1/panel/informe?periodo=24h|7d|30d`): cómo fue **el periodo**, lo que pide el §15 del encargo.

![[2026-09-14-informe.png]]

## Decisiones que cambian lo que se lee

**Ventanas móviles, no «hoy».** «Hoy» exige la zona horaria del hotel, que no se guarda; con el día UTC, a las 20:00 en Lima el informe de hoy ya estaría vacío. «Últimas 24 horas» significa lo mismo en cualquier sitio.

**Mediana y p90, no media.** El encargo dice «tiempo promedio de respuesta», pero una conversación olvidada un fin de semana dispara la media y deja de describir al equipo. La mediana dice el día normal; el percentil 90, cuánto esperan los peor atendidos. La media no dice ninguna de las dos. Con **menos de cinco** conversaciones medidas se avisa en pantalla: mediana y p90 de una sola conversación son el mismo número y no son tendencia.

**Nada se suma con lo que no es lo mismo.** Consultas perdidas (embudo) y reservas canceladas van separadas; los importes, por moneda.

**Confirmadas y canceladas cuentan por su EVENTO**, no por el estado actual: una reserva confirmada el lunes y cancelada el jueves aparece en las dos columnas de esa semana, que es lo que pasó.

**La conversión es de una cohorte**: de las consultas que ENTRARON en el periodo, cuántas acabaron con una reserva no cancelada. Dividir reservas de un mes entre consultas de otro da un porcentaje que no mide nada. Sin consultas, no se pinta «0 %»: se pinta «—».

**El estado de atención usa la MISMA expresión SQL que la bandeja** (`ESTADO_DE_ATENCION`, exportada desde `bandeja.service.ts`). Si el informe contara «por responder» de otra forma, sus números no cuadrarían con la lista que tiene delante el agente. Hay test que compara el informe con la bandeja filtrada.

**«Sin responder» de arriba es la lista que abre** (PR-40, 2026-09-15). Antes la tarjeta contaba «el último mensaje es del cliente» y el filtro de la bandeja lo mismo, mientras que el informe usaba el estado de atención: en la base de desarrollo daban 5 frente a 6. La diferencia era **lo que solo había contestado el bot**, que la regla vieja daba por atendido. Ahora tarjeta y filtro usan `SIN_RESPONDER` (en `bandeja.service.ts`): estado `nueva` o `por_responder`, **y que el contacto haya escrito**; una conversación que abrió el bot con plantilla y nadie contestó es `nueva`, pero no espera respuesta de nadie. Hay test que compara la cifra del panel con la lista filtrada.

**«Respuestas» por agente son mensajes escritos por esa persona** (`sent_by = 'human'`); los del bot no cuentan.

## Forma

Casi todo son cifras sueltas, no gráficos: un número con su etiqueta se lee en un segundo. Lo único que compara —conversaciones por canal— va en barras de **un solo color** con la cifra escrita al lado en tinta de texto; el canal lo dice la etiqueta. Los estados que piden acción llevan borde de color **y** su nombre, nunca solo color.

## Pruebas

`apps/api/test/informe.e2e.test.ts` monta el escenario con **fechas explícitas y reloj fijo**. Los valores por defecto de la base usan el `now()` real, y con él una fila «de hoy» caería fuera de la ventana según el día en que se ejecute. Como el escenario vive en marzo de 2026, crea sus propias particiones de `messages`. Los números son exactos: mediana 600 s, p90 3000 s (la media habría sido 1440 s).

## Deuda conocida

- Tendencias (comparar con el periodo anterior) y exportar el informe.
- Tiempo de primera respuesta por agente: `first_response_at` no guarda quién respondió.

## «Hoy» es el día del hotel, no el del servidor (PR-59, 2026-09-16)

Salió de una frase del usuario: «son las 16:02 pm hora Perú», cuando yo venía leyendo horas del servidor y llamándolas suyas. El servidor va en UTC; Perú es UTC−5. El CRM cometía el mismo error donde sí importa.

`cerradasHoy` y `actividadHoy` usaban `date_trunc('day', ...)`, que corta el día **en la zona del servidor**. Para el hotel, «hoy» empezaba a las **19:00 de la tarde anterior**: todas las tardes, a partir de esa hora, el panel se ponía a cero y decía que no se había atendido a nadie — con el equipo trabajando.

Lo más interesante es por qué estaba así. El comentario del propio archivo lo explicaba: «"Hoy" exige saber la zona horaria del hotel, **que no se guarda**». Era cierto cuando se escribió. Desde PR-47 (migración 0027) **sí se guarda**, y nadie volvió a mirar el comentario. Una limitación documentada que caducó y se quedó.

### Cómo queda

`(date_trunc('day', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2)`. El rodeo doble no es adorno: el primero lleva el instante a la hora local, `date_trunc` corta ahí, el segundo lo devuelve a instante.

- **Sin horario configurado se usa UTC**, que es lo que había. Nunca se inventa una zona horaria: una cifra silenciosamente movida cinco horas es peor que una cifra que se sabe en UTC.
- **El informe del periodo no cambia**: sigue con ventanas móviles («últimas 24 h»), que significan lo mismo en cualquier sitio y son lo correcto para comparar periodos.

### Lo que NO cubre

El periodo de **facturación** sigue cortándose en UTC (`inicioDePeriodo`). Con cobro por asiento el impacto es mínimo —se cuentan asientos, no eventos—, pero si algún día se cobra por uso habrá que mirarlo: lo consumido en las últimas cinco horas del mes cae en el mes siguiente.

### Cómo comprobarlo en menos de 5 minutos

1. Ajustes → Horario, con la zona del hotel puesta.
2. Después de las 19:00 hora local, abrir el panel: «actividad de hoy» sigue contando lo de esa tarde.

Cubierto por dos tests con el reloj fijado a las 00:30 UTC (19:30 en Lima): con zona configurada cuenta lo de la tarde; sin ella, se comporta como antes.

---
estado: vivo
fecha: 2026-09-09
modulo: infra
tags: [aprendizaje, postgres, docker, entorno, windows]
---

# Tropiezos de entorno al levantar PostgreSQL 18

Tres cosas que costaron tiempo en PR-2 y que van a volver a pasar en cualquier máquina nueva.

## La imagen de PostgreSQL 18 cambió el punto de montaje

`postgres:18-alpine` **rechaza arrancar** si el volumen se monta en `/var/lib/postgresql/data`, que era la convención de toda la vida. El contenedor arranca, escribe un error largo y muere:

> Counter to that, there appears to be PostgreSQL data in: /var/lib/postgresql/data (unused mount/volume)

A partir de 18 la imagen guarda los datos en subdirectorios con el nombre de la versión mayor, para que `pg_upgrade --link` no cruce el límite del punto de montaje. **El montaje va un nivel arriba: `/var/lib/postgresql`.**

Es fácil de diagnosticar mal porque `docker compose ps` muestra el resto de servicios sanos y el error solo está en el log del contenedor muerto.

## Un PostgreSQL nativo puede estar ocupando el 5432

En esta máquina hay un servicio `postgresql-x64-17` corriendo. El contenedor arrancaba sano, pero las conexiones desde el host iban al PostgreSQL nativo y fallaban la autenticación con un mensaje que no dice nada de puertos.

**Nuestro compose cede el puerto y usa 55432.** Parar el servicio de alguien es más intrusivo que cambiar un número, y el conflicto se repetiría en cada máquina con PostgreSQL instalado.

Para diagnosticarlo rápido: si `docker compose exec postgres psql` funciona pero desde el host falla, el problema es de puerto, no de credenciales.

## pnpm 12 bloquea los scripts de instalación

`pnpm install` **falla con código 1** —no avisa, falla— si alguna dependencia trae scripts de instalación sin autorizar. Es una buena política: un `postinstall` es ejecución de código arbitrario en cada instalación.

La clave **no** es `onlyBuiltDependencies` en `package.json`, que esta versión ignora. pnpm escribe él mismo en `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  esbuild: set this to true or false
```

y hay que responder `true` o `false`. Que exija una decisión explícita por dependencia, en vez de una lista que se copia sin mirar, es acertado.

Ver [[2026-09-09]].

---

## Turborepo filtra el entorno de las tareas

La CI falló en `Tests` con `ECONNREFUSED 127.0.0.1:55432`: los tests apuntaban al puerto **local** aunque el workflow definía `TEST_PG_PORT=5432`.

**Turborepo 2 corre cada tarea en modo estricto de entorno**: solo pasan las variables declaradas en `turbo.json` (`env` / `globalEnv` / `passThroughEnv`). Todo lo demás se elimina antes de lanzar el proceso, y no avisa. Nosotros solo teníamos `NODE_ENV`.

Se nota poco en local porque los valores por defecto del código coinciden con el entorno de desarrollo; en CI, donde el entorno es distinto, la variable "desaparece".

**Regla:** toda variable que un test o un script lea de `process.env` tiene que estar en `globalEnv` de `turbo.json`. Admite comodines (`TEST_PG_*`).

# CRM conversacional omnicanal

CRM multi-inquilino que centraliza mensajes directos y comentarios de WhatsApp,
Instagram y TikTok en una bandeja única, con automatizaciones, plantillas,
gestión de usuarios y facturación por plan.

## Estado

**Fase 0 — andamiaje.** No hay código de producto todavía.

- Arquitectura: [`docs/ARCH.md`](docs/ARCH.md)
- Decisiones y su porqué: [`docs/vault/`](docs/vault/) (vault de Obsidian)
- Dónde estamos hoy: [`docs/vault/01-ESTADO.md`](docs/vault/01-ESTADO.md)
- Lo que falta decidir: [`docs/vault/02-PREGUNTAS-ABIERTAS.md`](docs/vault/02-PREGUNTAS-ABIERTAS.md)

## Requisitos

- Node >= 24 (ver `.nvmrc`)
- pnpm 12 (`npm install -g pnpm`)
- Docker, para la infraestructura de desarrollo

## Arranque

```bash
pnpm install
cp .env.example .env     # rellenar; .env nunca se versiona
pnpm infra:up            # postgres, redis, minio, mailpit
```

| Servicio   | Dónde                                           |
| ---------- | ----------------------------------------------- |
| PostgreSQL | `localhost:5432` — usuario y base `crmapp`      |
| Redis      | `localhost:6379`                                |
| MinIO      | API `localhost:9000` · consola `localhost:9001` |
| Mailpit    | `localhost:8025`                                |

`pnpm infra:down` para parar, `pnpm infra:reset` para parar **borrando los datos**.

## Comandos

| Comando                                                     | Qué hace                            |
| ----------------------------------------------------------- | ----------------------------------- |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm build` | Por el grafo de Turborepo           |
| `pnpm format`                                               | Prettier sobre todo el repositorio  |
| `pnpm arch:check`                                           | Guardas de arquitectura (ver abajo) |

## Guardas de arquitectura

`scripts/check-architecture.sh` corre en CI **antes** de instalar dependencias y
falla la build. Protege cuatro invariantes del ARCH que un revisor humano no va
a comprobar en cada PR:

1. **`SET app.tenant_id` sin `LOCAL`** — con pooler en modo transacción, un `SET`
   se filtra a la siguiente petición que reciba esa conexión. Es una fuga entre
   inquilinos. (ARCH §6, ADR-005)
2. **`packages/core` importando I/O** — core es dominio puro; si deja de serlo,
   la lógica de negocio acaba duplicada en el frontend. (ARCH §4)
3. **Un canal concreto importado fuera de `packages/channels`** — el núcleo habla
   con `ChannelAdapter`. (ARCH §8)
4. **Valores en `.env.example`** — solo nombres de variable. (ARCH §11)

Son la red que atrapa el error de escritura, no el de diseño. No sustituyen a
los dos tests de RLS que exige el ARCH §6 como criterio de salida de fase 0.

## Convenciones

- Español en documentación y comentarios de negocio. Inglés en nombres de
  código, tablas y variables.
- Rama por tarea; nada directo a `main`.
- Migraciones reversibles siempre.
- Cero credenciales en el repositorio.

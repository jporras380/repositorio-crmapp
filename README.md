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

## Arranque (PowerShell o cualquier terminal)

```powershell
pnpm install
Copy-Item .env.example .env   # rellenar; .env nunca se versiona
pnpm infra:up                 # postgres, redis, minio, mailpit (Docker Desktop encendido)
pnpm db:migrate               # aplica las migraciones a la base de desarrollo
pnpm db:dev-roles             # da LOGIN a crmapp_app, crmapp_auth y crmapp_relay (solo desarrollo)
pnpm dev:api                  # API en http://localhost:3000
pnpm dev:worker               # en otra terminal: relay del outbox + consumidores
```

Comprobación rápida de que la API está viva:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/v1/cuentas -ContentType application/json -Body '{"nombreDeCuenta":"Mi empresa","slug":"mi-empresa","email":"yo@ejemplo.com","contrasena":"una-contrasena-larga","nombreCompleto":"Yo"}'
```

Devuelve un `token`; con él, `GET /v1/yo` (cabecera `Authorization: Bearer <token>`) responde con el estado de la suscripción.

## Conectar un número de WhatsApp (BYO)

Con el token de propietario, pega las credenciales de tu app de Meta. Se verifican contra Meta antes de guardarse, se guardan **cifradas** y no se devuelven nunca:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/v1/canales/whatsapp -ContentType application/json -Headers @{Authorization="Bearer <token>"} -Body '{"phoneNumberId":"<phone_number_id>","wabaId":"<id de la WABA>","accessToken":"<token de Meta>","appSecret":"<app secret>"}'
```

Después, en el panel de Meta, el webhook apunta a `https://<tu-url-publica>/webhooks/whatsapp` con el `META_WEBHOOK_VERIFY_TOKEN` del `.env`. Para desarrollo hace falta un túnel (`cloudflared` o `ngrok`): Meta no puede llamar a `localhost`.

| Servicio   | Dónde                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| API        | `localhost:3000`                                                                                                                 |
| PostgreSQL | `localhost:55432` — usuario y base `crmapp`. No es el 5432 estándar: se cede el puerto por si hay un PostgreSQL nativo instalado |
| Redis      | `localhost:6379`                                                                                                                 |
| MinIO      | API `localhost:9000` · consola `localhost:9001`                                                                                  |
| Mailpit    | `localhost:8025`                                                                                                                 |

`pnpm infra:down` para parar, `pnpm infra:reset` para parar **borrando los datos**.

> Los scripts `dev:*` y `db:*` pasan `--tsconfig` de cada aplicación a `tsx`. Sin él, esbuild no activa `experimentalDecorators` y NestJS falla al arrancar con "Parameter decorators only work when experimental decorators are enabled".

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

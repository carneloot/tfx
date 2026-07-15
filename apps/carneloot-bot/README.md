# Carneloot bot

Private Bun application for owned-pet registration, food tracking, and durable feeding reminders.

## Setup

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
docker run --rm --name carneloot-postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=carneloot -p 5432:5432 postgres:17-alpine
cp apps/carneloot-bot/.env.example apps/carneloot-bot/.env
```

Export values from `.env` through your shell or preferred environment loader. Required secrets are `BOT_TOKEN` and `DATABASE_URL`. Never commit either value.

## Configuration

| Key                                                 | Unit / example                                                 |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `BOT_TOKEN`                                         | redacted Telegram token                                        |
| `DATABASE_URL`                                      | redacted PostgreSQL URL                                        |
| `BOT_ID`                                            | must be `carneloot`                                            |
| `BOT_USERNAME`                                      | Telegram username without `@`                                  |
| `POLLING_TIMEOUT_SECONDS`                           | seconds, `30`                                                  |
| `POLLING_RETRY_DELAY_MILLIS`                        | milliseconds, `1000`                                           |
| `DISPATCH_CAPACITY` / `DISPATCH_CONCURRENCY`        | positive counts, `1024` / `16`                                 |
| `JOB_IDLE_MILLIS`                                   | milliseconds, `1000`                                           |
| `JOB_LEASE_MILLIS` / `JOB_HEARTBEAT_MILLIS`         | milliseconds, `30000` / `10000`; heartbeat must be below lease |
| `DEDUP_LEASE_MILLIS` / `DEDUP_HEARTBEAT_MILLIS`     | milliseconds, `30000` / `10000`; heartbeat must be below lease |
| `DEDUP_WAIT_MILLIS` / `DEDUP_RETENTION_MILLIS`      | milliseconds, `5000` / `86400000`                              |
| `TFX_POSTGRES_SCHEMA` / `TFX_POSTGRES_TABLE_PREFIX` | SQL identifiers, `tfx` / `carneloot_`                          |

Startup applies checksummed tfx and Carneloot migrations under PostgreSQL advisory locks. One externally supplied `PgClient` Layer owns all migrations, repositories, durable deduplication, conversations, and jobs. Production refuses memory/no-op deduplication.

## Run

```sh
mise exec -- pnpm --filter carneloot-bot demo
```

`demo` and `start` run the same validated production Bun graph. Missing or invalid environment fails before polling/network startup. `SIGINT` and `SIGTERM` interrupt the shared Effect scope; polling, dispatcher, and job worker finalizers are awaited.

## Commands

1. `/cadastrar`
2. `/adicionar_pet`
3. `/listar_pets`
4. `/configurar_inicio_dia`
5. `/configurar_atraso_notificacao`
6. `/status_racao`
7. `/colocar_racao`

`/cancelar` is reserved conversation control, not a declared command. Day-start configuration selects `Alterar` before hour/timezone. Reminder configuration selects `Definir` (or later `Alterar`/`Excluir`) before duration.

## Tests and deterministic demo

```sh
mise exec -- pnpm test:unit
mise exec -- pnpm test:integration
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/carneloot \
  mise exec -- pnpm --filter carneloot-bot demo:test
# Or opt into Testcontainers:
RUN_TESTCONTAINERS=true mise exec -- pnpm --filter carneloot-bot demo:test
```

Real PostgreSQL suites skip locally only when neither database option exists and cannot skip in CI. Fake Telegram is used by E2E/demo validation; no Telegram network call occurs.

## Delivery semantics and operations

Reminder jobs are durable and at-least-once. Each recipient is fenced `pending → sending → outcome`. Definitive failures may retry; ambiguous transport/persistence or expired sending leases become terminal `unknown` and are never automatically resent, preventing duplicate owner notifications. Startup globally recovers expired leases. Failed and quarantined job identities are exposed in worker diagnostics; release health fails on unexpected quarantined jobs. Operators must inspect problem jobs and reconcile unknown deliveries rather than blindly replaying them.

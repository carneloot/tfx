# Carneloot bot

Private Telegram application for shared pet management, food tracking, durable feeding reminders, general utilities, and external notifications.

The Cloudflare runtime uses Alchemy v2, Hyperdrive, per-chat Durable Objects, and bounded minute cron passes. See [deployment and cutover](../../docs/deploy-cloudflare.md) and [runtime reliability semantics](../../docs/cloudflare-runtime.md). The Bun polling runtime remains available below for local development and transport rollback.

## Setup

```sh
export MISE_ENV=development
mise install
mise exec -- pnpm install --frozen-lockfile
export FNOX_AGE_KEY_FILE="$HOME/.config/fnox/age.txt"
docker compose -f apps/carneloot-bot/compose.yaml up -d --wait
cp apps/carneloot-bot/.env.example apps/carneloot-bot/.env
```

`.env` contains only non-secret configuration and still needs to be exported through your shell or preferred environment loader. `BOT_TOKEN` comes from the age-encrypted entry in `apps/carneloot-bot/fnox.toml`. For local development, fnox defaults `DATABASE_URL` to the PostgreSQL service exposed by `compose.yaml` at `localhost:5432`.

## Configuration

| Key                                                 | Unit / example                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| `BOT_TOKEN`                                         | redacted Telegram token                                              |
| `DATABASE_URL`                                      | local Compose default; override in production                        |
| `BOT_ID`                                            | must be `carneloot`                                                  |
| `BOT_USERNAME`                                      | Telegram username without `@`                                        |
| `PORT`                                              | Bun HTTP listener port, default `3000`; unused by Cloudflare         |
| `POLLING_TIMEOUT`                                   | Effect duration, `30 seconds` (whole seconds, 1–50)                  |
| `POLLING_RETRY_DELAY`                               | Effect duration, `1 second`                                          |
| `DISPATCH_CAPACITY` / `DISPATCH_CONCURRENCY`        | positive counts, `1024` / `16`                                       |
| `JOB_IDLE`                                          | Effect duration, `1 second`                                          |
| `JOB_LEASE` / `JOB_HEARTBEAT`                       | Effect durations, `30 seconds` / `10 seconds`; heartbeat below lease |
| `DEDUP_LEASE` / `DEDUP_HEARTBEAT`                   | Effect durations, `30 seconds` / `10 seconds`; heartbeat below lease |
| `DEDUP_WAIT` / `DEDUP_RETENTION`                    | Effect durations, `5 seconds` / `1 day`                              |
| `TFX_POSTGRES_SCHEMA` / `TFX_POSTGRES_TABLE_PREFIX` | SQL identifiers, `tfx` / `carneloot_`                                |

Startup applies checksummed tfx and Carneloot migrations under PostgreSQL advisory locks. One externally supplied `PgClient` Layer owns all migrations, repositories, durable deduplication, conversations, and jobs. Production refuses memory/no-op deduplication.

### Owner forwarding

Both Bun polling and Cloudflare accept these optional settings:

```dotenv
TELEGRAM_FORWARD_USERNAMES=alice,@bob
OWNER_TELEGRAM_ID=123456789
```

The allowlist is comma-separated. Entries are trimmed, leading `@` characters are removed, and matching ignores case. An absent or empty allowlist disables forwarding. A nonempty allowlist requires a positive numeric `OWNER_TELEGRAM_ID`. The owner setting alone is allowed; omit it entirely when unused. The owner must have started the bot before Telegram can deliver private messages to them. Alchemy validates these settings and binds them to the Worker.

Eligible messages are Telegram-forwarded to the owner, then the original receives 🕊. Registration and text are not required, so photos and other media can forward too. Commands, including addressed commands and `bot_command` entities in text or captions, never forward. Active conversations and consuming reply handlers take precedence; unrelated replies remain eligible. Forwarding does not consume the message, so the generic hello responder can still run afterward. This is separate from external-notification subscriber reply forwarding.

Forward and reaction failures use the existing handled-with-output-failure outcome. Neither output is retried. Once dispatch records a completed outcome, duplicate updates do not forward again. A lost response may mean Telegram accepted the forward without confirmation. Investigate delivery rather than replaying the update blindly. No message content or configuration values are logged by this handler.

## Run

```sh
mise exec -- pnpm dev
```

The root `dev` command runs the carneloot-bot `demo` script. `demo` and `start` run the same validated production Bun graph through `fnox exec`. The graph includes polling and an HTTP listener on `PORT`, with shared repositories and one SQL pool. The listener uses Effect's Node-compatible HTTP adapter under Bun. `SIGINT` and `SIGTERM` interrupt the shared Effect scope and await its finalizers, including the listener.

Use a separate test bot token for local polling. Polling startup deletes that bot's webhook and configures its command menu. Do not use a production token while its Cloudflare webhook is active.

## Secret key operations

The age private key at `~/.config/fnox/age.txt` must be backed up securely and never committed. Update the encrypted Telegram token from the app directory without placing plaintext in files or shell history:

```sh
cd apps/carneloot-bot
mise exec -- fnox set BOT_TOKEN --provider age
```

Production must provide `FNOX_AGE_KEY_FILE`, `FNOX_PROFILE=production`, and `DATABASE_URL` through its deployment environment. The production profile removes the localhost fallback and fails when `DATABASE_URL` is absent. A fnox remote provider can replace this bootstrap model later. Never copy the private key into a container image.

## Commands

Telegram menu declares 24 names:

1. `/cadastrar`
2. `/gerar_chave`
3. `/adicionar_pet`
4. `/listar_pets`
5. `/deletar_pet`
6. `/adicionar_cuidador`
7. `/remover_cuidador`
8. `/listar_cuidadores`
9. `/convites_pet`
10. `/parar_de_cuidar_pet`
11. `/configurar_inicio_dia`
12. `/configurar_atraso_notificacao`
13. `/status_racao`
14. `/colocar_racao`
15. `/corrigir_racao`
16. `/deletar_racao`
17. `/colocar_racao_todos`
18. `/todos` (alias for `/colocar_racao_todos`)
19. `/start`
20. `/cancelar`
21. `/ping`
22. `/whats`
23. `/cafe`
24. `/cafe_inv`

The menu order is defined by `src/bot/Declaration.ts`. `/cancelar` always acknowledges cancellation and removes the reply keyboard, even when no conversation is active. Finite choices display reply keyboards with `Cancelar`; free-text and terminal replies remove stale keyboards. Day-start selects `Alterar` before hour/timezone. Reminder selects `Definir` (later `Alterar` or `Excluir`) before duration.

General utilities do not require registration. `/ping 500` waits 500 ms; supported delays are whole numbers from 0 through 10000 ms, with invalid input producing an immediate pong. `/whats` builds a WhatsApp URL with an optional encoded message. `/cafe` calculates a V60 recipe from water quantity, while `/cafe_inv` calculates it from coffee quantity. Ordinary text containing `hello` triggers the existing image responder after consuming conversations and replies have run.

Pet owner invites caregiver with `/adicionar_cuidador`; invited user accepts or rejects through `/convites_pet`. Only accepted caregivers can see cared pets, record food, or use food reply shortcuts. Owner can remove access; caregiver can leave with `/parar_de_cuidar_pet`. Every food mutation rechecks current owner/caregiver access transactionally.

Reply to a feeding reminder to record food for its pet. Reply to source food messages for safe correction/deletion flows. Reply identities are scoped to bot and chat, so same Telegram message number in another chat cannot mutate food.

Food input also accepts elapsed offsets such as `50g -5min`, including corrections and both all-pet aliases. Offsets use the current Telegram message timestamp, not processing time or the previous feeding timestamp. Unsupported or malformed suffixes are rejected. Absolute timestamps retain their existing timezone semantics.

## External notification API

`POST /api/notify` is available on both the Bun listener and the Cloudflare Worker. In a private chat, `/gerar_chave` shows a new key once and stores only its SHA-256 hash. Group chats cannot issue or rotate keys. Replacing an existing key requires confirmation. Templates and subscribers come from persisted or imported data; neither runtime adds management commands for them.

Request body:

```json
{
	"apiKey": "your-key",
	"keyword": "alarm",
	"variables": { "pet": "Milo", "amount": 20 }
}
```

Templates use placeholders such as `{{pet}}`. Variables accept strings and finite numbers. Every repeated placeholder is replaced, and rendered messages must contain 1 to 4096 UTF-16 code units.

The response contains `eventId`, `status`, `counts` with `sent`, `failed`, and `unknown`, and sanitized delivery failures. HTTP status is 200 for complete delivery, 207 when some recipients received the notification, 202 for indeterminate delivery without confirmed successes, or 502 when all deliveries have known failures. Invalid keys or missing templates return 404; malformed payloads return 400; missing variables or invalid rendered text return 422. Initial persistence failure returns 503 before any send.

Recipients and rendered text are committed before output. Ambiguous Telegram responses and uncertain delivery finalization become `unknown` and are not automatically resent. Each HTTP request creates a new event, so do not blindly retry requests after a disconnect or 202 response. The endpoint has no caller-supplied idempotency key.

Subscribers can reply to their delivered notification. The bot sends that reply to the owner as a reply to the owner's original message. Exact bot, chat, and message identities prevent unrelated replies from matching; self-replies and replies by another user are rejected. Telegram update replay does not resend a completed reply. Active conversations run first, followed by notification replies, food replies, optional owner forwarding, and hello.

## Tests and deterministic demo

```sh
mise exec -- pnpm test:unit
mise exec -- pnpm test:integration
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/carneloot_demo \
  mise exec -- pnpm --filter carneloot-bot demo:test
# Or opt into Testcontainers:
RUN_TESTCONTAINERS=true mise exec -- pnpm --filter carneloot-bot demo:test
```

`demo:test` never drops schemas. When using `TEST_DATABASE_URL`, use an empty disposable database; rerun it with Testcontainers or another fresh database. It validates owner food/reminder flow, not caregiver shared-food flow; use runbook's two-user transcript for that capability.

Real PostgreSQL suites skip locally only when neither database option exists and cannot skip in CI. Fake Telegram is used by E2E/demo validation; no Telegram network call occurs.

## Delivery semantics and operations

Runbook: [`../../docs/demos/2026-07-16-slice-2-shared-pet-food.md`](../../docs/demos/2026-07-16-slice-2-shared-pet-food.md). Import legacy data only after backup and dry-run:

```sh
mise exec -- pnpm --filter carneloot-bot import:legacy -- import --dry-run --source-url file:./fixture.db --source-id fixture --bot-id carneloot --database-url "$DATABASE_URL" --report ./legacy-report.json
mise exec -- pnpm --filter carneloot-bot import:legacy -- import --source-url file:./fixture.db --source-id fixture --bot-id carneloot --database-url "$DATABASE_URL" --report ./legacy-report.json
```

Treat importer promotion/cutover as one-way until backup restore is proven. Stop polling before rollback; never run more than one active bot replica against same bot/update stream.

Reminder jobs are durable and at-least-once. Each recipient is fenced `pending → sending → outcome`. Definitive failures may retry; ambiguous transport/persistence or expired sending leases become terminal `unknown` and are never automatically resent, preventing duplicate owner notifications. Startup globally recovers expired leases. Failed and quarantined job identities are exposed in worker diagnostics; release health fails on unexpected quarantined jobs. Operators must inspect problem jobs and reconcile unknown deliveries rather than blindly replaying them.

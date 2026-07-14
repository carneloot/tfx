# Carneloot Bot — Features and Command Reference

> Source snapshot: `.repos/carneloot-bot` at commit `ec059b3f0ca50121ca90bae996ab6a181c2008cc` (`ec059b3`, 2026-04-25).
>
> This document describes behavior implemented in source. User-facing bot text and command names remain in Portuguese.

## Contents

- [Overview](#overview)
- [Access model](#access-model)
- [Command quick reference](#command-quick-reference)
- [Common interaction behavior](#common-interaction-behavior)
- [General commands](#general-commands)
- [Authentication commands](#authentication-commands)
- [Pet-management commands](#pet-management-commands)
- [Pet-food tracking commands](#pet-food-tracking-commands)
- [Pet-food input format](#pet-food-input-format)
- [Reply-driven features](#reply-driven-features)
- [Notifications](#notifications)
- [HTTP API](#http-api)
- [Persistence and data model](#persistence-and-data-model)
- [Runtime and deployment](#runtime-and-deployment)
- [Environment variables](#environment-variables)
- [Development commands](#development-commands)
- [Automated tests](#automated-tests)
- [Known limitations and inactive code](#known-limitations-and-inactive-code)
- [Source map](#source-map)

## Overview

Carneloot Bot is a Portuguese-language Telegram bot with four main feature areas:

1. **General utilities** — latency/delay testing, WhatsApp link generation, and V60 coffee calculations.
2. **Account and API-key management** — Telegram-user registration and API-key generation.
3. **Shared pet management** — pet ownership, caregiver invitations, caregiver status, and caregiver removal.
4. **Pet-food tracking** — daily totals, historical timestamps, corrections, deletion, shared updates, and delayed feeding reminders.

It also exposes an authenticated HTTP notification endpoint backed by stored notification templates and subscribers.

Implemented stack:

- Bun + TypeScript
- grammY Telegram bot
- `@grammyjs/conversations` with Redis-backed conversation state
- Effect services/runtime
- Hono HTTP server
- Drizzle ORM + libSQL/Turso-compatible database
- BullMQ + Redis/Valkey for delayed feeding reminders
- OpenTelemetry tracing through OTLP

Primary startup and bot wiring: `.repos/carneloot-bot/src/index.ts`, `.repos/carneloot-bot/src/bot.ts`.

## Access model

### Unregistered Telegram user

Can use:

- `/start`
- `/cancelar`
- `/ping`
- `/whats`
- `/cafe`
- `/cafe_inv`
- `/cadastrar`
- `hello` text easter egg

Commands requiring an account normally reply:

> Por favor cadastre-se primeiro utilizando /cadastrar

### Registered user

Registration associates Telegram ID, username, first name, and last name with a database user. Running `/cadastrar` again updates profile fields for the same Telegram ID.

Registered users can:

- generate an API key;
- own pets;
- receive and answer caregiver invitations;
- track food for owned pets;
- track food for pets they have accepted responsibility for.

### Pet owner

Owner-only operations:

- configure pet day start;
- configure feeding-reminder delay;
- add/delete owned pets;
- invite, list, and remove caregivers.

### Accepted caregiver

Accepted caregivers can:

- see cared-for pets in `/listar_pets`;
- view food status;
- add food;
- add food to all accessible pets;
- correct and delete food entries through explicit commands;
- receive food updates and reminders;
- stop caring for a pet.

Pending or rejected caregivers do not receive cared-pet access through normal command flows. Reply-based correction is an exception: its implementation does not verify pet access; see [Known limitations and inactive code](#known-limitations-and-inactive-code).

## Command quick reference

| Command | Registration required | Pet role | Purpose |
|---|---:|---|---|
| `/start` | No | — | Basic bot greeting. |
| `/cancelar` | No | — | Exit all active conversations and remove reply keyboard. |
| `/ping [milliseconds]` | No | — | Reply with `pong`, optionally after a delay up to 10 seconds. |
| `/whats <phone> [message]` | No | — | Build a `wa.me` link for a Brazilian phone number. |
| `/cafe <water> [ratio]` | No | — | Calculate V60 coffee weight and pour schedule from water amount. |
| `/cafe_inv <coffee> [ratio]` | No | — | Calculate V60 water amount and pour schedule from coffee weight. |
| `/cadastrar` | No | — | Create or refresh bot account from Telegram profile. |
| `/gerar_chave` | Yes | — | Generate or replace HTTP API key. |
| `/adicionar_pet` | Yes | Owner | Add a pet. |
| `/deletar_pet` | Yes | Owner | Delete an owned pet after confirmation. |
| `/listar_pets` | Yes | Owner/caregiver | List owned and cared-for pets. |
| `/adicionar_cuidador` | Yes | Owner | Invite a registered Telegram user to care for a pet. |
| `/remover_cuidador` | Yes | Owner | Remove a pending, accepted, or rejected caregiver. |
| `/listar_cuidadores` | Yes | Owner | List caregivers and invitation statuses for a pet. |
| `/convites_pet` | Yes | Invitee | Accept or reject a pending caregiver invitation. |
| `/parar_de_cuidar_pet` | Yes | Caregiver | Stop caring for a pet after confirmation. |
| `/configurar_inicio_dia` | Yes | Owner | Set daily food-accounting boundary and timezone. |
| `/configurar_atraso_notificacao` | Yes | Owner | Set, change, or delete feeding-reminder delay. |
| `/status_racao` | Yes | Owner/caregiver | Show current daily food total and last feeding time. |
| `/colocar_racao` | Yes | Owner/caregiver | Add food for one accessible pet. |
| `/colocar_racao_todos <amount> [time]` | Yes | Owner/caregiver | Add same food amount/time to every accessible pet. |
| `/todos <amount> [time]` | Yes | Owner/caregiver | Alias for `/colocar_racao_todos`. |
| `/deletar_racao` | Yes | Owner/caregiver | Delete one food entry from current pet day. |
| `/corrigir_racao` | Yes | Owner/caregiver | Change quantity and/or timestamp of current-day food entry. |

There are **24 command names**, counting `/todos` as an alias.

## Common interaction behavior

### Telegram command menu

On polling startup, or when `/api/set-webhook` runs in webhook mode, bot publishes Portuguese command metadata with `language_code: "pt"`.

Menu contains:

- `/ping`, `/whats`, `/cafe`, `/cafe_inv`, `/cancelar`;
- all auth, pet, and food commands;
- synthetic `_`, `__`, and `___` entries used as section headings.

`/start` works but is not included in the published command menu.

### Conversations and keyboards

Multi-step commands use grammY conversations persisted in Redis.

- Most entity choices use inline buttons.
- Selected inline option is appended to original prompt.
- Invalid input while an option is expected produces `Por favor, escolha uma opção`.
- Yes/no prompts use `Sim` and `Não`.
- Some food-entry selectors include `Cancelar`.
- Day-start hour and timezone use one-time reply keyboards.
- `/cancelar` exits every active conversation and removes current reply keyboard.

### Errors

Unhandled command errors are intercepted by global error middleware. User receives a GIF with:

> Aconteceu um erro nesse comando 😢

When `DEBUG` is set, error is also logged to console.

## General commands

### `/start`

Replies:

> É nóis

No registration or side effects.

Source: `.repos/carneloot-bot/src/bot.ts`.

### `/cancelar`

Behavior:

1. exits all active grammY conversations;
2. replies `Operação cancelada`;
3. removes reply keyboard.

Useful during any multi-step pet or food flow. Existing inline messages are not deleted.

Source: `.repos/carneloot-bot/src/bot.ts`.

### `/ping [milliseconds]`

Examples:

```text
/ping
/ping 500
/ping 10000
```

Behavior:

- no valid argument: immediately replies `pong`;
- valid numeric argument at most 10,000 ms: waits, then replies `pong <formatted duration>`;
- invalid or over-limit argument: behaves like plain `/ping`;
- response is sent as a reply to invoking message.

Source: `.repos/carneloot-bot/src/commands/ping.command.ts`.

### `/whats <phone> [message]`

Generates a WhatsApp click-to-chat URL without saving contact.

Examples:

```text
/whats (11) 99999-9999
/whats +55 11 99999-9999 Olá!
/whats 11999999999 Mensagem de teste
```

Accepted number syntax includes:

- Brazilian country prefix `55`, `+55`, or `0055`;
- DDD and local number;
- optional parentheses, spaces, and hyphen.

Behavior:

- strips non-numeric phone characters;
- prepends country code `55` when absent;
- URL-encodes optional message;
- replies with `https://wa.me/<number>?text=<message>`;
- missing/invalid phone displays format help.

This command is specifically shaped around Brazilian numbering.

Source: `.repos/carneloot-bot/src/commands/whats-command.ts`.

### `/cafe <water> [ratio]`

Calculates V60 recipe from starting water volume.

Examples:

```text
/cafe 500
/cafe 500ml
/cafe 0.5L
/cafe 500 65
/cafe 500ml 65g/L
```

Defaults:

- bare water number means milliliters;
- coffee-to-water ratio defaults to `60g/L`;
- bare ratio number means grams per liter.

Output:

1. required coffee quantity;
2. V60 pour table:
   - first pour: 2–3× coffee weight, wait 45 seconds;
   - second stage: pour to 60% total water over 30 seconds;
   - final stage: pour to total water over 30 seconds.

Approximately half of executions also remind user to wet filter first.

Invalid water asks for starting amount in ml. Invalid ratio asks for `g/L`.

Planned but not implemented: interactive menus and on-screen timers.

Source: `.repos/carneloot-bot/src/commands/cafe-command.ts`.

### `/cafe_inv <coffee> [ratio]`

Inverse V60 calculator: starts with coffee weight and calculates water.

Examples:

```text
/cafe_inv 30
/cafe_inv 30g
/cafe_inv 30 65
/cafe_inv 30g 65g/L
```

Defaults:

- bare coffee number means grams;
- ratio defaults to `60g/L`;
- bare ratio number means grams per liter.

Output includes total water and same three-stage pour schedule as `/cafe`. Approximately half of executions include filter-wetting reminder.

Source: `.repos/carneloot-bot/src/commands/cafe-inv-command.ts`.

### Text easter egg: `hello`

Any text message matching `hello` case-insensitively causes bot to send a meme image.

This is a hears-pattern, not a slash command.

Source: `.repos/carneloot-bot/src/bot.ts`.

## Authentication commands

### `/cadastrar`

Creates account from Telegram sender data.

Stored fields:

- Telegram ID;
- username, when present;
- first name;
- last name, when present.

Running command again for same Telegram ID updates name and username instead of creating duplicate user.

Responses:

- success: `Usuário cadastrado com sucesso!`;
- Telegram sender unavailable: `Não foi possível identificar o usuário.`

Source: `.repos/carneloot-bot/src/modules/auth/signup.command.ts`, `.repos/carneloot-bot/src/lib/entities/user.ts`.

### `/gerar_chave`

Generates API key used by `POST /api/notify`.

First key:

1. generates CUID2 plaintext key;
2. stores SHA-256 hash, not plaintext;
3. sends plaintext key once in an HTML `<pre>` block.

Existing key:

1. warns that old key will be invalidated;
2. displays menu buttons `Yes` and `No`;
3. `Yes` replaces hash and returns new plaintext key;
4. `No` closes menu and replies `Okay!`.

Only one API key is stored per user. Replacing it immediately invalidates previous key.

Source: `.repos/carneloot-bot/src/modules/auth/generate-api-key.command.ts`, `.repos/carneloot-bot/src/lib/entities/user.ts`.

## Pet-management commands

### `/adicionar_pet`

Owner flow:

1. asks `Qual o nome do seu pet?`;
2. waits for text;
3. inserts pet owned by current user;
4. replies `Pet cadastrado com sucesso!`.

Pet name must be unique within owner account at database level.

Source: `.repos/carneloot-bot/src/modules/pet/add-pet.command.ts`.

### `/deletar_pet`

Owner flow:

1. loads owned pets;
2. asks user to choose pet;
3. asks `Você tem certeza...` with `Sim`/`Não`;
4. `Sim` deletes pet and replies `Pet deletado!`;
5. `Não` ends without deletion.

Source: `.repos/carneloot-bot/src/modules/pet/delete-pet.command.ts`.

### `/listar_pets`

Lists:

- owned pets by name;
- accepted cared-for pets as `<name> (cuidando)`.

List is alphabetically sorted and numbered. No pets produces `Você não tem pets`.

Source: `.repos/carneloot-bot/src/modules/pet/list-pets.command.ts`.

### `/adicionar_cuidador`

Owner flow:

1. choose owned pet;
2. enter caregiver Telegram username, with or without leading `@`;
3. validate caregiver;
4. create pending invitation;
5. DM caregiver with owner display name, pet name, and `/convites_pet` instruction;
6. confirm invitation to owner.

Validation and edge cases:

- owner cannot invite themselves;
- caregiver must already have run `/cadastrar`;
- duplicate invitation is not inserted;
- existing status is reported as pending, accepted, or rejected.

Source: `.repos/carneloot-bot/src/modules/pet/add-carer.command.ts`.

### `/remover_cuidador`

Owner flow:

1. choose owned pet;
2. load all caregiver records;
3. choose caregiver, displayed with accepted/rejected/pending status;
4. delete caregiver relation;
5. reply `Cuidador removido`;
6. DM removed user.

If pet has no caregiver records, replies `Este pet não tem cuidadores`.

Source: `.repos/carneloot-bot/src/modules/pet/remove-carer.command.ts`.

### `/listar_cuidadores`

Owner flow:

1. choose owned pet;
2. list every caregiver with translated status:
   - `accepted` → `aceito`;
   - `rejected` → `rejeitado`;
   - `pending` → `pendente`.

No records produces `Este pet não tem cuidadores`.

Source: `.repos/carneloot-bot/src/modules/pet/list-carers.command.ts`.

### `/convites_pet`

Invitee flow:

1. load pending invitations;
2. choose invitation shown as `<pet> (<owner>)`;
3. answer `Sim`/`Não` to caring question;
4. persist `accepted` or `rejected`;
5. tell invitee whether invitation was accepted/refused;
6. DM owner with result.

No pending invitations produces `Você não tem convites pendentes.`

Source: `.repos/carneloot-bot/src/modules/pet/pet-invites.command.ts`.

### `/parar_de_cuidar_pet`

Accepted caregiver flow:

1. choose cared-for pet;
2. confirm with `Sim`/`Não`;
3. `Sim` deletes caregiver relation;
4. replies `Você parou de cuidar deste pet`;
5. DMs owner.

No cared pets produces `Você não está cuidando de nenhum pet`.

Source: `.repos/carneloot-bot/src/modules/pet/stop-caring.command.ts`.

## Pet-food tracking commands

### Required per-pet setup

Food tracking depends on two owner-managed settings:

1. **Day start** — timezone-aware boundary used to define “today.”
2. **Notification delay** — duration after latest feeding when reminder is sent.

Most food reads require day start. End-to-end food insertion and scheduling also expects notification delay.

### `/configurar_inicio_dia`

Owner flow:

1. choose owned pet;
2. view existing day-start setting, when present;
3. confirm adding/changing setting;
4. choose hour from `0h` through `11h`;
5. choose IANA timezone from `@vvo/tzdb` list;
6. save `{ hour, timezone }` for pet.

The configured boundary defines each daily accounting window. Example: day start `04:00 America/Sao_Paulo` means “today” spans local 04:00 to next local 04:00, then boundaries are converted to UTC for queries.

Source: `.repos/carneloot-bot/src/modules/pet-food/set-day-start.command.ts`, `.repos/carneloot-bot/src/common/utils/get-daily-from-to.ts`.

### `/configurar_atraso_notificacao`

Owner flow:

1. choose owned pet;
2. display current reminder delay or missing-setting message;
3. if missing, ask whether to define it;
4. if present, choose `Alterar` or `Excluir`.

Change path:

1. enter duration as `[number] [English unit]`, such as `30 minutes` or `2 hours`;
2. invalid input is repeatedly rejected with format help;
3. save duration;
4. if pet has previous food, remove old delayed job and reschedule from latest food timestamp.

Delete path:

1. confirm deletion;
2. delete setting;
3. remove latest queued reminder;
4. reply that notifications are disabled.

Source: `.repos/carneloot-bot/src/modules/pet-food/set-notification-delay.command.ts`.

### `/status_racao`

For every owned and accepted cared-for pet:

- calculates current day using pet timezone/day-start boundary;
- sums food quantity in grams;
- reports relative time since latest entry, when one exists.

Example shape:

```text
- Rex: 120 g última vez há 2 horas e 15 minutos
```

If pet lacks day-start config, bot sends separate warning for that pet and omits it from final status message.

Source: `.repos/carneloot-bot/src/modules/pet-food/food-status.command.ts`.

### `/colocar_racao`

Single-pet guided flow:

1. choose from owned and accepted cared-for pets;
2. bot verifies day-start config;
3. enter quantity and optional timestamp;
4. bot parses quantity into grams;
5. creates food record linked to message and user;
6. schedules next reminder from food timestamp + configured delay;
7. replies to quantity message with summary;
8. reacts with 👍;
9. silently informs owner/other accepted caregivers.

Entries within one minute of most recent pet-food entry are rejected as duplicates.

If entered food is newer than previous latest entry, previous reminder job is removed and new reminder becomes active. Backdated entries are recorded but do not replace reminder derived from latest feeding.

Source: `.repos/carneloot-bot/src/modules/pet-food/add-food.command.ts`, `.repos/carneloot-bot/src/lib/services/pet-food.ts`.

### `/colocar_racao_todos <amount> [time]`

### `/todos <amount> [time]`

Adds same quantity and optional local time to all pets user owns or cares for.

Examples:

```text
/todos 50
/todos 50g 08:30
/colocar_racao_todos 0.05kg 14/07 08:30
```

Behavior:

- command arguments are mandatory;
- no pets produces `Você não possui nenhum pet`;
- quantity is parsed once;
- timestamp is interpreted independently in each pet timezone;
- additions run concurrently;
- each pet gets normal duplicate check, scheduling, and caregiver notifications;
- success replies with total amount applied to all pets and reacts 👍.

If any required per-pet config is missing, command reports which setup is needed.

Source: `.repos/carneloot-bot/src/modules/pet-food/add-food-all.command.ts`.

### `/deletar_racao`

Owner/caregiver flow:

1. choose accessible pet;
2. calculate current pet day;
3. list food entries as quantity, timezone-local timestamp, and recording user;
4. choose entry or `Cancelar`;
5. delete selected record;
6. remove BullMQ job whose ID matches deleted food entry;
7. reply `Ração deletada com sucesso!`.

No accessible pets and no food today are handled with explanatory messages.

Source: `.repos/carneloot-bot/src/modules/pet-food/delete-food.command.ts`.

### `/corrigir_racao`

Owner/caregiver flow:

1. choose accessible pet;
2. list current-day food records;
3. choose entry or `Cancelar`;
4. enter new quantity and/or time using same food syntax;
5. update quantity and timestamp;
6. if corrected entry is pet’s latest entry and time changed, request reminder scheduling from corrected timestamp;
7. reply `Ração alterada com sucesso!`.

The correction path does not first remove existing BullMQ job with same food-entry ID. If that job still exists, duplicate `jobId` behavior can leave original execution time unchanged.

Source: `.repos/carneloot-bot/src/modules/pet-food/correct-food.command.ts`.

## Pet-food input format

Parser accepts quantity plus optional date/time.

### Quantity

```text
<number>[mg|g|kg]
```

Examples:

```text
50
50g
50000mg
0.05kg
```

Rules:

- omitted unit defaults to grams;
- recognized units are `mg`, `g`, and `kg`;
- decimal separator is `.`;
- value is normalized to grams.

### Optional time

```text
<number>[unit] HH:mm
<number>[unit] DD/MM HH:mm
<number>[unit] DD-MM HH:mm
<number>[unit] DD/MM/YYYY HH:mm
<number>[unit] DD-MM-YYYY HH:mm
```

Examples:

```text
50g 08:30
50g 14/07 08:30
50g 14-07-2026 08:30
```

Rules:

- date is only accepted when time is present;
- separators `/` and `-` are accepted;
- omitted date uses message date in pet timezone;
- explicit time later than message time is shifted backward rather than treated as future feeding;
- stored timestamp is UTC;
- display and daily grouping use pet timezone.

Source: `.repos/carneloot-bot/src/common/utils/parse-pet-food-weight-and-time.ts`.

## Reply-driven features

Reply middleware runs for registered users before normal command/hears processing.

### Reply to feeding reminder

Reply directly to a feeding-reminder message still present in notification history (normally latest stored reminder for that pet/user) with food syntax, for example:

```text
50g
50g 08:30
```

Bot:

1. identifies pet through notification history;
2. records food;
3. schedules next reminder;
4. replies with summary;
5. reacts 👍;
6. silently informs other owner/caregivers.

This provides a shortcut around `/colocar_racao` pet selection.

### Reply to food-entry message

Reply to a Telegram message linked to one or more food entries with corrected quantity/time. Bot looks up records globally by replied Telegram `message_id`, updates **all** matching food records, and replies:

> Rações atualizadas com sucesso!

This path updates database values directly. Unlike `/corrigir_racao`, it does not explicitly reschedule latest reminder after changing time. It also performs no pet-ownership/caregiver check. Because Telegram message IDs are scoped per chat while lookup is global, a registered user replying to a same-numbered message can potentially update unrelated, inaccessible pet records.

### Reply to external notification

When a subscriber replies to delivered external notification:

- bot forwards `<subscriber display>: <reply text>` to notification owner;
- forwarded message replies to owner’s corresponding notification message;
- owner cannot reply to own notification and receives explanatory message.

Source: `.repos/carneloot-bot/src/middlewares/reply.middleware.ts`, `.repos/carneloot-bot/src/modules/notification/`, `.repos/carneloot-bot/src/modules/pet-food/handle-pet-food-reply.ts`.

## Notifications

### Feeding-reminder scheduling

Each latest food entry can own one BullMQ delayed job.

Schedule time:

```text
food timestamp + pet notification delay
```

Behavior:

- adding newer food removes previous latest-food job;
- backdated food does not supersede latest reminder;
- changing delay reschedules from latest stored food;
- deleting delay removes latest job;
- deleting food attempts to remove job with that food ID;
- deleting latest food does not schedule replacement reminder from previous entry, leaving no reminder until another feeding/config change schedules one;
- past-due schedule runs immediately;
- queue jobs use three attempts with exponential backoff starting at 10 seconds.

Reminder text includes:

- pet name;
- total food already recorded in current pet day, or indication that none exists.

Reminder recipients:

- pet owner;
- accepted caregivers.

Reminder deliveries are recorded in notification history so replies can be routed back into food tracking.

### Food-added notifications

After food insertion, bot sends silent Telegram message to:

- owner, unless owner made entry;
- all accepted caregivers, excluding actor.

Message includes actor, pet, amount, and explicit local timestamp when user supplied one. Telegram notification sound is disabled (`disable_notification: true`).

### Generic external notifications

External notifications use database-backed:

- owner;
- unique keyword per owner;
- message template;
- subscriber list;
- delivery history.

Template variables use `{{name}}` syntax and are provided by API request.

No active Telegram command or HTTP endpoint creates notification templates or subscriber lists. Those records must already exist in database or be provisioned externally.

Source: `.repos/carneloot-bot/src/lib/queues/pet-food-notification.ts`, `.repos/carneloot-bot/src/modules/pet-food/utils/send-added-food-notification.ts`, `.repos/carneloot-bot/src/lib/services/notification.ts`.

## HTTP API

All API routes are mounted under `/api`.

### `POST /api/notify`

Sends stored notification template owned by API-key user.

Request:

```json
{
  "apiKey": "plaintext-key-from-gerar_chave",
  "keyword": "deploy",
  "variables": {
    "service": "effectloot-bot",
    "version": 42
  }
}
```

Example:

```bash
curl -X POST http://localhost:3000/api/notify \
  -H 'content-type: application/json' \
  -d '{
    "apiKey": "YOUR_API_KEY",
    "keyword": "deploy",
    "variables": {
      "service": "effectloot-bot",
      "version": 42
    }
  }'
```

Flow:

1. validate request schema;
2. hash API key and resolve user;
3. load notification by owner + keyword;
4. detect template variables such as `{{service}}`;
5. reject missing variables;
6. substitute values;
7. send to owner and every subscriber concurrently;
8. log each successful Telegram delivery for reply routing.

Responses:

| Status | Meaning |
|---:|---|
| `200` | `Notification sent successfully!` |
| `404` | API key does not resolve to user. |
| `404` | No template for owner + keyword. |
| `422` | One or more used template variables are missing. |
| `500` | Database error. |

Individual Telegram delivery failures are logged and swallowed; endpoint can still report success after partial delivery.

### `GET /api/set-webhook`

Available only when `RUN_MODE=webhook`.

- Requires `WEBHOOK_URL`.
- Calls Telegram `setWebhook`.
- publishes command menu.
- returns `{ "message": "Done!" }` on success.

### `POST /api/webhook/:secret`

Available only when `RUN_MODE=webhook`. Receives Telegram updates through grammY’s Hono adapter.

Source: `.repos/carneloot-bot/src/index.ts`, `.repos/carneloot-bot/src/api/types/notify-params.ts`.

## Persistence and data model

Database uses Drizzle with libSQL/Turso dialect.

| Table | Purpose | Important constraints |
|---|---|---|
| `users` | Registered Telegram users. | Unique Telegram ID and username. |
| `pets` | Pets and owner relation. | Pet name unique per owner. |
| `pet_carers` | Caregiver invitation/relationship. | Unique pet + caregiver; status pending/accepted/rejected. |
| `pet_food` | Quantity, timestamp, actor, and Telegram message link. | Indexed by pet, user, time, and message. |
| `configs` | JSON configuration by context/key. | Unique context + key. |
| `api_keys` | SHA-256 API-key hashes. | Unique hash and one key per user. |
| `notifications` | External notification keyword/template/owner. | Keyword unique per owner. |
| `users_to_notify` | Notification subscribers. | Unique notification + user. |
| `notification_history` | Delivered Telegram message IDs and routing metadata. | Unique delivery/history indexes. |
| `sessions` | Generic persisted session shape. | Unique context + key. |

Conversation state used by running bot is stored through grammY Redis adapter with `session:` key prefix.

Source: `.repos/carneloot-bot/src/lib/database/schema.ts`, `.repos/carneloot-bot/src/bot.ts`.

## Runtime and deployment

### Startup

`bun run src/index.ts`:

1. validates environment variables;
2. creates Telegram bot;
3. creates Hono server and `/api` routes;
4. creates Effect managed runtime/services;
5. starts BullMQ queue and worker;
6. starts Bun HTTP server;
7. starts Telegram long polling when `RUN_MODE=polling`.

### Polling mode

- default mode;
- publishes command list on start;
- drops pending Telegram updates on startup.

### Webhook mode

- exposes webhook setup and receiver routes;
- Telegram updates arrive via Hono;
- command list is published when `/api/set-webhook` is called.

### Database

- libSQL client accepts local or remote/Turso-compatible URL;
- optional auth token;
- startup connection check runs `SELECT 1`;
- connection failures retry indefinitely with jitter around 1.25-second spacing.

### Redis/Valkey

Used for:

- grammY conversation sessions;
- BullMQ delayed feeding-reminder jobs and worker.

### Tracing

Effect OpenTelemetry runtime exports spans through OTLP.

- service name: `carneloot-bot`;
- service version: first six characters of `SOURCE_COMMIT`, when supplied;
- optional bearer token and Axiom dataset header;
- default OTLP exporter used when custom URL absent.

### Docker

`Dockerfile`:

- base: `oven/bun:1.3.0`;
- production-only dependency install with frozen lockfile;
- `PORT=3000` and `TZ=UTC`;
- entrypoint: `bun run start`.

`docker-compose.yml` provides supporting services only:

- persistent Valkey on `6379`;
- Grafana `otel-lgtm` on `3000`, `4317`, and `4318`.

It does not define bot app or database service.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---:|---|---|
| `BOT_TOKEN` | Yes | — | Telegram bot token; held as Effect `Redacted`. |
| `DATABASE_URL` | Yes | — | libSQL/Turso database URL. |
| `REDIS_URL` | Yes | — | Redis/Valkey URL for conversations and BullMQ. |
| `DATABASE_AUTH_TOKEN` | No | — | Remote libSQL/Turso auth token. |
| `RUN_MODE` | No | `polling` | `polling` or `webhook`. |
| `PORT` | No | `3000` | Bun HTTP port. |
| `WEBHOOK_URL` | No | — | Public host used to construct Telegram webhook URL. |
| `COOLIFY_URL` | No | — | Base URL for public assets used by inactive auth middleware. |
| `DEBUG` | No | — | Enables console logging for caught command errors. |
| `SOURCE_COMMIT` | No | — | Supplies telemetry service version. |
| `OTLP_URL` | No | exporter default | OTLP HTTP trace endpoint. |
| `OTLP_API_TOKEN` | No | — | Bearer token for OTLP endpoint. |
| `OTLP_DATASET` | No | — | `X-Axiom-Dataset` tracing header. |

`.env.sample` includes only subset: bot token, database URL/token, run mode, port, webhook URL, and Redis URL.

Source: `.repos/carneloot-bot/src/common/env.ts`, `.repos/carneloot-bot/.env.sample`.

## Development commands

Run from `.repos/carneloot-bot`:

| Command | Purpose |
|---|---|
| `bun run dev` | Start through nodemon. |
| `bun run start` | Run `src/index.ts`. |
| `bun run build:dev` | TypeScript compilation. |
| `bun run db:push` | Push Drizzle schema. |
| `bun run db:studio` | Open Drizzle Studio. |
| `bun run set-webhook` | `curl $BOT_URL/api/set-webhook`. |
| `bun run test` | Run Vitest with `TZ=UTC`. |
| `bun run lint` | Check with oxlint. |
| `bun run lint:fix` | Auto-fix with oxlint. |
| `bun run format` | Check formatting with oxfmt. |
| `bun run format:fix` | Rewrite formatting with oxfmt. |

Source: `.repos/carneloot-bot/package.json`, `.repos/carneloot-bot/drizzle.config.ts`.

## Automated tests

Existing tests cover:

- shared custom schemas;
- timezone-aware daily range calculation;
- Portuguese relative-time formatting;
- pet-food quantity/date/time parser.

Test files:

- `.repos/carneloot-bot/src/common/schema.test.ts`
- `.repos/carneloot-bot/src/common/utils/get-daily-from-to.test.ts`
- `.repos/carneloot-bot/src/common/utils/get-relative-time.test.ts`
- `.repos/carneloot-bot/src/common/utils/parse-pet-food-weight-and-time.test.ts`

No command-level, Telegram integration, queue integration, or HTTP API tests are present in snapshot.

## Known limitations and inactive code

These items describe observed source behavior, not proposed features.

### User-visible edge cases

- `/start` is implemented but omitted from Telegram command menu.
- Several pet flows open empty option keyboards without first checking for zero owned pets. Conversation may wait indefinitely until `/cancelar`.
- `/status_racao` can attempt empty reply when user has no pets.
- `/configurar_inicio_dia` offers `0h`, while persisted schema requires hour greater than `0`; choosing midnight may trigger generic command error.
- Day-start UI only offers `0h`–`11h`, although persisted schema allows through `12`.
- API-key confirmation buttons are English (`Yes`/`No`) while rest of bot is Portuguese.
- Correct-food prompts say “deletar” in two places even though operation corrects entry.
- Reply-based food correction updates every row matching Telegram message ID, performs no pet-access check, and does not explicitly reschedule reminder. Telegram message IDs are only chat-scoped, but lookup is global; collisions can modify unrelated pet records.
- `/corrigir_racao` attempts to add corrected latest-entry reminder without removing existing job with same ID; existing BullMQ job may retain old run time.
- Deleting latest food removes its reminder job but does not schedule from previous entry, so reminders stop until another action schedules one.
- Food insertion expects reminder delay; missing delay can fail scheduling path after food insert has begun.

### Reminder and notification durability

- Source does not scan food database on startup to rebuild missing delayed jobs. Reminder recovery depends on BullMQ/Redis persistence.
- External notification templates and subscribers have persistence and delivery logic but no management command/API.
- Template substitution replaces one occurrence per supplied key per reduction pass; repeated identical placeholders may remain.
- API notification endpoint treats individual Telegram-send failures as logged outcomes and may return success after partial delivery.

### Webhook and static-serving concerns

- Webhook route contains `:secret`, but route handler does not explicitly compare it with expected token.
- Webhook URL construction interpolates `Env.BOT_TOKEN` directly even though token is an Effect `Redacted` value; other bot startup code unwraps it explicitly.
- Static root is configured as `../public/`; Docker workdir/layout places assets at `./public`, so container static path may not match.
- `set-webhook` package script uses `BOT_URL`, but `.env.sample` documents `WEBHOOK_URL` instead.

### Inactive utilities

Defined but not wired into active bot:

- `AuthMiddleware` username allowlist with random unauthorized GIF/image responses;
- `LoggerMiddleware` forwarding command execution logs to selected Telegram user IDs;
- delay middleware;
- user `showNotifications` config shape;
- database `sessions` entity path separate from active Redis conversation storage.

### Planned but incomplete refactor

`.repos/carneloot-bot/.specs/refactor-effect-program.md` describes migration to pure Effect application, removal of Hono, removal of `src/runtime.ts`, and unified lifecycle management. Current implementation still uses Hono, managed runtime module, and manual queue startup.

## Source map

| Area | Primary source |
|---|---|
| Bot composition and command menu | `.repos/carneloot-bot/src/bot.ts` |
| HTTP startup/routes | `.repos/carneloot-bot/src/index.ts` |
| General commands | `.repos/carneloot-bot/src/commands/` |
| Auth commands | `.repos/carneloot-bot/src/modules/auth/` |
| Pet commands | `.repos/carneloot-bot/src/modules/pet/` |
| Food commands | `.repos/carneloot-bot/src/modules/pet-food/` |
| Reply routing | `.repos/carneloot-bot/src/middlewares/reply.middleware.ts` |
| Food parser | `.repos/carneloot-bot/src/common/utils/parse-pet-food-weight-and-time.ts` |
| Daily timezone boundaries | `.repos/carneloot-bot/src/common/utils/get-daily-from-to.ts` |
| Food scheduling logic | `.repos/carneloot-bot/src/lib/services/pet-food.ts` |
| Reminder queue/worker | `.repos/carneloot-bot/src/lib/queues/pet-food-notification.ts` |
| External notifications | `.repos/carneloot-bot/src/lib/services/notification.ts` |
| Database schema | `.repos/carneloot-bot/src/lib/database/schema.ts` |
| Runtime/telemetry layers | `.repos/carneloot-bot/src/runtime.ts` |
| Environment schema | `.repos/carneloot-bot/src/common/env.ts` |
| Scripts/dependencies | `.repos/carneloot-bot/package.json` |

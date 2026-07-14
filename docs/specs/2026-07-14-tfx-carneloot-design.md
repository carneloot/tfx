# tfx and Carneloot Bot Design

**Date:** 2026-07-14  
**Status:** Approved design  
**Reference behavior:** [`CARNELOOT_BOT_FEATURES.md`](../../CARNELOOT_BOT_FEATURES.md)

## 1. Summary

Build two related products:

1. **tfx**, a minimal, general-purpose, Effect-native Telegram bot library.
2. **Carneloot Bot**, a PostgreSQL-backed application built only through tfx public APIs.

tfx will provide typed Telegram Bot API access, immutable bot declarations, exhaustive implementation builders, Effect Layer composition, typed middleware service provisioning, explicit durable conversation state machines, polling and webhook adapters, and optional infrastructure services. Carneloot will first deliver its pet-food workflows, then the remaining behavior documented in `CARNELOOT_BOT_FEATURES.md`.

The work is divided into four slices. Every slice receives one or more separate implementation plans. A slice must be split into multiple plans when one plan would cross too many package or subsystem boundaries, become difficult to review, or lack a single verifiable outcome.

## 2. Goals

### tfx goals

- Offer a small Effect-native alternative to grammY for applications like Carneloot.
- Support third-party feature packages without requiring grammY-compatible middleware or runtime APIs.
- Make Telegram, storage, clocks, deduplication, and other capabilities yieldable Effect services.
- Track command inputs, handler errors, service requirements, middleware-provided services, groups, and implementations through TypeScript types.
- Use immutable declarations plus exhaustive builders, following Effect HttpApi patterns.
- Use Effect fibers, Streams, scopes, queues, schedules, and Layers for runtime behavior.
- Support Node.js and Bun without Bun-only behavior in published packages.
- Keep persistence and deployment adapters optional.

### Carneloot goals

- Reach intended feature parity with `CARNELOOT_BOT_FEATURES.md`.
- Prioritize complete, corrected pet-food behavior.
- Preserve Portuguese command names and recognizable user-facing flows.
- Replace SQLite/libSQL and Redis/BullMQ with PostgreSQL-backed domain storage, conversations, deduplication, scheduled jobs, and immediate delivery jobs.
- Import current Carneloot data through a validated one-time importer.
- Fix known correctness and security problems rather than reproduce them.

## 3. Non-goals

- grammY source or plugin compatibility.
- Full grammY feature parity before Carneloot becomes usable.
- Multiple active Carneloot replicas in the initial release.
- Multiple simultaneous conversations for one `(bot, chat, user)` scope.
- Exactly-once Telegram message delivery; Telegram does not provide a general idempotency mechanism for sends.
- Runtime loading of arbitrary JavaScript plugins from disk or a network location.
- An initial Deno support guarantee.
- A persistent interactive menu framework in the initial four slices; if later justified, it belongs in a separate `@tfx/menu` package.

## 4. Repository and packages

Use a workspace monorepo:

```text
packages/
  tfx/                          # npm: tfx
  conversations/                # npm: @tfx/conversations
  conversations-postgres/       # npm: @tfx/conversations-postgres
  polling/                      # npm: @tfx/polling
  webhook/                      # npm: @tfx/webhook
  jobs-postgres/                # npm: @tfx/jobs-postgres
  dedup-postgres/               # npm: @tfx/dedup-postgres
  testing/                      # npm: @tfx/testing
  testing-postgres/             # npm: @tfx/testing-postgres

apps/
  carneloot-bot/
```

Package boundaries may be refined by a slice implementation plan, but these rules are fixed:

- `tfx` cannot depend on PostgreSQL, Redis, Bun-only APIs, or Carneloot code.
- Carneloot imports only tfx public package exports, never source internals.
- Feature behavior is composed through bot declarations and implementation Layers.
- Infrastructure implementations are services and Layers, not behavior plugins.
- Node.js and Bun are both covered by package validation.

### 4.1 Workspace toolchain

Use **pnpm workspaces** as the package manager and workspace implementation. Pin the initial package manager through `packageManager: "pnpm@10.17.1"` and commit `pnpm-lock.yaml`. Use `workspace:` dependency ranges for internal packages.

Commit a root `.mise.toml` as the canonical developer and CI toolchain definition. Initial exact pins are:

```toml
[tools]
node = "24.18.0"
bun = "1.3.14"
pnpm = "10.17.1"
```

The `packageManager` field and mise pnpm version must match. Runtime compatibility metadata, CI matrices, and documentation must agree with the pinned Node and Bun release lines. Upgrades happen through reviewed commits that update all relevant pins and validation together. CI installs tools through mise before running repository commands.

Use:

- mise for reproducible local and CI tool versions;
- pnpm recursive and filtered commands for package selection;
- TypeScript project references for compilation order and incremental builds;
- Changesets for package versioning, changelogs, and npm publication;
- Bun as the Carneloot production runtime and one CI test runtime, not as the repository package manager;
- Node.js as the other supported runtime and CI test runtime.

Do not introduce Turborepo initially. pnpm filtering and TypeScript project references are sufficient for the expected package graph and avoid a second task-graph/cache configuration. Turborepo may be proposed later only after measurements show repeated unchanged work, unacceptable local or CI build duration, or a concrete need for remote caching.

Representative workspace configuration:

```yaml
packages:
  - packages/*
  - apps/*
```

Root commands should expose full-repository checks and pnpm-filterable package commands. Publishing always uses the pnpm/Changesets workflow even though Carneloot executes on Bun.

## 5. Telegram Bot API generation and facade

### 5.1 Source specification

Telegram does not publish an official OpenAPI document. Pin [`photon-hq/telegram-api`](https://github.com/photon-hq/telegram-api) as a submodule under `.repos` and use its generated Telegram OpenAPI document as the initial source.

Generation pipeline:

```text
pinned Photon OpenAPI specification
→ checked-in tfx JSON patches and normalizations
→ @effect/openapi-generator
→ checked-in generated schemas and raw HTTP client
→ handwritten tfx Telegram facade
```

CI regenerates output and fails when committed generated files differ. Telegram releases are reviewed against official Bot API documentation before updating the pinned specification.

### 5.2 Public Telegram service

The generated client remains internal. Public code yields a service and calls methods on it:

```ts
const tg = yield* Telegram.Telegram
const message = yield* tg.sendMessage(input)
```

No static accessors are generated for public use. Each method returns its decoded Telegram result directly; the Telegram `{ ok, result, description, error_code, parameters }` envelope never escapes the facade.

The facade also handles:

- bot token placement in the API URL;
- generated request and response schemas;
- JSON and multipart bodies;
- `InputFile` URL, file ID, and uploaded-file variants;
- response envelope decoding;
- sanitized request and response context;
- Telegram rate-limit and migration parameters.

### 5.3 Error model

Follow Effect `AiError` architecture with Telegram-specific reasons:

```text
TelegramError
  module
  method
  reason: TelegramErrorReason
```

`TelegramError` and each reason extend `Schema.ErrorClass`. The wrapper exposes `cause`, `message`, `isRetryable`, and optional `retryAfter` by delegating to its reason.

Initial reason union:

- `NetworkError`;
- `RateLimitError`;
- `AuthenticationError`;
- `ForbiddenError`;
- `InvalidRequestError`;
- `ConflictError`;
- `ChatMigrationError`;
- `InternalTelegramError`;
- `InvalidResponseError`;
- `UnknownError`.

Mappings preserve Telegram error code, description, parameters, method name, and sanitized HTTP context. Callers catch `TelegramError` and branch on `error.reason._tag`.

## 6. Type-safe bot declaration model

### 6.1 Declarations and public naming

Use `Bot`, `BotBuilder`, `BotGroup`, `Command`, and `CommandInput` as public composition names. Keep `Command` rather than `BotCommand` because Telegram's generated API already defines `BotCommand` as command-menu data. Keep `BotGroup` rather than generic `Group` because a group may contain commands, conversations, middleware, callbacks, and annotations. Generated Telegram command-menu data remains namespaced under Telegram schemas and is distinct from executable tfx `Command` declarations.

Use immutable HttpApi-style declarations as the primary bot composition model:

```ts
const PetFood = BotGroup.make("petFood")
  .add(Command.make("addFood", {
    name: "colocar_racao"
  }))
  .add(Command.make("foodStatus", {
    name: "status_racao"
  }))

const Carneloot = Bot.make("Carneloot")
  .add(General)
  .add(Account)
  .add(Pets)
  .add(PetFood)
```

A third-party package exports a declaration fragment and its implementation Layer. Consumers add the declaration to their bot and provide its Layer. No global mutable registry is used.

### 6.2 Exhaustive builders

`BotBuilder.group` binds handlers to declared identifiers and produces a Layer. Its types reject:

- unknown group identifiers;
- unknown command identifiers;
- duplicate handler implementations;
- missing handler implementations;
- mismatched decoded inputs;
- handler errors outside the declared contract;
- unresolved middleware-provided values.

Runtime validation still rejects collisions that TypeScript cannot always prove across independently assembled packages, including duplicate Telegram command names and callback namespaces.

### 6.3 CommandInput module and inference

Provide a first-class, pure `CommandInput` composition module. It contains immutable parser descriptions and combinators, not a service or Layer. Follow Effect CLI's config inference approach without coupling tfx to Effect CLI's parser internals.

Initial combinators:

- `CommandInput.none`, used automatically when `Command.make` omits `input`;
- `CommandInput.argument(name, schema)`;
- `CommandInput.rest(name, schema)`;
- `CommandInput.optional(input)`;
- `CommandInput.repeated(input)`;
- `CommandInput.sequence(...inputs)`;
- `CommandInput.map(input, transform)`.

Positional order is defined only by the arguments passed to `sequence`; JavaScript object-key order never defines command syntax. The result is an inferred readonly record keyed by declared argument names. Types and runtime construction reject duplicate output names, required positional input after optional input, input after `rest`, and more than one `rest` input.

Every leaf schema must decode **from string**. Public constructors constrain schemas to `Schema.ConstraintCodec<any, string>` and use `Schema.decodeEffect`, so `Schema.String`, `Schema.NumberFromString`, and domain codecs such as `Codec<FoodAmount, string>` are accepted while `Schema.Number` is rejected at compile time. Schema decoding requirements propagate from `S["DecodingServices"]` through `CommandInput` into the resulting handler and Layer requirements.

`Command.make` defaults omitted `input` to `CommandInput.none`, producing an empty readonly input record without requiring explicit boilerplate. `/colocar_racao` uses this default because food input arrives in a later conversation message. `/todos` declares ordered command input:

```ts
const AddFoodToAllInput = CommandInput.sequence(
  CommandInput.argument("amount", FoodAmountFromString),
  CommandInput.optional(
    CommandInput.rest("when", FoodDateTimeFromString)
  )
)
```

The first parser consumes one token. The optional `rest` parser consumes either `HH:mm` or the multi-token `DD/MM[/YYYY] HH:mm` form. Its inferred result contains required `amount` and optional `when`. Aliases such as `/todos` and `/colocar_racao_todos` share one input declaration.

Raw unparsed command text is available only through an explicit low-level string codec declaration.

### 6.4 Middleware service provisioning

Middleware enriches downstream handlers by providing Effect services rather than mutating a context object.

A middleware declaration tracks:

- literal identifier;
- services it provides;
- services it requires;
- expected error schema or error type;
- applicable handler scope.

Applying middleware removes provided services from downstream requirements and adds its own requirements. For example, `RegisteredUser` provides `CurrentUser.CurrentUser` and requires `UserRepository`.

Middleware ordering is:

```text
global
→ bot group
→ command or conversation
→ handler
```

### 6.5 Contextual Telegram helpers

Provide small, scoped, yieldable context services for ergonomic Telegram operations. These are built-in handler services, not mutable grammY-style context objects and not replacements for `Telegram.Telegram`.

- `UpdateContext.UpdateContext` is available for every dispatched update and exposes decoded update data plus derived update, user, and chat identifiers when present.
- `MessageContext.MessageContext` is available only to command and message handlers and exposes current message/chat data plus message-bound helpers.
- `CallbackQueryContext.CallbackQueryContext` is available only to callback-query handlers and exposes callback data plus callback-bound helpers.

Builders provide applicable context services automatically, so they do not remain as unresolved application Layer requirements. Conversation input declarations provide matching services: message-text input provides `MessageContext`, while callback-data input provides `CallbackQueryContext`.

Initial `MessageContext` helpers:

- `reply(text, options?)`, which sends to the current chat without quoting the current message by default;
- `replyToCurrent(text, options?)`, which adds Telegram reply parameters;
- `react(reaction, options?)`;
- `editText(text, options?)`;
- `delete()`;
- `sendChatAction(action)`.

Initial `CallbackQueryContext` helpers:

- `answer(options?)`;
- `editMessageText(text, options?)`;
- `deleteMessage()`.

Helpers derive applicable chat ID, message ID, message-thread ID, business-connection ID, reply parameters, or callback-query ID and delegate to the yieldable `Telegram.Telegram` service. Options reuse generated Telegram request types, successful results use generated Telegram result types, and failures remain `TelegramError`.

Helpers are deliberately thin: no hidden retry, persistence, deduplication, or domain behavior. The full Telegram service remains available for every method that lacks a helper. Add further helpers only after repeated use across features or third-party packages demonstrates value; do not manually duplicate the complete Telegram Bot API surface.

### 6.6 Keyboards and callback data

Provide pure, immutable `ReplyKeyboard`, `InlineKeyboard`, and `CallbackData` modules in `tfx`. Keyboard builders produce generated Telegram reply-markup values and work inside or outside conversations. Prefer Effect-style constructors and combinators over mutable fluent classes.

`CallbackData.make(namespace, codec)` binds a stable callback namespace to a `Schema.ConstraintCodec<any, string>`. Encoding adds the namespace, returns a branded callback-data string, and enforces Telegram's 1–64 byte limit. Decoding verifies the namespace before applying the codec. Bot construction rejects duplicate callback namespaces where statically assembled declarations expose them; runtime dispatch still rejects ambiguous registrations.

`InlineKeyboard` supports rows and generated Telegram button variants, including callback, URL, and Web App buttons. `ReplyKeyboard` supports text rows plus one-time, resize, selective, persistent, and placeholder options represented by Telegram's generated markup types.

These modules perform construction and validation only. They do not register handlers, wait for updates, or imply conversation state.

## 7. Conversations

### 7.1 Model

Use explicit, serializable state machines rather than replayed functions. A conversation declaration has:

- literal ID;
- integer version;
- named steps;
- one state schema per step;
- one accepted input declaration per step;
- one startup-input schema;
- one fixed initial step and initializer from startup input to initial state;
- middleware;
- optional idle timeout;
- explicit state migrations.

The declaration derives a discriminated persisted-state union from its steps. Authors do not maintain a parallel union manually. Conversation text and callback-data input constructors apply the same `Schema.ConstraintCodec<any, string>` rule as `CommandInput`, because their raw payload is text; their schema decoding-service requirements also propagate into the conversation Layer.

### 7.2 Implementation

`ConversationBuilder` exhaustively binds `enter`, `onInput`, and optional invalid-input behavior to declared steps. It rejects unknown or missing steps and type-checks state, decoded input, errors, requirements, and transitions.

A transition API supports:

- `to(step, state)`;
- `stay`;
- `complete`;
- typed cancellation.

The target step determines the required target-state type. Conversation handlers can yield middleware-provided services such as `CurrentUser.CurrentUser`.

### 7.3 Starting and conflicts

Commands start a declared conversation through a yieldable `Conversations.Conversations` service. `start(conversation, startupInput)` accepts only the declaration's startup-input type. The declaration's initializer converts that input into state for its fixed initial step. Callers cannot begin at an arbitrary internal step; a materially different entry path is a separate conversation or an explicit branch from the initial step.

Only one conversation may be active for `(bot, chat, user)`. Starting another conversation fails with `ConversationAlreadyActive` unless the caller explicitly chooses `conflict: "replace"`. `/cancelar` terminates the active conversation and removes reply keyboards.

### 7.4 Persistence

PostgreSQL conversation rows contain:

- bot ID;
- conversation ID and version;
- chat and user scope;
- current step;
- encoded state;
- optimistic revision;
- creation, update, and expiration timestamps.

Transitions use compare-and-swap revision updates. Version changes require declared schema migrations. Unknown or invalid persisted state fails through a typed storage or migration error and can be safely cancelled after reporting.

### 7.5 Routing priority

Within one update partition:

1. system and lifecycle handlers;
2. global `/cancelar`;
3. active conversation;
4. command matching;
5. callback-query matching;
6. message and reply handlers;
7. fallback handling.

Invalid conversation input does not advance state.

### 7.6 Conversation input, choice, and prompt helpers

Provide `ConversationInput`, `ConversationChoice`, and a yieldable `ConversationPrompt.ConversationPrompt` service in `@tfx/conversations`.

Initial input constructors:

- `ConversationInput.messageText(codec)`;
- `ConversationInput.callbackData(callbackData)`;
- `ConversationInput.reaction(codec)`;
- `ConversationInput.command(command)`.

Message-text and callback payload codecs must encode to string. Reaction input uses the generated Telegram reaction schema because its raw representation is structured update data. Schema decoding replaces replay-style `waitUntil` and form parsers: a step declares accepted input and optional invalid-input response, and the handler receives only decoded values. tfx does not expose imperative `await conversation.form.text()` or filtered-wait APIs because explicit state-machine steps own waiting and persistence.

`ConversationChoice.inline(namespace, codec)`, `ConversationChoice.reply(namespace, codec)`, and `ConversationChoice.boolean({ yes, no })` create reusable typed choice declarations. The same declaration supplies prompt encoding and step input decoding, preventing render/parser mismatch. `ConversationPrompt.choice` renders dynamic options with text, labels, encoded values, columns, and optional cancellation.

Choice input is a discriminated result:

```ts
type ChoiceResult<A> =
  | { readonly _tag: "Selected"; readonly value: A }
  | { readonly _tag: "Cancelled" }
```

Choice behavior:

- requires a non-empty option collection and fails with typed `EmptyChoiceOptions` before sending an empty keyboard;
- checks unique display labels for reply keyboards and unique encoded callback values for inline keyboards;
- supports row/column layout and one-time reply keyboards;
- can automatically acknowledge callback queries;
- removes reply keyboards when a conversation completes or is cancelled;
- supports a configurable invalid-input response;
- never treats a typed selection as authorization: domain handlers recheck current pet/user access before mutation.

Keep three concepts separate:

1. Telegram command menu generated from `Command` declarations;
2. one-shot inline or reply choices built from keyboards and `ConversationChoice`;
3. persistent interactive menus with dynamic navigation and long-lived callbacks.

The first two are required by Carneloot and belong in initial slices. Persistent menus are deferred to a future `@tfx/menu` package after demonstrated demand.

## 8. Runtime, concurrency, and delivery

### 8.1 Update sources

Polling and webhook packages expose the same decoded update-source boundary. Raw values are decoded using generated Effect Schemas before dispatch.

### 8.2 Effect concurrency

No public worker, thread, or Promise-pool abstraction is used for update dispatch.

The runtime uses:

- a bounded queue for backpressure;
- `Stream.groupByKey` or an equivalent Effect primitive;
- one sequential stream per active partition;
- scoped fibers for independent active partitions;
- a global concurrency bound;
- idle expiration for inactive partition groups;
- structured interruption during shutdown.

Default partition key:

```ts
update.chatId
  ?? update.userId
  ?? `update:${update.updateId}`
```

This preserves ordering for a chat or user's conversation while allowing unrelated chats to run concurrently.

### 8.3 Optional update deduplication

Core internal code always yields `UpdateDeduplicator.UpdateDeduplicator`. It is a `Context.Reference` with a no-op default. Applications override it by providing a Layer; no deduplication plugin is installed.

`@tfx/dedup-postgres` implements persisted claims with processing status, lease expiration, attempts, completion time, and retention cleanup. Carneloot provides this Layer by default.

Polling does not acknowledge beyond a fetched batch until dispatch completes. If Telegram redelivers a batch, completed update IDs are skipped. Webhook success returns `2xx`; retryable failures permit Telegram retry.

Delivery remains at least once. Critical Carneloot writes use update-derived idempotency keys.

## 9. PostgreSQL jobs and delivery

`@tfx/jobs-postgres` provides typed, schema-validated jobs through yieldable services and Layers.

A job declaration contains:

- literal job name;
- version;
- payload schema;
- retry policy;
- handler requirements.

Scheduling can use a stable conflict key. Carneloot uses one `feeding-reminder:<petId>` key per pet, so a newer latest feeding atomically replaces the prior schedule.

Food mutation, reminder replacement, and insertion of immediate notification-delivery jobs occur in one PostgreSQL transaction. The jobs table therefore supplies both delayed scheduling and transactional delivery-queue behavior; no separate outbox abstraction is required initially. Jobs are claimed with leases and `FOR UPDATE SKIP LOCKED`. Scoped Effect fibers execute claimed jobs. This remains compatible with a later multi-replica deployment even though initial deployment has one active bot instance.

Job execution is at least once. A crash after Telegram accepts a send but before completion may duplicate delivery; the design records attempts and minimizes this window without claiming exactly-once delivery.

## 10. Carneloot domain and PostgreSQL model

### 10.1 Domain services

Carneloot separates:

- Identity;
- Pets and caregiver access;
- Pet food;
- Feeding reminders;
- Generic notifications;
- General utilities.

Telegram handlers orchestrate these services but contain no SQL.

### 10.2 Main tables

```text
users
telegram_identities
pets
pet_caregivers
pet_food_settings
pet_food_entries
api_keys
notification_templates
notification_subscriptions
notification_deliveries

tfx_conversations
tfx_jobs
tfx_job_attempts
tfx_update_deduplication
```

Model rules:

- Telegram numeric IDs use PostgreSQL `bigint`.
- Usernames are nullable and not unique.
- Pet names are unique per owner.
- Caregiver status is constrained to pending, accepted, or rejected.
- Food quantity is stored as integer milligrams.
- Food times use `timestamptz`.
- Daily start uses a local time plus validated IANA timezone.
- Reminder delay uses a typed duration mapped to PostgreSQL interval or an equivalent checked representation.
- Telegram message identity is `(bot_id, chat_id, message_id)`, never a global message ID.
- Typed food settings replace generic JSON config rows.
- Mutable records include creation and update timestamps.
- Food idempotency can distinguish each pet affected by one `/todos` update.

### 10.3 Pet-food behavior

Preserve intended behavior for:

- timezone-aware pet-day boundaries;
- `mg`, `g`, and `kg` input normalized to integer milligrams;
- optional local date and time parsing;
- duplicate feeding rejection;
- latest-versus-backdated reminder logic;
- owner and accepted-caregiver access;
- silent food-added notifications;
- reminder replies;
- corrections and deletions.

Correct old behavior:

- midnight day start is valid;
- empty pet lists do not enter stuck conversations;
- missing notification delay cannot leave a partially completed food write;
- correction replaces the existing reminder schedule;
- deleting latest food schedules from the previous latest entry when appropriate;
- reply correction scopes message identity by bot and chat and rechecks pet access;
- corrected reply entries reschedule reminders when required;
- webhook secrets are validated;
- partial notification delivery is represented accurately through the HTTP contract defined below.

## 11. HTTP API and deployment

Use Effect HttpApi for Carneloot HTTP endpoints and tfx webhook integration. Replace Hono.

Required parity:

- authenticated `POST /api/notify` behavior;
- webhook setup behavior;
- secret-validated Telegram webhook receiver.

`POST /api/notify` performs direct concurrent delivery and returns a typed result: `200` when every recipient succeeds, `207` with delivered/failed counts and structured failure summaries when only some recipients succeed, and `502` when no recipient succeeds because of Telegram delivery failures. Authentication, missing-template, missing-variable, and database failures retain distinct typed responses. Non-idempotent sends are not blindly retried. Notification templates and subscriptions are imported and may be provisioned administratively in PostgreSQL; feature parity does not add a Telegram command or HTTP management API for them.

The application runs on Bun in production, while published tfx packages also support Node.js. Initial compatibility baseline is Node.js 24.x and Bun 1.3.x. CI runs package builds, type tests, and unit tests under both runtimes; PostgreSQL adapter conformance and Carneloot smoke tests also run once under each runtime. Supported versions are declared in package metadata and may be raised only through an explicit release change. The application lifecycle is one scoped Effect program that acquires server, update source, database pool, job fibers, and telemetry resources and releases them in reverse order.

Initial deployment uses one active bot process and PostgreSQL. The schema and job claims should not prevent later webhook-based horizontal scaling.

## 12. Data importer

Provide a one-time SQLite/libSQL-to-PostgreSQL importer separate from bot startup.

Requirements:

- source database is read-only;
- dry-run mode;
- deterministic ID mapping;
- row-count and foreign-key verification;
- conversion from floating-point grams to integer milligrams with reported rounding;
- timezone and config validation;
- preservation of food timestamps and API-key hashes;
- reconstruction of private-chat message identity from related Telegram users where safe;
- explicit report for records that cannot be migrated safely;
- repeatable execution without duplicating imported rows.

Redis conversation state and BullMQ jobs are not migrated. Cutover rebuilds reminder jobs from PostgreSQL food data and settings.

## 13. Observability and security

Create Effect spans around:

- update receipt and deduplication;
- middleware;
- command and conversation steps;
- SQL transactions;
- job scheduling and execution;
- Telegram methods.

Telemetry excludes bot tokens, API keys, raw message text, and private payloads by default.

Security requirements:

- bot tokens and database credentials use `Redacted` configuration;
- webhook secret comparison is explicit;
- reply-driven mutations recheck current access;
- SQL is parameterized;
- API keys remain hashed at rest;
- generated HTTP diagnostics sanitize authorization and token-bearing URLs;
- malformed external payloads are schema-decoded before domain use.

## 14. Testing strategy

### 14.1 Required in every slice

Each slice includes:

- compile-time API tests;
- unit tests;
- PostgreSQL integration tests where applicable;
- end-to-end update fixtures;
- Node.js 24.x and Bun 1.3.x build, type-test, and unit-test validation for changed packages;
- fresh code review;
- runnable release or demonstration.

Earlier slices may use internal test helpers. Slice 4 extracts, stabilizes, documents, and publishes reusable testing APIs.

### 14.2 Compile-time coverage

Type tests cover:

- unknown and missing group, command, and conversation handlers;
- command input ordering, inferred records, and invalid composition constraints;
- rejection of non-string-encoded command, conversation-text, and callback-data codecs;
- propagation of schema decoding services;
- conversation step state and transition inference;
- middleware-provided and middleware-required services;
- context-service availability only for compatible handler and conversation input kinds;
- callback-data string-codec, namespace, and typed choice-result inference;
- final unresolved Layer requirements;
- intentional invalid examples through `@ts-expect-error` fixtures.

### 14.3 Runtime coverage

Unit and integration tests cover:

- Telegram envelope and error mapping;
- command matching and bot username suffixes;
- middleware ordering;
- contextual helper derivation of chat, message, thread, business-connection, and callback identifiers;
- equivalence between contextual helper calls and low-level Telegram service requests;
- keyboard layout and generated markup output;
- callback namespace collision, malformed payload, and 64-byte-limit handling;
- empty and duplicate choice options, cancellation, invalid input, callback acknowledgement, and reply-keyboard removal;
- conversation transitions, revision conflicts, timeout, and migration;
- food parsing and timezone boundaries;
- reminder scheduling;
- deduplication leases;
- job claims and retries;
- transactional food, reminder-job, and immediate delivery-job changes;
- importer validation.

Use `TestClock` for timing behavior and real PostgreSQL for SQL semantics.

End-to-end scenarios include duplicate updates, ordered same-chat updates, concurrent unrelated chats, interrupted conversations, caregiver access changes, correction/deletion rescheduling, backdated food, Telegram rate limits, and malformed Telegram results.

## 15. Delivery slices and planning policy

A slice is a product milestone, not a requirement to use one implementation plan. Before implementing a slice, split it into as many plans as necessary so each plan has one coherent outcome, bounded package ownership, explicit tests, and reviewable size. Complete and review plans in dependency order. Do not create one implementation plan spanning all slices.

### Slice 1: owned-pet food loop

Deliver the smallest complete tfx and Carneloot path for:

- `/cadastrar`, including repeat registration that refreshes Telegram profile fields;
- `/adicionar_pet`;
- `/listar_pets`;
- `/configurar_inicio_dia`;
- `/configurar_atraso_notificacao`;
- `/status_racao`;
- `/colocar_racao`;
- durable feeding reminders.

This slice includes only tfx capabilities needed by that path: Telegram generation/facade, declaration/builders, middleware, contextual helpers, keyboards/callback data, conversation input/choice/prompt helpers, polling, PostgreSQL conversations/jobs/deduplication, and internal test support.

Likely plan boundaries include Telegram transport, typed bot kernel, conversations, PostgreSQL infrastructure, and Carneloot owned-pet application behavior. Final boundaries are chosen during slice planning.

### Slice 2: complete shared pet-food system

Deliver:

- `/deletar_pet`;
- `/adicionar_cuidador`;
- `/remover_cuidador`;
- `/listar_cuidadores`;
- `/convites_pet`;
- `/parar_de_cuidar_pet`;
- `/colocar_racao_todos` and `/todos`;
- `/deletar_racao`;
- `/corrigir_racao`;
- reminder replies;
- safe reply-based food correction;
- silent caregiver notifications;
- corrected reminder rescheduling;
- migration importer.

This slice may use separate plans for caregiver access, remaining food commands, reply routing/notifications, and migration.

### Slice 3: remaining Carneloot parity

Deliver:

- `/start`;
- `/cancelar`;
- `/ping`;
- `/whats`;
- `/cafe`;
- `/cafe_inv`;
- `/gerar_chave`;
- `hello` easter egg;
- generic external notifications and reply forwarding;
- imported or administratively provisioned notification templates and subscriptions;
- authenticated notification HttpApi with explicit complete, partial, and failed delivery responses;
- webhook setup and receiver;
- Portuguese Telegram command menu containing all 24 real commands, including `/start`, without synthetic `_`, `__`, or `___` heading commands;
- tracing and production deployment.

This slice may use separate plans for general commands, notifications/API keys, webhook/HttpApi, and operations.

### Slice 4: public tfx testing modules

Publish `@tfx/testing` with:

- `TestBot`;
- update fixture builders;
- fake yieldable `Telegram.Telegram`;
- recorded request assertions;
- conversation scenario runner;
- fake polling and webhook sources;
- `TestClock` integration;
- middleware and concurrency probes;
- declaration/builder type-test utilities;
- conformance suites for third-party update adapters.

Publish `@tfx/testing-postgres` with:

- disposable PostgreSQL test Layers;
- migration setup and reset;
- conversation-storage conformance suite;
- job-store conformance suite;
- deduplicator conformance suite;
- lease, crash, retry, and concurrency fixtures.

Migrate reusable internal helpers from prior slices to these stable public APIs. This slice may use separate plans for core harnesses, conversation scenarios, adapter conformance, and PostgreSQL test infrastructure.

## 16. Feature-parity acceptance

Final Carneloot acceptance uses `CARNELOOT_BOT_FEATURES.md` as a parity checklist for:

- all 24 command names, including `/todos` alias;
- registration and role access;
- pet ownership and caregiver invitation lifecycle;
- every pet-food configuration and mutation flow;
- reply-driven food and notification behavior;
- delayed feeding reminders;
- generic notification delivery;
- authenticated HTTP API;
- polling and webhook modes;
- command menu publication;
- production tracing and lifecycle.

Parity means preserving intended capability and Portuguese UX, not preserving documented defects.

## 17. Design decisions recap

- Minimal general tfx framework, expanded through Carneloot vertical slices.
- Effect-native APIs only.
- Node.js and Bun support; Bun production application.
- PostgreSQL for domain data, conversations, scheduled and immediate delivery jobs, and deduplication.
- One active bot instance initially.
- One active conversation per bot/chat/user.
- Sequential update handling per partition, concurrent across partitions using Effect fibers.
- Immutable HttpApi-style bot declarations and exhaustive Layer-backed builders.
- Middleware provides Effect services.
- Scoped `UpdateContext`, `MessageContext`, and `CallbackQueryContext` services provide thin Telegram helpers while `Telegram.Telegram` remains the complete low-level API.
- Pure immutable keyboard builders, namespaced typed callback data, and state-machine-native conversation input/choice/prompt helpers cover Carneloot interactions; persistent menus are deferred.
- Ordered, schema-driven command parsing uses the pure `CommandInput` module; all text leaf codecs have encoded type `string` and propagate decoding services.
- Generated Telegram schemas/client from pinned Photon OpenAPI plus tfx patches.
- `Telegram.Telegram` is yieldable; public methods unwrap successful results.
- `TelegramError` follows Effect `AiError` structure.
- Update deduplication is an overridable service with no-op default; Carneloot uses PostgreSQL implementation.
- Known Carneloot bugs and security issues are fixed.
- mise-pinned Node.js, Bun, and pnpm; pnpm workspaces, TypeScript project references, and Changesets; Bun remains a runtime, and Turborepo is deferred until measured need.
- Four product slices, each with one or more bounded implementation plans.

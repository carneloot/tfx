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
  postgres/                     # npm: @tfx/postgres
  testing/                      # npm: @tfx/testing
  testing-postgres/             # npm: @tfx/testing-postgres

apps/
  carneloot-bot/
```

Package boundaries may be refined by a slice implementation plan, but these rules are fixed:

- `tfx` cannot depend on PostgreSQL, Redis, Bun-only APIs, Node-only APIs, or Carneloot code.
- Core `tfx` includes polling and webhook delivery descriptors backed by internal update-source Layers because every running bot must select one delivery mode.
- Carneloot imports only tfx public package exports, never source internals.
- Feature behavior is composed through bot declarations and implementation Layers.
- Infrastructure implementations are services and Layers, not behavior plugins.
- Node.js and Bun are both covered by package validation.

### 4.1 Core and Effect platform boundary

Follow Effect v4's package architecture: portable definitions and programs live in core, while backend- or host-specific implementations live outside core. `tfx` therefore owns bot declarations/runtime, Telegram contracts/facade, update sources, conversations, jobs, storage contracts, contextual helpers, and explicit portable memory Layers. Expose focused subpath modules such as `tfx/Bot`, `tfx/Command`, `tfx/Conversation`, `tfx/ConversationStorage`, `tfx/Job`, `tfx/JobStore`, `tfx/VersionedSchema`, `tfx/Polling`, and `tfx/Webhook`.

Do not create `@tfx/platform-node` or `@tfx/platform-bun`. Core tfx requires Effect's platform-neutral services, including HTTP client/server contracts, and leaves their concrete Layers unresolved. Node.js applications import implementations directly from `@effect/platform-node`; Bun applications, including Carneloot production, import directly from `@effect/platform-bun`. `Webhook.make` carries the platform-neutral HttpApi route, while application code selects and provides the actual Effect HTTP server Layer. The internal polling source Layer and Telegram facade similarly consume the provided Effect HTTP client service.

This keeps tfx host-neutral, avoids Layer-only wrapper packages, and lets applications use any Effect-supported platform without waiting for a tfx adapter.

### 4.2 Workspace toolchain

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

### 4.3 PostgreSQL adapter package

Consolidate production PostgreSQL implementations in `@tfx/postgres` rather than publishing one PostgreSQL package per tfx service. The package provides:

- `PostgresConversationStorage.layer` for `ConversationStorage`;
- `PostgresJobStore.layer` for `JobStore`;
- `PostgresUpdateDeduplicator.layer` for `UpdateDeduplicator`;
- coordinated tfx PostgreSQL migrations;
- `TfxPostgres.layer(options)` as a convenience Layer providing all three services.

Individual Layers remain available so applications install only required capabilities without dynamic configuration that weakens Layer output types. Every adapter Layer requires an application-provided `PgClient.PgClient`; `@tfx/postgres` does not create a hidden second pool. This lets tfx adapters and application repositories share one Effect SQL client and transaction.

The package owns one coordinated schema version for `tfx_conversations`, `tfx_jobs`, `tfx_job_attempts`, and `tfx_update_deduplication`, with configurable PostgreSQL schema and table prefix. Schema and prefix values use branded PostgreSQL identifiers validated against `^[a-z_][a-z0-9_]*$`; both configured and composed table identifiers must fit PostgreSQL's 63-byte limit. They are interpolated only through Effect SQL identifier-fragment APIs, never raw string concatenation or value parameters. The package implements only tfx infrastructure contracts and never contains Carneloot users, pets, food, notification repositories, or other application persistence.

Keep `@tfx/testing-postgres` separate so Docker, Testcontainers, migration reset, and conformance-test dependencies do not enter production installations.

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

Use `Bot`, `BotBuilder`, `BotRuntime`, `BotGroup`, `Command`, and `CommandInput` as public composition names. Keep `Command` rather than `BotCommand` because Telegram's generated API already defines `BotCommand` as command-menu data. Keep `BotGroup` rather than generic `Group` because a group may contain commands, conversations, middleware, callbacks, and annotations. Generated Telegram command-menu data remains namespaced under Telegram schemas and is distinct from executable tfx `Command` declarations.

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

Every leaf schema must decode **from string**. Public constructors constrain schemas to `Schema.ConstraintCodec<any, string>` and use `Schema.decodeEffect`, so `Schema.String`, `Schema.NumberFromString`, and domain codecs such as `Codec<FoodAmount, string>` are accepted while `Schema.Number` is rejected at compile time. `CommandInput` only decodes command text, so `S["DecodingServices"]` propagates into the resulting handler and Layer requirements; unused encoding services do not become parser requirements.

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

Middleware enriches downstream handlers by providing Effect services rather than mutating a context object. Keep request-scoped composition requirements separate from implementation infrastructure requirements.

A middleware declaration tracks:

- literal identifier;
- request-scoped services it provides downstream;
- request-scoped services it requires from earlier middleware;
- expected request-processing error schema or error type;
- applicable handler scope.

Declaration-level `requires` exists only for middleware ordering and request context. Applying middleware removes its provided services from downstream handler requirements and requires its request-scoped prerequisites to already be available. For example, `RequireAdmin` may require `CurrentUser.CurrentUser` from earlier `RegisteredUser` middleware and then provide `CurrentAdmin.CurrentAdmin`.

Repositories, database clients, configuration, and external clients belong to the middleware implementation Layer, not its declaration. `RegisteredUser` declares that it provides `CurrentUser.CurrentUser` and has no request-scoped prerequisite. `RegisteredUserLive` captures `UserRepository` while constructing the middleware, so its Layer type carries `UserRepository` as an input requirement and any construction error in its error channel. Providing that Layer propagates unresolved infrastructure requirements into the final application Layer normally.

This separation lets bot declarations validate middleware order without coupling reusable contracts to one implementation's infrastructure.

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

`CallbackData.make(namespace, codec)` binds a stable callback namespace to a `Schema.ConstraintCodec<any, string>`. Encoding adds the namespace, returns a branded callback-data string, and enforces Telegram's 1–64 byte limit. Decoding verifies the namespace before applying the codec. Because callback and choice declarations perform both operations, their Layer requirements include both `S["DecodingServices"]` and `S["EncodingServices"]`. Bot construction rejects duplicate callback namespaces where statically assembled declarations expose them; runtime dispatch still rejects ambiguous registrations.

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

The declaration derives a discriminated persisted-state union from its steps. Authors do not maintain a parallel union manually. Conversation text and callback-data input constructors apply the same `Schema.ConstraintCodec<any, string>` rule as `CommandInput`, because their raw payload is text. Message-text input propagates decoding services; callback-data and rendered choice paths propagate both decoding and encoding services.

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

Only one conversation may be active for `(bot, chat, user)`. Conversation lookup derives this identity through the same normalized `UpdateRoutingScope` extractor used by runtime partitioning; a chat-less update cannot accidentally enter a chat-scoped conversation. Starting another conversation fails with `ConversationAlreadyActive` unless the caller explicitly chooses `conflict: "replace"`. `/cancelar` terminates the active conversation and removes reply keyboards.

### 7.4 Storage and persistence

Core `tfx/ConversationStorage` defines the yieldable `ConversationStorage.ConversationStorage` service consumed by the conversation runtime. Storage is always provided explicitly; there is no implicit or reference default that could silently select non-durable storage in production.

Core tfx also exports `MemoryConversationStorage.layer`, a scoped in-process implementation for development, examples, tests, and bots that intentionally accept restart data loss. It supports the complete storage contract, including create/start, load by bot/chat/user scope, optimistic revision transitions, complete/cancel, expiration, version migration, and conflict behavior. Closing its Layer scope discards all state. It does not support multi-process coordination or restart durability.

`@tfx/postgres` exports `PostgresConversationStorage.layer`, implementing the same service and semantics with durable PostgreSQL state. Carneloot explicitly provides this Layer. PostgreSQL conversation rows contain:

- bot ID;
- conversation ID and version;
- chat and user scope;
- current step;
- encoded state;
- optimistic revision;
- last applied Telegram update ID;
- creation, update, and expiration timestamps.

Transitions use compare-and-swap revision updates. Version changes require declared schema migrations. Unknown or invalid persisted state fails through a typed storage or migration error and can be safely cancelled after reporting. Both implementations must pass the shared conversation-storage conformance suite; durability and multi-process tests apply only to PostgreSQL.

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

Provide `ConversationInput`, `ConversationChoice`, and a yieldable `ConversationPrompt.ConversationPrompt` service in core tfx conversation modules.

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

### 7.7 Transition transactions and side-effect boundary

Conversation durability covers persisted step/state, schema version, optimistic revision, restart recovery, and duplicate transition prevention. PostgreSQL storage also coordinates participating domain writes with state transition, but no design can make Telegram sends or arbitrary external effects atomic with SQL.

`ConversationStorage` exposes an internal higher-order transition operation receiving scope, update ID, expected revision, and handler Effect. PostgreSQL implementation runs one bounded transaction:

1. begin transaction and `SELECT` conversation row `FOR UPDATE`;
2. verify revision, active scope, and last applied update ID before handler execution;
3. decode input and run handler/domain Effect under the same ambient `PgClient` transaction;
4. persist transition, incremented revision, and last applied update ID;
5. commit;
6. only after commit, run target-step `enter` and optional transition `afterCommit` effects;
7. complete outer update claim.

Carneloot repositories use the same provided `PgClient`, so food/domain SQL writes participate in this transaction without changing public handler style. Handler failure, interruption, or transition deadline rolls back both participating domain writes and conversation state and returns `RetryableFailure` or its declared permanent outcome. A second update blocks before its handler executes; if pre-handler revision verification is stale after first commit, runtime reloads state and routes input against current step without running stale handler. A CAS/revision failure after verification and handler execution despite exclusive row lock is an invariant violation and becomes `Fatal`; runtime never reruns already-executed handler against another step.

A redelivered same update matching last applied update ID is handled without rerunning domain Effect or transition. Start, cancel, timeout, administrative recovery, and replica processing must use same storage-controlled transition path rather than mutating conversation row outside lock. Configure finite transition deadline so row lock is never held while waiting for user input; transaction exists only while processing one received update.

Memory storage uses scoped mutex/semaphore around verify, handler, and state update. It provides single-process serialization but cannot roll back arbitrary external effects. Effects not participating in shared PostgreSQL client, including external HTTP mutations, still require update-derived idempotency and should preferably be scheduled after commit.

`transition.to`, `complete`, and cancellation may carry an ephemeral `afterCommit` Effect for success replies, reactions, or other non-durable follow-up. Target-step `enter` is also post-commit. These effects are not persisted. Failure or interruption after state commit does not roll state back and does not make already-applied update eligible to transition again. Output failure is reported as `HandledWithOutputFailure`, and current step can re-render prompt on next relevant input or through explicit resume/re-render operation.

Direct Telegram/context calls inside transactional handler are outside tfx consistency guarantees and must not be used for critical conversation output. Non-idempotent Telegram sends are not blindly retried. Crash before post-commit send can lose output; ambiguous transport outcome can still duplicate it. This is explicit best-effort boundary.

Do not use `effect/unstable/workflow` as initial conversation substrate. Its replay/activity model, cluster-backed durable engine, unstable API, and lack of explicit suspended-execution migrations do not match tfx's inspectable versioned step/state contract. Future optional integration may be considered for suitable long-running orchestration after Effect API stabilizes, without changing public conversation model.

If production evidence later requires durable prompt delivery, add serializable conversation-output intents behind `JobStore` as separate design change rather than silently strengthening initial guarantees.

## 8. Runtime, concurrency, and delivery

### 8.1 Update delivery selection and internal sources

Core `tfx` defines the internal `UpdateSource.UpdateSource` service plus a branded `UpdateDelivery<Mode, E, R>` descriptor. A descriptor carries one literal mode identifier and one Layer that provides `UpdateSource`; its Layer errors and requirements propagate into the resulting runtime Layer.

Applications do not provide `UpdateSource` directly. `BotRuntime.layer(bot, { delivery })` requires exactly one descriptor argument and installs its source Layer internally. Omitting `delivery` is a type error, and passing an array or multiple descriptors is not accepted by the API. This avoids relying on Effect Context or Layer merging to detect duplicate providers of the same service tag.

```ts
const RuntimeLive = BotRuntime.layer(Carneloot, {
  delivery: Polling.make({ timeout: "30 seconds" })
})
```

Core constructors are `Polling.make(options)` and `Webhook.make(options)`. Polling and webhook remain mutually exclusive for one bot runtime and Telegram token. Runtime configuration chooses one descriptor explicitly, using `Layer.unwrap` when the mode comes from Effect `Config`.

Third-party transports use `UpdateDelivery.make({ id, layer })` to create one branded descriptor backed by their own `UpdateSource` Layer. The bot runtime still receives one descriptor regardless of transport implementation.

Both built-in descriptors expose the same decoded update-source boundary, and raw values are decoded using generated Effect Schemas before dispatch. A webhook descriptor additionally carries its secret-validated Effect HttpApi route and control service so application code can mount the same configured value into its server. Platform-specific Node.js or Bun server Layers remain application choices.

### 8.2 Long polling

Long polling repeatedly calls Telegram `getUpdates` with one in-flight HTTP request. Telegram holds that request until an update is available or the configured long-poll timeout expires, then returns a batch. An empty timeout response is normal and immediately starts the next request.

The source Layer inside `Polling.make(options)` performs startup:

1. initializes bot identity through the Telegram service;
2. deletes any active webhook because Telegram does not permit webhook delivery and `getUpdates` for the same bot simultaneously;
3. passes explicit `dropPendingUpdates` only to webhook deletion, defaulting to `false`;
4. publishes the command menu inferred from the bot declaration, including configured language metadata;
5. starts `getUpdates` with default 30-second long-poll timeout, optional batch limit, inferred or explicit allowed-update types, and current offset.

Command-menu publication is an idempotent required startup step. Rate limits honor `retryAfter`; transient network/internal failures use configured startup retry schedule; authentication or exhausted retry fails polling startup before first `getUpdates`.

The HTTP transport timeout must exceed the Telegram long-poll timeout by a configured margin. The bot declaration supplies the default `allowed_updates` set from its commands, conversations, callbacks, and update handlers. An explicit override is validated against observed declaration requirements so required update kinds are not silently omitted. Send `allowed_updates` on the first request and omit it on later requests because Telegram retains the setting.

For each batch, tfx schema-decodes updates, dispatches them through deduplication and partitioned concurrency, and waits for the batch to settle before issuing an offset that confirms it. Telegram acknowledges every update below the next requested offset, so tfx advances only through acknowledgeable `DispatchOutcome` values or updates already completed by deduplication. `RetryableFailure` or `Fatal` prevents confirmation past that update and causes redelivery or runtime stop according to the outcome contract below. With PostgreSQL deduplication, already completed members of the repeated batch are skipped; without deduplication, applications accept possible duplicate handling.

Polling differs deliberately from grammY's simple runner, which advances by last tried update. tfx does not confirm an update merely because handler execution started. It still provides at-least-once rather than exactly-once processing.

Polling retry behavior follows typed `TelegramError` reasons: `RateLimitError` honors `retryAfter`, transient network and internal Telegram failures use a configurable Effect schedule, and authentication or polling-conflict errors are terminal. A `409` commonly indicates an active webhook or another poller.

Stopping the polling Layer aborts the in-flight `getUpdates`, stops intake, and follows scoped shutdown for active dispatch fibers. It does not issue a final acknowledgement request for unfinished updates.

### 8.3 Webhook delivery

`Webhook.make(options)` returns a delivery descriptor carrying the internal `UpdateSource` Layer, a yieldable `Webhook.Webhook` control service, and a platform-neutral Effect HttpApi endpoint. Application code mounts that endpoint into its existing Effect HTTP server and provides `@effect/platform-node` or `@effect/platform-bun` server Layers directly.

Webhook configuration contains public base URL, route path, a `Redacted` Telegram secret token, inferred or explicit allowed-update types, optional Telegram `max_connections`, separate HTTP request deadline and processing timeout, shutdown grace period, and bounded intake capacity. Use Telegram's `X-Telegram-Bot-Api-Secret-Token` request header and constant-time comparison. Do not place the secret in the URL path or logs.

Webhook registration is explicit rather than an automatic Layer acquisition side effect. The application yields `Webhook.Webhook` and invokes `register`, which calls Telegram `setWebhook` with full public route URL, secret token, allowed-update types, optional maximum connections, and explicit `drop_pending_updates` defaulting to `false`. Layer release does not automatically delete the remote webhook because that would break restarts and rolling deployment; explicit control operations may register, inspect, or delete it.

Carneloot exposes webhook management only through deployment CLI programs: `webhook:set`, `webhook:info`, and `webhook:delete`. It does not retain state-changing `GET /api/set-webhook` or add an HTTP admin replacement. `webhook:set` loads validated config, constructs the same webhook descriptor, registers its public URL and secret header token, passes inferred allowed updates, and publishes the Portuguese command menu. Dropping pending updates requires an explicit `--drop-pending-updates` flag. Commands print typed results and exit non-zero on failure. Deployment starts and health-checks the application before running `webhook:set`.

For each request, the endpoint:

1. validates the secret header before decoding private payload data;
2. schema-decodes the generated Telegram `Update`;
3. offers a request envelope to the bounded update source;
4. waits on an Effect completion signal while normal deduplication, partitioning, middleware, and dispatch run;
5. maps the terminal outcome to HTTP response.

Already-completed duplicates and dispatch outcomes classified as acknowledgeable below return `2xx`. Queue saturation before claim, request wait timeout, processing timeout, and `RetryableFailure` return `503` so Telegram retries; `Fatal` returns `500` and marks runtime unhealthy. Secret authentication failure returns `401`; malformed non-Telegram payload returns `400` and is reported without logging private body content. The endpoint never acknowledges before enqueue and never silently drops an update.

Once a deduplication claim is acquired, dispatch fiber belongs to `Webhook.layer` scope rather than HTTP request scope. Request waits on completion only until `requestDeadline`; timeout or client disconnect returns/abandons response while claimed processing continues and heartbeat remains active. Retry observes `InProgress`, waits within its own deadline, and receives original outcome when available; later retry of completed claim returns `2xx`. This prevents request timeout from releasing work that may already have external effects.

`processingTimeout` separately bounds dispatch lifetime. On processing timeout runtime interrupts fiber, releases claim as retryable using current fencing token, and wakes waiters with `503`; stale timed-out processor cannot complete newer claim generation. Queue saturation occurs before claim and returns `503` without owning work. With explicit no-op deduplicator, concurrent retries after request timeout remain accepted best-effort duplicate risk.

Concurrent webhook requests share normal keyed runtime: updates for one partition execute sequentially in accepted arrival order, while unrelated partitions may execute concurrently. PostgreSQL deduplication prevents concurrent Telegram retries from executing same `update_id` twice. Webhook transport provides no durable raw-update inbox in initial design.

Scoped shutdown stops accepting requests, permits active claimed fibers to finish during configured grace period, completes finished claims, then interrupts remainder and releases them as retryable with fencing tokens. If release cannot reach PostgreSQL, lease expiry permits later takeover.

### 8.4 Effect concurrency

No public worker, thread, or Promise-pool abstraction is used for update dispatch.

The runtime uses:

- a bounded queue for backpressure;
- `Stream.groupByKey` or an equivalent Effect primitive;
- one sequential stream per active partition;
- scoped fibers for independent active partitions;
- a global concurrency bound;
- idle expiration for inactive partition groups;
- structured interruption during shutdown.

Before partitioning or conversation lookup, derive one normalized `UpdateRoutingScope`: `ChatUser(bot, chat, user)`, `Chat(bot, chat)`, `User(bot, user)`, `BusinessConnection(bot, connection)`, or final `Update(bot, updateId)` fallback. Message, callback, reaction, channel, inline, and business update extractors must map through this shared model. Conversation lookup uses compatible `ChatUser` identity directly and never treats the ordering partition key as conversation identity.

`BotRuntime.layer` accepts an explicit partition strategy. Default `Partitioning.byChat` maps both `ChatUser` and `Chat` to bot/chat, then falls back to bot/user, bot/business-connection, or bot/update. This preserves strong chat-level ordering and matches Carneloot's mostly private-chat usage, while unrelated chats proceed concurrently.

`Partitioning.byConversationScope` instead maps `ChatUser` to bot/chat/user, allowing unrelated users in one group to proceed concurrently at the cost of possible races in chat-shared handlers. Advanced applications may provide a total custom function from `UpdateRoutingScope` to a hashable partition key. Regardless of strategy, related conversation updates must resolve through the normalized routing scope, and chat-less inline callbacks are not eligible for a chat-scoped conversation.

### 8.5 Update deduplication

Core internal code always yields the required `UpdateDeduplicator.UpdateDeduplicator` `Context.Service`. It has no implicit or `Context.Reference` default, so `BotRuntime.layer` exposes an unresolved deduplicator requirement until application composition provides one. Core exports explicit `UpdateDeduplicator.layerNoop` for simple bots that intentionally accept duplicates; Carneloot never uses that Layer in production.

`@tfx/postgres` exports `PostgresUpdateDeduplicator.layer`, implementing persisted claims with processing status, lease expiration, attempts, completion time, fencing generation, and retention cleanup. Carneloot provides this Layer by default.

A claim returns one of three states: `Acquired` with a generation-bearing claim token, `Completed`, or `InProgress` with a bounded completion handle. A concurrent webhook request that finds `InProgress` waits only until the active claim completes or its own request deadline approaches. Successful original completion makes the duplicate return `2xx`; retryable original failure or wait timeout makes it return `503`. A previously `Completed` update returns `2xx` immediately. This avoids both duplicate execution and unbounded HTTP waits.

Claims are never stolen before lease expiry. Active processing heartbeats its lease. Expired-lease takeover increments generation, and complete/release operations compare update ID, generation, and processing status. A stale token fails with `ClaimLost` and cannot complete or release a newer claim. Lease loss interrupts the local processing fiber when possible, but domain writes still use update-derived idempotency because fencing cannot undo an external side effect already started by a stale process.

Same-process waiters use an Effect `Deferred`; PostgreSQL remains source of truth. Future replicas may observe completion through bounded PostgreSQL polling or notification without changing the service contract. The explicitly provided no-op Layer treats every update as independently acquired and provides no duplicate protection.

Each implementation reports diagnostic metadata such as `mode: "none" | "durable"` and backend name. Carneloot's final Layer is incomplete without the PostgreSQL aggregate Layer, and production startup/tests assert durable PostgreSQL mode. This makes accidental omission type-visible while retaining explicit opt-in ergonomics for simple bots.

Polling acknowledgement follows the accepted-terminal-state and contiguous-offset rules above. If Telegram redelivers a batch, completed update IDs are skipped. Webhook success returns `2xx`; retryable failures permit Telegram retry.

Delivery remains at least once. Critical Carneloot writes use update-derived idempotency keys.

### 8.6 Dispatch outcomes

Transport acknowledgement depends on a closed `DispatchOutcome`, not arbitrary handler error types:

- `Handled` means declared behavior completed and transport may acknowledge;
- `HandledWithOutputFailure` means state/domain processing completed but best-effort Telegram output failed, and transport still acknowledges while reporting failure;
- `PermanentInvalid` means a decoded update cannot succeed through retry, is reported, and transport may acknowledge it;
- `RetryableFailure` means infrastructure or declared transient failure, so polling does not advance past it and webhook returns `503`;
- `Fatal` means runtime invariant, authentication, or unrecoverable defect, so polling stops without acknowledgement and webhook returns server failure while health becomes unhealthy.

Middleware/handler error policies explicitly translate expected domain rejections into `Handled` or `PermanentInvalid`. Untranslated repository, database, transport, and timeout failures cannot be called handled merely because they appear in a declared error channel. Malformed requests that fail before Telegram `Update` decoding remain HTTP `400` and never enter dispatch outcome classification.

Polling advances contiguous offset only through `Handled`, `HandledWithOutputFailure`, `PermanentInvalid`, or already-completed deduplication. Webhook returns `2xx` for those same dispatch outcomes, `503` for `RetryableFailure`, and `500` for `Fatal`.

## 9. Jobs and PostgreSQL delivery

Core `tfx/Job` and `tfx/JobStore` own storage-neutral typed job declarations, job execution runtime, and the yieldable `JobStore.JobStore` contract. Core tfx exports an explicit scoped `MemoryJobStore.layer` for development, examples, tests, and intentionally non-durable single-process bots. No job store is selected implicitly.

`@tfx/postgres` exports `PostgresJobStore.layer`, implementing durable scheduling, claiming, attempts, and completion through the same `JobStore` contract. Both stores pass shared behavior conformance tests, with durability and multi-process claim tests applying only to PostgreSQL.

A job declaration contains:

- literal job name;
- a `VersionedSchema` payload history whose final node supplies current version and payload schema;
- retry policy;
- handler requirements.

Declare payload evolution through named version nodes and a linear history:

```ts
const V1 = VersionedSchema.version(1, FeedingReminderV1)
const V2 = VersionedSchema.version(2, FeedingReminderV2)

const FeedingReminderPayload = VersionedSchema.history(V1).pipe(
  VersionedSchema.to(V2, migrateV1ToV2)
)

const FeedingReminder = Job.make("feeding-reminder", {
  payload: FeedingReminderPayload,
  retry: FeedingReminderRetry
})
```

`VersionedSchema.to` infers source type from current history tail and destination type/version from named node, so migration declarations do not repeat `from` or `to` numbers. The final node determines current job payload type and persisted version. Version numbers are explicit and stable; construction validates strictly contiguous history with no duplicates or gaps. Migration functions are deterministic, independently testable, require no services, and perform no external side effects. The same abstraction may support conversation-state evolution where its derived state history fits.

On claim, current-version payload decodes and executes. Older payload walks contiguous migrations, then persists migrated payload/version in same transaction before first execution attempt. Migration does not increment normal attempt count. Missing migration, invalid stored payload, or unknown job declaration moves row to recoverable `quarantined` status with structured reason; normal retry schedule does not repeat deterministic migration failure. A stored version newer than running declaration is quarantined as `UnsupportedNewerVersion`, never executed or deleted by older code. Compatible deployment or operator action may release quarantined work.

Job statuses are `scheduled`, `running`, `completed`, `failed`, `quarantined`, and `cancelled`. Quarantine records reason, stored/current versions, schema issue when available, and timestamp. Job claim fencing prevents an old lease holder from completing work after takeover.

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
notification_events
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

### 10.4 Notification events and deliveries

Notification persistence is Carneloot application domain, not tfx infrastructure or `@tfx/postgres`. One `notification_event` represents one external notification invocation, feeding reminder, or food-added notification. Recipient rows in `notification_deliveries` correlate every attempted Telegram delivery to that event.

An event stores kind, owner, optional template and pet references, and creation time. A delivery stores event, recipient user/chat, recipient role (`owner` or `subscriber`), optional Telegram message ID, status (`pending`, `sent`, `failed`, or `unknown`), error summary, and timestamps. Sent Telegram identity is unique by `(bot_id, recipient_chat_id, telegram_message_id)`.

Before sending, Carneloot transactionally creates event plus pending recipient deliveries. It then sends recipients concurrently and updates each row independently: Telegram failure becomes `failed`; Telegram success plus persisted message ID becomes `sent`; Telegram success followed by an unconfirmed history write remains `pending` and recovery classifies it `unknown`. Unknown delivery is never retried automatically because Telegram may already have accepted it. No Telegram send starts if initial event/delivery transaction fails.

Generic notification HTTP success counts only persisted `sent` rows. All sent returns `200`; mixed sent/failed/unknown returns `207`; no confirmed sent delivery returns `502`. Database failure after an external send cannot be reported as success.

Reply routing looks up sent delivery by bot/chat/replied-message identity, loads its event, and then loads owner's sent delivery for the same event. Subscriber reply forwards to owner while replying to that exact owner message. Owner-role self-reply is rejected. Feeding-reminder event carries pet identity for safe pet-food routing. Food-added events remain silent but provide per-recipient audit status.

Job-based notification delivery never retries recipients already confirmed `sent`; recipient delivery state scopes retry decisions. Crash after Telegram accepts a message but before status persistence remains an explicit unknown boundary rather than falsely sent or safely retryable.

## 11. HTTP API and deployment

Use Effect HttpApi for Carneloot HTTP endpoints and tfx webhook integration. Replace Hono.

Required parity:

- authenticated `POST /api/notify` behavior;
- explicit webhook set/info/delete deployment CLI capability replacing unsafe HTTP setup;
- secret-validated `POST /api/webhook` Telegram receiver.

The HTTP server exposes no webhook-management endpoint. Webhook registration is never an implicit startup or Layer-acquisition side effect.

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

Slice 1 establishes one private test harness under `packages/tfx/test/internal` and `packages/postgres/test/internal`, excluded from package exports. It includes fake Telegram/request recording, update fixtures, an in-memory delivery source, conversation scenario support, PostgreSQL test Layer/migration reset, and conversation/job/deduplicator conformance functions. Slices 2–3 extend these same helpers rather than creating parallel harnesses. Slice 4 extracts, stabilizes, documents, and publishes them as reusable testing APIs.

### 14.2 Compile-time coverage

Type tests cover:

- unknown and missing group, command, and conversation handlers;
- command input ordering, inferred records, and invalid composition constraints;
- rejection of non-string-encoded command, conversation-text, and callback-data codecs;
- propagation of decoding services for command/message input and both decoding/encoding services for callback/choice codecs;
- conversation step state and transition inference;
- middleware-provided and request-scoped middleware-required services, including invalid ordering;
- middleware implementation Layer requirements propagating separately into the application Layer;
- context-service availability only for compatible handler and conversation input kinds;
- callback-data string-codec, namespace, and typed choice-result inference;
- required single `UpdateDelivery` selection, rejecting omitted or multiple descriptors;
- propagation of the selected delivery descriptor's Layer errors and requirements;
- unresolved `UpdateDeduplicator` until an explicit no-op or concrete Layer is provided;
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
- explicit polling-versus-webhook descriptor selection and dynamic Effect Config selection;
- normalized routing-scope extraction across message, callback, reaction, channel, inline, and business updates;
- `byChat`, `byConversationScope`, and custom partition strategies, including chat-less conversation rejection;
- long-poll startup, webhook deletion, pending-update policy, command-menu publication, allowed-update inference, offset advancement, batch redelivery, retry classification, and scoped stop;
- webhook registration/control, secret-header validation, HttpApi mounting, bounded intake, completion acknowledgement, HTTP outcome mapping, concurrent duplicate claims, and scoped shutdown;
- detached claimed processing across HTTP deadline/disconnect, separate processing timeout, retry observation of in-progress/completed work, and shutdown grace/release;
- webhook set/info/delete CLI behavior, explicit destructive flag, command-menu publication, typed exit failure, and absence of HTTP management route;
- bounded in-progress claim waiting, lease heartbeat, expired takeover generation, stale completion/release rejection, and local interruption after claim loss;
- explicit no-op versus durable deduplicator composition and startup diagnostic metadata;
- every closed `DispatchOutcome` mapping for polling/webhook acknowledgement, retry, stop, and health behavior;
- empty and duplicate choice options, cancellation, invalid input, callback acknowledgement, and reply-keyboard removal;
- conversation transitions, revision conflicts, duplicate last-applied update detection, timeout, and migration;
- PostgreSQL row-lock transition transaction, participating domain-write rollback, different-update serialization, same-update replay, transition timeout, post-commit enter/afterCommit ordering, and handled output failure;
- explicit memory and PostgreSQL conversation- and job-store Layer selection;
- shared storage semantics across memory and PostgreSQL implementations;
- individual and aggregate `@tfx/postgres` Layer composition over one provided `PgClient`;
- PostgreSQL schema/prefix identifier validation, composed-length limits, and safe identifier fragments;
- coordinated tfx PostgreSQL migrations;
- food parsing and timezone boundaries;
- reminder scheduling;
- deduplication leases;
- job claims and retries;
- one-step and multi-step job payload migration, persisted migration, missing/invalid/newer-version quarantine, unknown declaration, and quarantine release;
- transactional food, reminder-job, and immediate delivery-job changes;
- notification event/pending-delivery creation before sends, independent recipient outcomes, unknown send/history window, partial HTTP responses, exact owner-event reply correlation, and chat-scoped message identity;
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

This slice includes only tfx capabilities needed by that path: Telegram generation/facade, declaration/builders, middleware, contextual helpers, keyboards/callback data, conversation input/choice/prompt helpers, polling, PostgreSQL conversations/jobs/deduplication, and the single private test harness defined above. Storage conformance contracts and minimal fake services are implemented now even though public testing packages wait until Slice 4.

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
- webhook set/info/delete deployment CLI and secret-header receiver;
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

Migrate reusable internal helpers from prior slices to these stable public APIs. Extraction must preserve all prior behavioral and conformance suites without weaker assertions; temporary internal re-exports may support incremental import changes. Public naming, documentation, packaging, and broader third-party matrices belong here, but foundational semantics are not redesigned. This slice may use separate plans for core harnesses, conversation scenarios, adapter conformance, and PostgreSQL test infrastructure.

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
- Carneloot owns notification event/delivery persistence and exact reply correlation; these tables and services are not tfx infrastructure.
- Durable job payloads use named `VersionedSchema` nodes, linear migrations, and recoverable quarantine for incompatible stored work.
- One active bot instance initially.
- Core tfx contains polling and webhook delivery descriptors backed by internal Layers; `BotRuntime.layer` requires exactly one descriptor and applications never provide `UpdateSource` directly.
- Long polling publishes command menus before its first `getUpdates`, then uses one in-flight request, inferred allowed-update types, batch settlement before contiguous acknowledgement, typed retries, and scoped cancellation.
- Webhook delivery uses an explicitly mounted HttpApi route, Telegram secret header, CLI-only remote set/info/delete operations, bounded intake, detached claimed processing with separate request/processing deadlines, post-dispatch acknowledgement, and Effect-scoped shutdown.
- One active conversation per bot/chat/user.
- Conversation storage controls a bounded row-lock transition transaction so shared-PostgreSQL domain writes and state commit succeed or roll back together; external effects remain idempotent and Telegram outputs remain best-effort post-commit. Effect Workflow is not initial substrate.
- Normalized update routing scope is shared by conversation lookup and partitioning; `byChat` is default, with `byConversationScope` and custom strategies available.
- Sequential update handling per partition, concurrent across partitions using Effect fibers.
- Immutable HttpApi-style bot declarations and exhaustive Layer-backed builders.
- Middleware provides Effect services; declarations track only request-scoped ordering contracts, while implementation infrastructure is inferred from Layers.
- Scoped `UpdateContext`, `MessageContext`, and `CallbackQueryContext` services provide thin Telegram helpers while `Telegram.Telegram` remains the complete low-level API.
- Pure immutable keyboard builders, namespaced typed callback data, and state-machine-native conversation input/choice/prompt helpers cover Carneloot interactions; persistent menus are deferred.
- Conversation and job contracts, runtimes, and scoped memory Layers live in core tfx, while consolidated `@tfx/postgres` supplies durable conversation, job, and deduplication Layers plus coordinated migrations.
- Applications provide `@effect/platform-node` or `@effect/platform-bun` Layers directly; tfx does not publish Node/Bun platform wrapper packages.
- Ordered, schema-driven command parsing uses the pure `CommandInput` module; all text leaf codecs have encoded type `string` and propagate decoding services.
- Generated Telegram schemas/client from pinned Photon OpenAPI plus tfx patches.
- `Telegram.Telegram` is yieldable; public methods unwrap successful results.
- `TelegramError` follows Effect `AiError` structure.
- Update deduplication is a required service with an explicit no-op Layer for simple bots; Carneloot's production composition requires and verifies PostgreSQL durable mode.
- Closed dispatch outcomes, not arbitrary handler errors, control transport acknowledgement and retry.
- Configurable PostgreSQL schema/table identifiers are branded, strictly validated, length-limited, and safely interpolated.
- Known Carneloot bugs and security issues are fixed.
- mise-pinned Node.js, Bun, and pnpm; pnpm workspaces, TypeScript project references, and Changesets; Bun remains a runtime, and Turborepo is deferred until measured need.
- Four product slices, each with one or more bounded implementation plans.

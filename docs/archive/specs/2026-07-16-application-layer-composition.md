# Application Layer Composition

## Status

Approved design for replacing `apps/carneloot-bot/src/Layers.ts` while implementing shared PostgreSQL migration ownership.

## Problem

`Layers.portable` currently owns unrelated responsibilities:

- platform infrastructure injection
- application and TFX migration sequencing
- persistence adapter construction
- domain service construction
- router construction
- bot and worker runtime construction
- test-specific composition through a separate `core` API

This produces a large generic factory, repeated `provideMerge` chains, broad output contexts, and unclear ownership boundaries. The graph works with Effect memoization, but understanding or changing one stage requires reasoning about the complete application topology.

## Goals

- Replace `Layers.portable` and `Layers.core` with one production-shaped application API.
- Make startup stages and migration ownership explicit.
- Keep platform selection outside application composition.
- Expose only services consumed by `Program.run`.
- Let tests substitute required leaf layers without a separate application topology.
- Preserve typed startup failures and scoped runtime lifecycle behavior.
- Keep independent acquisitions concurrent inside each stage.

## Non-Goals

- Changing `Program.run` fail-fast behavior.
- Changing bot or worker scoped-fiber ownership.
- Exposing repositories or domain services from final production layer.
- Introducing one imperative `Layer.effectContext` bootstrap.
- Adding compatibility wrappers for `Layers.core` or `Layers.portable`.
- Preserving old test composition APIs.

## Public Contract

`AppLive` becomes application composition entry point.

```ts
AppLive.layer((config) => Polling.make(pollingOptions(config)))
```

Its input context is:

```text
AppConfig | PgClient | Telegram
```

Its output context is exactly:

```text
BotRuntime | JobWorker | UpdateDeduplicator
```

Delivery is supplied as a function of validated `AppConfig`, allowing production to create configured polling while tests return `UpdateDelivery.manual`. `AppLive` reads `AppConfig` once and passes concrete configuration to internal stage constructors.

## Modules

### `PersistenceLive.ts`

Requires:

```text
PgClient
```

Receives validated `AppConfigService` from `AppLive`.

Produces the persistence services needed by later stages:

```text
UserRepository
PetRepository
PetFoodRepository
NotificationRepository
NotificationRecipients
ConversationStorage
JobStore
UpdateDeduplicator
```

Responsibilities:

1. Run TFX migrations once through `TfxPostgres.layer`.
2. Run Carneloot migrations once through `RepositoriesLive.layer`.
3. Construct migration-free store and repository adapters.
4. Keep PostgreSQL client acquisition external.

Migration gates complete before their corresponding adapters are available. TFX and Carneloot migration branches may acquire concurrently because they use distinct advisory-lock keys and ledgers.

### `DomainLive.ts`

Requires persistence services and `Telegram`.

Receives validated `AppConfigService` from `AppLive`.

Produces:

```text
Conversations
Middleware
JobRuntime
ReminderScheduler
```

Responsibilities:

1. Construct conversations from durable conversation storage.
2. Construct registered-user middleware from application repositories and Telegram.
3. Construct job runtime from durable job storage and feeding-reminder implementation.
4. Construct reminder scheduler from jobs and application repositories.

It contains no platform client creation, migrations, router construction, or runtime fibers.

### `RuntimeLive.ts`

Requires persistence and domain services.

Receives:

- validated `AppConfigService`
- selected `UpdateDelivery`
- bot username

Produces exactly:

```text
BotRuntime | JobWorker | UpdateDeduplicator
```

Responsibilities:

1. Build application router from domain services.
2. Construct bot runtime with configured dispatch and deduplication settings.
3. Construct job worker with configured lease and polling settings.
4. Forward the existing durable `UpdateDeduplicator` service for `Program.run` diagnostics.

Bot and worker layers continue to own their background fibers through scoped acquisition. Persistence and domain dependencies remain alive in the enclosing layer scope even though their tags are hidden from final output.

### `AppLive.ts`

Requires:

```text
AppConfig | PgClient | Telegram
```

Responsibilities:

1. Read validated `AppConfig` once.
2. Build selected delivery from that config.
3. Compose persistence, domain, and runtime stages in dependency order.
4. Hide intermediate contexts.
5. Return only runtime contract.

`AppLive` contains no Bun, Node, HTTP-client, database-URL, bot-token, or test-container construction.

### `Production.ts`

Production remains platform composition root.

It owns:

- `AppConfigLive.layer`
- `PgClient.layer({ url: config.databaseUrl })`
- `Telegram.layer(config.botToken)` provided with `BunHttpClient.layer`
- polling delivery selection
- provisioning platform infrastructure into `AppLive.layer`

Conceptual graph:

```text
AppConfigLive
├─ Production infrastructure
│  ├─ PgClient
│  └─ Telegram ← BunHttpClient
└─ AppLive
   ├─ PersistenceLive
   ├─ DomainLive
   └─ RuntimeLive
```

`Production.appLayer` keeps the same narrow output expected by `Program.run`.

## Startup Ordering

Startup follows this dependency sequence:

```text
validated configuration
→ PostgreSQL and Telegram clients
→ TFX and Carneloot migration gates
→ persistence adapters
→ domain services
→ router, bot runtime, and job worker
→ Program.run
```

Within a stage, independent layers use `Layer.merge` or `Layer.mergeAll` and may build concurrently. Between stages, `Layer.provide` establishes ordering and hides implementation dependencies. `Layer.provideMerge` is used only when a dependency must intentionally remain visible to the next stage.

The same named layer value is reused wherever a service must be shared. No `Layer.fresh` or local provision is introduced.

## Error Semantics

- Shared migrator failures map at persistence boundaries.
- Carneloot migration failures remain `DomainPersistenceError`.
- TFX migration failures remain typed store persistence errors.
- Domain and runtime error types remain unchanged.
- `AppLive` does not catch or downgrade startup errors.
- Any migration or acquisition failure prevents bot and worker fibers from starting.
- `Program.run` continues racing bot and worker await effects and closes the enclosing scope when either terminates.

## Testing Strategy

### Stage tests

Test stage modules only when they carry composition behavior not already covered by adapter tests:

- `PersistenceLive`: both migration suites complete and required persistence services exist.
- `DomainLive`: supplied persistence and Telegram layers produce conversations, middleware, jobs, and scheduler.
- `RuntimeLive`: supplied domain/persistence services produce bot, worker, and forwarded deduplicator.

Avoid tests that merely restate Effect's `Layer.provide` behavior.

### Complete application graph

Use:

```ts
AppLive.layer(() => UpdateDelivery.manual)
```

Provide:

- test `AppConfig`
- disposable PostgreSQL layer
- Telegram layer using Node HTTP infrastructure

Assert:

- final context contains `BotRuntime`, `JobWorker`, and `UpdateDeduplicator`
- Carneloot migration started/completed events each occur once
- TFX migration started/completed events each occur once
- runtime acquisition completes without network polling

### Production smoke coverage

Verify `Production.appLayer` typechecks with the narrow runtime output. Existing tests that supplied `Layers.core` switch to `AppLive` with explicit leaf test layers or test the lower stage directly.

## File Changes

Create:

```text
apps/carneloot-bot/src/AppLive.ts
apps/carneloot-bot/src/PersistenceLive.ts
apps/carneloot-bot/src/DomainLive.ts
apps/carneloot-bot/src/RuntimeLive.ts
```

Modify:

```text
apps/carneloot-bot/src/Production.ts
apps/carneloot-bot/test/NodeSmoke.test.ts
apps/carneloot-bot/test/PortableLayer.integration.test.ts
```

Delete:

```text
apps/carneloot-bot/src/Layers.ts
```

Any other tests importing `Layers.core` or `Layers.portable` move to `AppLive` or the narrow stage matching their subject.

## Acceptance Criteria

- No `Layers.core` or `Layers.portable` API remains.
- Production application layer requires platform infrastructure instead of accepting platform layers as generic options.
- Configuration is read once inside `AppLive`.
- Persistence, domain, and runtime topology is split across focused modules.
- Final output is exactly `BotRuntime | JobWorker | UpdateDeduplicator`.
- Individual adapters remain migration-free.
- TFX and Carneloot migrations each execute once per application-layer build.
- Test composition uses production-shaped `AppLive` or focused stage layers, not an alternate application graph.
- Existing lifecycle, error, formatting, lint, typecheck, unit, and integration checks pass.

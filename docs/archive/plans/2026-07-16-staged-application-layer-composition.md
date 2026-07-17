# Staged Application Layer Composition Implementation Plan

**Goal:** Replace `Layers.core` and `Layers.portable` with one production-shaped `AppLive` layer composed from explicit persistence, domain, and runtime stages, while exposing only `BotRuntime | JobWorker | UpdateDeduplicator`.

**Architecture:** `PersistenceLive` owns aggregate persistence composition, `DomainLive` builds application services, `RuntimeLive` builds router-backed bot and worker runtimes, and `AppLive` reads configuration once and hides all intermediate services. `Production` remains platform composition root and supplies `AppConfig`, PostgreSQL, Telegram, Bun HTTP, and polling delivery.

**Tech Stack:** TypeScript 7, Effect 4.0.0-beta.98 Layers, `@effect/sql-pg`, Bun/Node platform layers, Vitest 4.

---

## Dependency On Shared Migrator Plan

This plan depends on `docs/plans/2026-07-16-shared-postgres-migrator-and-layer-lifecycle.md`, but the two plans must not be executed completely in serial order because that plan still contains temporary `Layers.portable` wiring and coverage.

### Best Combined Execution Order

1. Execute shared-migrator **Tasks 1–3** unchanged: package scaffold, validation, and runner.
2. Execute shared-migrator **Task 4** for TFX adoption, with focused adapter tests explicitly gated by `Migrations.migrate(options)` instead of acquiring the entire aggregate merely to initialize schemas.
3. Execute shared-migrator **Task 5 Steps 1–3 and 5–9**: create Carneloot manifest adapter, create `RepositoriesLive`, remove hidden migration from `NotificationRepositoryLive`, update direct integration graphs, remove old validator, and verify ownership.
4. **Skip shared-migrator Task 5 Step 4.** Do not rewire `Layers.portable`; Task 1 of this plan wires `RepositoriesLive` into `PersistenceLive` directly.
5. Execute **Tasks 1–6 of this plan**: staged layers, `AppLive`, production/test consumers, and deletion of `Layers.ts`.
6. **Skip shared-migrator Task 6.** Task 4 of this plan replaces its `PortableLayer.integration.test.ts` with final `AppLive.integration.test.ts` coverage.
7. Execute shared-migrator **Task 7** at any point after its migration commits; source-fiber log naming is independent.
8. Execute **Task 7 of this plan** as combined final verification. It supersedes shared-migrator Task 8.

This ordering avoids creating and immediately deleting `Layers.portable` wiring and tests.

## Resulting Graph

```text
Production.appLayer
├─ AppConfigLive.layer
├─ Production infrastructure
│  ├─ PgClient.layer
│  └─ Telegram.layer ← BunHttpClient.layer
└─ AppLive.layer(pollingFactory)
   ├─ PersistenceLive.layer(config)
   │  ├─ TfxPostgres.layer(config)
   │  └─ RepositoriesLive.layer
   ├─ DomainLive.layer
   │  ├─ Conversations.layer
   │  ├─ Middleware.layer
   │  ├─ JobRuntime.layer
   │  └─ ReminderSchedulerLive.layer
   └─ RuntimeLive.layer(config, delivery)
      ├─ AppRouter.make
      ├─ BotRuntimeLive.layer
      ├─ JobWorkerLive.layer
      └─ UpdateDeduplicator passthrough
```

Final output:

```text
BotRuntime | JobWorker | UpdateDeduplicator
```

Final requirements before production provisioning:

```text
AppConfig | PgClient | Telegram
```

---

### Task 1: Compose Persistence Stage

**Prerequisite:** Shared-migrator Task 5 has created `apps/carneloot-bot/src/postgres/RepositoriesLive.ts` and removed migration from individual adapters.

**Files:**
- Create: `apps/carneloot-bot/src/PersistenceLive.ts`
- Create: `apps/carneloot-bot/test/PersistenceLive.integration.test.ts`

- [ ] **Step 1: Write failing persistence-stage integration test**

Create `apps/carneloot-bot/test/PersistenceLive.integration.test.ts`:

```ts
import { Effect, Layer } from 'effect';
import { ConversationStorage } from 'tfx/ConversationStorage';
import { JobStore } from 'tfx/JobStore';
import { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';
import { describe, expect, it } from 'vitest';

import type { AppConfigService } from '../src/Config.js';
import * as PersistenceLive from '../src/PersistenceLive.js';
import { NotificationRecipients } from '../src/ports/NotificationRecipients.js';
import { NotificationRepository } from '../src/ports/NotificationRepository.js';
import { PetFoodRepository } from '../src/ports/PetFoodRepository.js';
import { PetRepository } from '../src/ports/PetRepository.js';
import { UserRepository } from '../src/ports/UserRepository.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';
import { testConfig } from './internal/TestConfig.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';

describe.skipIf(!enabled)('application persistence layer', () => {
	it('acquires both migrated persistence suites', async () => {
		const config: AppConfigService = {
			...testConfig,
			tfxSchema: 'tfx_persistence_stage',
			tfxTablePrefix: 'case_',
		};
		const graph = Layer.provide(
			PersistenceLive.layer(config),
			PostgresTestLayer.layer,
		);
		await Effect.runPromise(
			Effect.scoped(
				Effect.flatMap(Layer.build(graph), (context) =>
					Effect.provide(
						Effect.gen(function* () {
							yield* ConversationStorage;
							yield* JobStore;
							yield* UpdateDeduplicator;
							yield* UserRepository;
							yield* PetRepository;
							yield* PetFoodRepository;
							yield* NotificationRepository;
							yield* NotificationRecipients;
						}),
						context,
					),
				),
			),
		);
		expect(true).toBe(true);
	});
});
```

If `apps/carneloot-bot/test/internal/TestConfig.ts` does not yet exist, create it in Step 3 before rerunning. The first run should fail on missing `PersistenceLive` regardless.

- [ ] **Step 2: Run test to verify missing module failure**

Run:

```bash
RUN_TESTCONTAINERS=true pnpm vitest run --config vitest.integration.config.ts \
  apps/carneloot-bot/test/PersistenceLive.integration.test.ts
```

Expected: FAIL because `PersistenceLive.ts` does not exist.

- [ ] **Step 3: Extract shared test configuration fixture**

Create `apps/carneloot-bot/test/internal/TestConfig.ts`:

```ts
import * as Duration from 'effect/Duration';
import * as Redacted from 'effect/Redacted';

import type { AppConfigService } from '../../src/Config.js';

export const testConfig = {
	botToken: Redacted.make('test'),
	databaseUrl: Redacted.make('postgres://unused'),
	botId: 'carneloot',
	botUsername: 'carneloot_bot',
	pollingTimeout: Duration.seconds(30),
	pollingRetryDelay: Duration.millis(100),
	dispatchCapacity: 8,
	dispatchConcurrency: 2,
	jobIdle: Duration.millis(100),
	jobLease: Duration.seconds(30),
	jobHeartbeat: Duration.seconds(10),
	dedupLease: Duration.seconds(30),
	dedupHeartbeat: Duration.seconds(10),
	dedupWait: Duration.seconds(1),
	dedupRetention: Duration.days(1),
	tfxSchema: 'tfx_test',
	tfxTablePrefix: 'case_',
} satisfies AppConfigService;
```

Update `NodeSmoke.test.ts` and later new tests to import this fixture instead of duplicating it.

- [ ] **Step 4: Implement persistence stage**

Create `apps/carneloot-bot/src/PersistenceLive.ts`:

```ts
import * as TfxPostgres from '@tfx/postgres/TfxPostgres';
import * as Layer from 'effect/Layer';

import type { AppConfigService } from './Config.js';
import * as RepositoriesLive from './postgres/RepositoriesLive.js';

export const layer = (config: AppConfigService) =>
	Layer.merge(
		TfxPostgres.layer({
			schema: config.tfxSchema,
			tablePrefix: config.tfxTablePrefix,
			botId: config.botId,
		}),
		RepositoriesLive.layer,
	);
```

Both branches require the same externally supplied `PgClient`. They may migrate concurrently because they use distinct schemas, ledgers, and advisory-lock keys.

- [ ] **Step 5: Run persistence tests**

Run:

```bash
RUN_TESTCONTAINERS=true pnpm vitest run --config vitest.integration.config.ts \
  apps/carneloot-bot/test/PersistenceLive.integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit persistence stage**

```bash
git add apps/carneloot-bot/src/PersistenceLive.ts \
  apps/carneloot-bot/test/PersistenceLive.integration.test.ts \
  apps/carneloot-bot/test/internal/TestConfig.ts \
  apps/carneloot-bot/test/NodeSmoke.test.ts
git commit -m "refactor(carneloot): compose persistence stage"
```

---

### Task 2: Compose Domain Stage

**Files:**
- Create: `apps/carneloot-bot/src/DomainLive.ts`

`DomainLive` does not accept `AppConfigService`; exact dependency inspection shows none of its constructors reads configuration. This narrows the approved design without changing its boundary.

- [ ] **Step 1: Add missing-module import to application composition test fixture**

Create a temporary compile fixture `apps/carneloot-bot/type-test/ApplicationStages.tst.ts`:

```ts
import type * as Layer from 'effect/Layer';
import { Conversations } from 'tfx/Conversations';
import { JobRuntime } from 'tfx/JobRuntime';
import { MiddlewareRegistry } from 'tfx/Middleware';

import { ReminderScheduler } from '../src/ports/ReminderScheduler.js';
import { layer } from '../src/DomainLive.js';

type Assert<T extends true> = T;
type Includes<Whole, Part> = [Part] extends [Whole] ? true : false;

export type DomainProvidesConversations = Assert<
	Includes<Layer.Success<typeof layer>, Conversations>
>;
export type DomainProvidesMiddleware = Assert<
	Includes<Layer.Success<typeof layer>, MiddlewareRegistry>
>;
export type DomainProvidesJobs = Assert<
	Includes<Layer.Success<typeof layer>, JobRuntime>
>;
export type DomainProvidesScheduler = Assert<
	Includes<Layer.Success<typeof layer>, ReminderScheduler>
>;
```

- [ ] **Step 2: Run typecheck to verify missing module failure**

Run:

```bash
pnpm check
```

Expected: FAIL because `DomainLive.ts` does not exist.

- [ ] **Step 3: Implement domain stage**

Create `apps/carneloot-bot/src/DomainLive.ts`:

```ts
import * as Layer from 'effect/Layer';
import * as Conversations from 'tfx/Conversations';
import * as JobRuntimeLive from 'tfx/JobRuntime';
import * as Middleware from 'tfx/Middleware';

import * as RegisteredUser from './bot/RegisteredUser.js';
import * as FeedingReminderJobLive from './jobs/FeedingReminderJobLive.js';
import * as ReminderSchedulerLive from './postgres/ReminderSchedulerLive.js';

const core = Layer.mergeAll(
	Conversations.layer,
	Middleware.layer(RegisteredUser.live),
	JobRuntimeLive.layer(FeedingReminderJobLive.implementation),
);

export const layer = Layer.provideMerge(
	ReminderSchedulerLive.layer,
	core,
);
```

`provideMerge` is intentional here: `JobRuntime` from `core` satisfies `ReminderSchedulerLive`, while conversations, middleware, jobs, and scheduler must all remain visible to `RuntimeLive`.

- [ ] **Step 4: Run typecheck**

Run:

```bash
pnpm check
```

Expected: PASS.

- [ ] **Step 5: Commit domain stage**

```bash
git add apps/carneloot-bot/src/DomainLive.ts \
  apps/carneloot-bot/type-test/ApplicationStages.tst.ts
git commit -m "refactor(carneloot): compose domain stage"
```

---

### Task 3: Compose Narrow Runtime Stage

**Files:**
- Create: `apps/carneloot-bot/src/RuntimeLive.ts`
- Modify: `apps/carneloot-bot/type-test/ApplicationStages.tst.ts`

- [ ] **Step 1: Add failing exact-output type assertion**

Append to `apps/carneloot-bot/type-test/ApplicationStages.tst.ts`:

```ts
import { BotRuntime } from 'tfx/BotRuntime';
import { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';
import * as UpdateDelivery from 'tfx/UpdateDelivery';

import { JobWorker } from '../src/JobWorker.js';
import * as RuntimeLive from '../src/RuntimeLive.js';
import { testConfig } from '../test/internal/TestConfig.js';

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends
	(<T>() => T extends B ? 1 : 2)
		? true
		: false;

const runtime = RuntimeLive.layer(testConfig, UpdateDelivery.manual);

export type RuntimeOutputIsNarrow = Assert<
	Equal<
		Layer.Success<typeof runtime>,
		BotRuntime | JobWorker | UpdateDeduplicator
	>
>;
```

- [ ] **Step 2: Run typecheck to verify missing module failure**

Run:

```bash
pnpm check
```

Expected: FAIL because `RuntimeLive.ts` does not exist.

- [ ] **Step 3: Implement runtime stage**

Create `apps/carneloot-bot/src/RuntimeLive.ts`:

```ts
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type { Router } from 'tfx/BotRouter';
import * as BotRuntimeLive from 'tfx/BotRuntime';
import { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';
import type * as UpdateDelivery from 'tfx/UpdateDelivery';

import { Carneloot } from './bot/Declaration.js';
import type { AppConfigService } from './Config.js';
import * as JobWorkerLive from './JobWorker.js';
import * as AppRouter from './Router.js';

const runtimeOptions = (config: AppConfigService, router: Router) => ({
	capacity: config.dispatchCapacity,
	concurrency: config.dispatchConcurrency,
	leaseDuration: config.dedupLease,
	waitTimeout: config.dedupWait,
	retention: config.dedupRetention,
	heartbeatInterval: config.dedupHeartbeat,
	router,
});
const workerOptions = (config: AppConfigService) => ({
	idleDelay: config.jobIdle,
	leaseDuration: config.jobLease,
	heartbeatInterval: config.jobHeartbeat,
});

export const layer = <
	D extends UpdateDelivery.UpdateDelivery<any, any, any>,
>(
	config: AppConfigService,
	delivery: D,
) => {
	const bot = Layer.unwrap(
		Effect.map(AppRouter.make(config.botUsername), (router) =>
			BotRuntimeLive.layer(Carneloot, {
				delivery,
				...runtimeOptions(config, router),
			}),
		),
	);
	const worker = JobWorkerLive.layer(workerOptions(config));
	const deduplicator = Layer.effect(
		UpdateDeduplicator,
		UpdateDeduplicator,
	);
	return Layer.mergeAll(bot, worker, deduplicator);
};
```

`Layer.effect(UpdateDeduplicator, UpdateDeduplicator)` forwards the already-built durable service without rebuilding it. Do not use `provideMerge` at the final runtime boundary.

- [ ] **Step 4: Run focused typecheck and unit tests**

Run:

```bash
pnpm check
pnpm vitest run packages/tfx/test/BotRuntime.test.ts apps/carneloot-bot/test/JobWorker.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit runtime stage**

```bash
git add apps/carneloot-bot/src/RuntimeLive.ts \
  apps/carneloot-bot/type-test/ApplicationStages.tst.ts
git commit -m "refactor(carneloot): compose narrow runtime stage"
```

---

### Task 4: Compose AppLive And Final Migration Regression

**Files:**
- Create: `apps/carneloot-bot/src/AppLive.ts`
- Create: `apps/carneloot-bot/test/AppLive.integration.test.ts`
- Modify: `apps/carneloot-bot/type-test/ApplicationStages.tst.ts`

- [ ] **Step 1: Write failing full-graph integration test**

Create `apps/carneloot-bot/test/AppLive.integration.test.ts`. Use the `captureLogs` helper already specified by shared-migrator plan, but target final `AppLive` graph:

```ts
import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import { Effect, Layer, Logger, References } from 'effect';
import * as Telegram from 'tfx/Telegram';
import { BotRuntime } from 'tfx/BotRuntime';
import { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';
import * as UpdateDelivery from 'tfx/UpdateDelivery';
import { describe, expect, it } from 'vitest';

import * as AppLive from '../src/AppLive.js';
import { AppConfig } from '../src/Config.js';
import { JobWorker } from '../src/JobWorker.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';
import { testConfig } from './internal/TestConfig.js';

interface CapturedLog {
	readonly message: unknown;
	readonly level: string;
	readonly annotations: Readonly<Record<string, unknown>>;
}
const captureLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
	const logs: Array<CapturedLog> = [];
	const logger = Logger.make((options) => {
		logs.push({
			message:
				Array.isArray(options.message) && options.message.length === 1
					? options.message[0]
					: options.message,
			level: options.logLevel,
			annotations: options.fiber.getRef(References.CurrentLogAnnotations),
		});
	});
	return Effect.map(
		Effect.provideService(effect, Logger.CurrentLoggers, new Set([logger])),
		(result) => ({ result, logs }),
	);
};
const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';

describe.skipIf(!enabled)('application layer', () => {
	it('exposes narrow runtimes and acquires each migration suite once', async () => {
		const config = {
			...testConfig,
			tfxSchema: 'tfx_app_live',
			tfxTablePrefix: 'case_',
		};
		const telegram = Layer.provide(
			Telegram.layer(config.botToken),
			NodeHttpClient.layerFetch,
		);
		const infrastructure = Layer.merge(
			PostgresTestLayer.layer,
			telegram,
		);
		const graph = Layer.provide(
			Layer.provide(
				AppLive.layer(() => UpdateDelivery.manual),
				infrastructure,
			),
			Layer.succeed(AppConfig, config),
		);
		const captured = await Effect.runPromise(
			captureLogs(
				Effect.scoped(
					Effect.flatMap(Layer.build(graph), (context) =>
						Effect.provide(
							Effect.gen(function* () {
								yield* BotRuntime;
								yield* JobWorker;
								yield* UpdateDeduplicator;
							}),
							context,
						),
					),
				),
			),
		);
		const count = (message: string) =>
			captured.logs.filter((log) => log.message === message).length;
		expect(count('carneloot.migrations.started')).toBe(1);
		expect(count('carneloot.migrations.completed')).toBe(1);
		expect(count('tfx.postgres.migrations.started')).toBe(1);
		expect(count('tfx.postgres.migrations.completed')).toBe(1);
	});
});
```

- [ ] **Step 2: Run test to verify missing module failure**

Run:

```bash
RUN_TESTCONTAINERS=true pnpm vitest run --config vitest.integration.config.ts \
  apps/carneloot-bot/test/AppLive.integration.test.ts
```

Expected: FAIL because `AppLive.ts` does not exist.

- [ ] **Step 3: Implement AppLive**

Create `apps/carneloot-bot/src/AppLive.ts`:

```ts
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type * as UpdateDelivery from 'tfx/UpdateDelivery';

import { AppConfig, type AppConfigService } from './Config.js';
import * as DomainLive from './DomainLive.js';
import * as PersistenceLive from './PersistenceLive.js';
import * as RuntimeLive from './RuntimeLive.js';

export const layer = <
	D extends UpdateDelivery.UpdateDelivery<any, any, any>,
>(
	delivery: (config: AppConfigService) => D,
) =>
	Layer.unwrap(
		Effect.map(AppConfig, (config) => {
			const persistence = PersistenceLive.layer(config);
			const application = Layer.provideMerge(
				DomainLive.layer,
				persistence,
			);
			return Layer.provide(
				RuntimeLive.layer(config, delivery(config)),
				application,
			);
		}),
	);
```

The final `Layer.provide` hides persistence and domain outputs while preserving their scoped resources.

- [ ] **Step 4: Assert AppLive requirements and outputs at compile time**

Append to `apps/carneloot-bot/type-test/ApplicationStages.tst.ts`:

```ts
import type * as PgClient from '@effect/sql-pg/PgClient';
import type { Telegram } from 'tfx/Telegram';

import * as AppLive from '../src/AppLive.js';
import { AppConfig } from '../src/Config.js';

const application = AppLive.layer(() => UpdateDelivery.manual);

export type AppOutputIsNarrow = Assert<
	Equal<
		Layer.Success<typeof application>,
		BotRuntime | JobWorker | UpdateDeduplicator
	>
>;
export type AppRequirementsAreInfrastructure = Assert<
	Equal<
		Layer.Services<typeof application>,
		AppConfig | PgClient.PgClient | Telegram
	>
>;
```

If union normalization makes direct `Equal` fail despite equivalent services, replace only `AppRequirementsAreInfrastructure` with bidirectional inclusion assertions. Keep exact output assertion unchanged.

- [ ] **Step 5: Run AppLive tests and typecheck**

Run:

```bash
pnpm check
RUN_TESTCONTAINERS=true pnpm vitest run --config vitest.integration.config.ts \
  apps/carneloot-bot/test/AppLive.integration.test.ts
```

Expected: PASS with one migration lifecycle pair per suite.

- [ ] **Step 6: Commit AppLive**

```bash
git add apps/carneloot-bot/src/AppLive.ts \
  apps/carneloot-bot/test/AppLive.integration.test.ts \
  apps/carneloot-bot/type-test/ApplicationStages.tst.ts
git commit -m "refactor(carneloot): add application live layer"
```

---

### Task 5: Move Production To Platform Provisioning

**Files:**
- Modify: `apps/carneloot-bot/src/Production.ts`
- Modify: `apps/carneloot-bot/type-test/Production.tst.ts`

- [ ] **Step 1: Strengthen production output assertion**

Append to `apps/carneloot-bot/type-test/Production.tst.ts`:

```ts
import { BotRuntime } from 'tfx/BotRuntime';
import { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';

import { JobWorker } from '../src/JobWorker.js';

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends
	(<T>() => T extends B ? 1 : 2)
		? true
		: false;

export type AppLayerOutputIsNarrow = Assert<
	Equal<
		Layer.Success<typeof appLayer>,
		BotRuntime | JobWorker | UpdateDeduplicator
	>
>;
```

Current `Production.appLayer` should fail because `Layers.portable` exposes the broad application context.

- [ ] **Step 2: Run typecheck to verify broad-output failure**

Run:

```bash
pnpm check
```

Expected: FAIL at `AppLayerOutputIsNarrow`.

- [ ] **Step 3: Replace portable factory with platform infrastructure provisioning**

Rewrite production composition below `pollingOptions` in `apps/carneloot-bot/src/Production.ts`:

```ts
import * as AppLive from './AppLive.js';
```

Remove `Layers` import and `fromConfig`. Add:

```ts
const infrastructure = Layer.unwrap(
	Effect.map(AppConfig, (config) =>
		Layer.merge(
			PgClient.layer({ url: config.databaseUrl }),
			Layer.provide(
				Telegram.layer(config.botToken),
				BunHttpClient.layer,
			),
		),
	),
);
const application = Layer.provide(
	AppLive.layer((config) => Polling.make(pollingOptions(config))),
	infrastructure,
);
export const appLayer = Layer.provide(
	application,
	AppConfigLive.layer,
);
```

Both `infrastructure` and `AppLive` read the same memoized `AppConfig` service. Configuration loading still occurs once through `AppConfigLive.layer`.

- [ ] **Step 4: Run production type assertions**

Run:

```bash
pnpm check
```

Expected:

- `appLayer` has no remaining requirements.
- errors remain concrete tagged errors.
- output is exactly `BotRuntime | JobWorker | UpdateDeduplicator`.

- [ ] **Step 5: Commit production composition**

```bash
git add apps/carneloot-bot/src/Production.ts \
  apps/carneloot-bot/type-test/Production.tst.ts
git commit -m "refactor(carneloot): provide production infrastructure"
```

---

### Task 6: Migrate Consumers And Delete Layers.ts

**Files:**
- Modify: `apps/carneloot-bot/src/demo-test.ts`
- Modify: `apps/carneloot-bot/src/main.ts`
- Modify: `apps/carneloot-bot/test/NodeSmoke.test.ts`
- Modify: `apps/carneloot-bot/test/e2e/OwnedPetFoodLoop.e2e.test.ts`
- Modify: `apps/carneloot-bot/test/e2e/RestartRecovery.e2e.test.ts`
- Delete: `apps/carneloot-bot/src/Layers.ts`

- [ ] **Step 1: Replace demo and E2E graph construction**

For each former `Layers.portable(config, { pg, telegram, delivery, botUsername })` call, import `AppLive` and `AppConfig`, then construct:

```ts
const infrastructure = Layer.merge(pg, telegram);
const graph = Layer.provide(
	Layer.provide(
		AppLive.layer(() => UpdateDelivery.manual),
		infrastructure,
	),
	Layer.succeed(AppConfig, config),
);
```

Apply to:

- `apps/carneloot-bot/src/demo-test.ts`
- `apps/carneloot-bot/test/e2e/OwnedPetFoodLoop.e2e.test.ts`
- `apps/carneloot-bot/test/e2e/RestartRecovery.e2e.test.ts`

Where the surrounding effect already has `PgClient`, retain its existing `Layer.succeed(PgClient.PgClient, sql)` value as `pg`. Do not merge the PostgreSQL layer into the built graph a second time.

- [ ] **Step 2: Simplify Node smoke test**

`NodeSmoke.test.ts` currently tests alternate `Layers.core` topology already covered by TFX runtime tests and final `AppLive.integration.test.ts`. Remove its fake `JobRuntime`, `NotificationRepository`, `UpdateDeduplicator`, and runtime dispatch graph.

Keep one Node-side test that verifies:

```ts
it('exports complete router metadata and production polling options', () => {
	expect(Router.accountHandlers.entries).toHaveLength(1);
	expect(Router.petHandlers.entries).toHaveLength(2);
	expect(Router.petFoodHandlers.entries).toHaveLength(4);
	expect(Router.conversations).toHaveLength(4);
	const polling = Production.pollingOptions(testConfig);
	expect(polling.commands).toEqual([
		{ command: 'cadastrar', description: 'Cadastrar ou atualizar seu perfil' },
		{ command: 'adicionar_pet', description: 'Adicionar um pet' },
		{ command: 'listar_pets', description: 'Listar seus pets' },
		{
			command: 'configurar_inicio_dia',
			description: 'Configurar início do dia do pet',
		},
		{
			command: 'configurar_atraso_notificacao',
			description: 'Configurar atraso das notificações',
		},
		{ command: 'status_racao', description: 'Consultar o status de ração' },
		{ command: 'colocar_racao', description: 'Registrar ração para um pet' },
	]);
	expect(polling.languageCode).toBe('pt');
	expect(polling.allowedUpdates).toContain('callback_query');
	expect(polling.allowedUpdates).toContain('message_reaction');
});
```

- [ ] **Step 3: Replace package exports**

In `apps/carneloot-bot/src/main.ts`, remove:

```ts
export * as Layers from './Layers.js';
```

Add:

```ts
export * as AppLive from './AppLive.js';
export * as PersistenceLive from './PersistenceLive.js';
export * as DomainLive from './DomainLive.js';
export * as RuntimeLive from './RuntimeLive.js';
```

- [ ] **Step 4: Delete obsolete composition module**

Delete:

```text
apps/carneloot-bot/src/Layers.ts
```

No compatibility export or deprecated facade should remain.

- [ ] **Step 5: Verify no old API references remain**

Run:

```bash
rg -n "Layers\.(core|portable)|from './Layers|from '../src/Layers|from '../../src/Layers" \
  apps packages
```

Expected: no matches.

- [ ] **Step 6: Run affected tests**

Run:

```bash
pnpm vitest run apps/carneloot-bot/test/NodeSmoke.test.ts
RUN_TESTCONTAINERS=true pnpm vitest run --config vitest.integration.config.ts \
  apps/carneloot-bot/test/AppLive.integration.test.ts \
  apps/carneloot-bot/test/e2e/OwnedPetFoodLoop.e2e.test.ts \
  apps/carneloot-bot/test/e2e/RestartRecovery.e2e.test.ts
pnpm --filter carneloot-bot demo:test
```

Expected: all commands PASS.

- [ ] **Step 7: Commit consumer migration**

```bash
git add apps/carneloot-bot
git commit -m "refactor(carneloot): replace portable layer graph"
```

---

### Task 7: Combined Verification

**Files:**
- Inspect all files changed by both implementation plans

- [ ] **Step 1: Verify final migration ownership**

Run:

```bash
rg -n "\bmigrate\b" apps/carneloot-bot/src packages/postgres/src
```

Expected migration ownership only in:

```text
apps/carneloot-bot/src/postgres/AppMigrator.ts
apps/carneloot-bot/src/postgres/RepositoriesLive.ts
packages/postgres/src/Migrations.ts
packages/postgres/src/TfxPostgres.ts
```

- [ ] **Step 2: Verify final layer ownership**

Run:

```bash
rg -n "Layers\.(core|portable)|provideMerge\(runtimes|skipMigration|source_started" \
  apps packages
```

Expected: no matches.

- [ ] **Step 3: Verify final composition exports**

Run:

```bash
rg -n "export \* as (AppLive|PersistenceLive|DomainLive|RuntimeLive)" \
  apps/carneloot-bot/src/main.ts
```

Expected: four exports.

- [ ] **Step 4: Format, lint, typecheck, and build**

Run:

```bash
pnpm format:fix
pnpm format
pnpm lint
pnpm check
pnpm build
```

Expected: all commands PASS.

- [ ] **Step 5: Run unit suite**

Run:

```bash
pnpm test:unit
```

Expected: PASS.

- [ ] **Step 6: Run complete integration suite**

Run:

```bash
RUN_TESTCONTAINERS=true pnpm test:integration
```

Expected: PASS, including:

- shared migrator bootstrap/concurrency/rollback
- strict TFX and Carneloot ledgers
- persistence-stage acquisition
- AppLive narrow runtime acquisition
- one migration lifecycle pair per suite
- owned-pet and restart-recovery E2E behavior

- [ ] **Step 7: Inspect final diff and commit formatter changes if required**

Run:

```bash
git diff --check
git status --short
```

If formatter changed tracked files after earlier commits:

```bash
git add .
git commit -m "style: format application layer composition"
```

Do not amend prior commits.

## Acceptance Criteria

- `Layers.ts`, `Layers.core`, and `Layers.portable` are deleted without compatibility wrappers.
- `PersistenceLive` composes both aggregate migration owners over one externally supplied `PgClient`.
- `DomainLive` exposes conversations, middleware, jobs, and scheduler without platform construction.
- `RuntimeLive` exposes exactly `BotRuntime | JobWorker | UpdateDeduplicator`.
- `AppLive.layer(deliveryFactory)` requires exactly `AppConfig | PgClient | Telegram`.
- `Production.appLayer` has no remaining requirements and the same exact narrow output.
- Configuration loads once through memoized `AppConfigLive.layer`.
- Platform-specific Bun infrastructure remains in `Production.ts`.
- Test and demo consumers use `AppLive` or focused stage layers.
- Carneloot and TFX migrations each run once per full application-layer build.
- All formatting, lint, typecheck, build, unit, integration, E2E, and demo checks pass.

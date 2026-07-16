# Shared PostgreSQL Migrator And Layer Lifecycle Implementation Plan

**Goal:** Build one strict PostgreSQL migrator package used by `@tfx/postgres` and Carneloot, make migration ownership explicit at composition boundaries, eliminate duplicate Carneloot startup migrations, and add regression coverage for full layer acquisition.

**Architecture:** Add `@tfx/postgres-migrator`, a PostgreSQL-specific package that owns manifest validation, exact-prefix ledger validation, checksum enforcement, advisory-lock bootstrap, transactional execution, and structured lifecycle logs. TFX and Carneloot keep only their migration manifests and boundary-specific error mapping; aggregate persistence layers sequence migration before constructing pure repository/store layers. Keep Effect's unstable migrator out of runtime wiring because it does not provide checksum validation, exact-prefix validation, or bootstrap-safe locking required here.

**Tech Stack:** TypeScript 7, Effect 4.0.0-beta.98, `@effect/sql-pg` 4.0.0-beta.98, PostgreSQL 17, Vitest 4, pnpm workspaces, Testcontainers.

---

## Scope And Decisions

Included:

- New reusable `@tfx/postgres-migrator` workspace package.
- One migration implementation for TFX and Carneloot.
- Strict source-manifest and applied-ledger validation for both consumers.
- Transaction advisory lock before schema and ledger DDL.
- Existing checksum guarantees and Carneloot operational log names.
- TFX migration operational logs under `tfx.postgres.*`.
- Removal of migration side effects from individual repositories and stores.
- One explicit migration owner per aggregate persistence graph.
- Removal of duplicate Carneloot migration execution.
- Full portable-layer regression test asserting one Carneloot and one TFX migration acquisition.
- Rename misleading `tfx.bot.source_started` event to `tfx.bot.source_forked`.

Not included:

- Compatibility adapters for old APIs or ledgers.
- Preservation of local development database contents.
- Adoption or wrapping of `effect/unstable/sql/Migrator`.
- Schema dump support through `pg_dump`.
- Changes to intentional `Program.run` fail-fast lifecycle behavior.
- Changes to Effect layer memoization or broad application-layer retention; current behavior is correct.

## Target File Structure

```text
packages/postgres-migrator/
├── package.json                         # workspace/public package metadata
├── README.md                            # contract and Effect Migrator decision
├── tsconfig.json                        # composite package build
├── src/
│   ├── index.ts                         # package namespace exports
│   ├── Migration.ts                     # migration manifest model
│   ├── MigrationError.ts                # shared typed failure model
│   ├── PostgresMigrator.ts              # advisory-lock transactional runner
│   └── internal/
│       └── MigrationLedger.ts            # manifest and exact-prefix validators
└── test/
    ├── MigrationLedger.test.ts           # pure validation tests
    ├── PostgresMigrator.integration.test.ts
    └── internal/
        └── PostgresTestLayer.ts          # disposable PostgreSQL layer
```

Consumer ownership after implementation:

```text
Production.appLayer
└─ Layers.portable
   ├─ TfxPostgres.layer
   │  ├─ Migrations.migrate              # once, shared runner
   │  └─ pure TFX store layers
   └─ RepositoriesLive.layer
      ├─ AppMigrator.migrate             # once, shared runner
      └─ pure Carneloot repository layers
```

## Shared Package Contract

`PostgresMigrator.run` accepts:

```ts
export interface Options {
	readonly schema: string;
	readonly table: string;
	readonly lockKey: string;
	readonly logPrefix: string;
	readonly migrations: ReadonlyArray<Migration>;
}
```

Required guarantees:

1. Validate source manifest before touching PostgreSQL.
2. Require source versions to be exactly `1..n` with nonempty names and lowercase 64-character SHA-256 checksums.
3. Begin one PostgreSQL transaction.
4. Acquire `pg_advisory_xact_lock(hashtextextended(lockKey, 0))` before any DDL.
5. Create schema and ledger in that transaction.
6. Read all applied rows ordered by version.
7. Require applied rows to be an exact prefix of source manifest.
8. Apply each pending migration and insert its ledger row in the same transaction.
9. Roll back schema, migration work, and ledger writes together on failure.
10. Emit one `*.migrations.started`, one `*.migration.applied` per applied migration, one `*.migrations.completed`, or one `*.migrations.failed` event.

---

### Task 1: Scaffold Shared Package And Workspace Wiring

**Files:**
- Create: `packages/postgres-migrator/package.json`
- Create: `packages/postgres-migrator/README.md`
- Create: `packages/postgres-migrator/tsconfig.json`
- Create: `packages/postgres-migrator/src/index.ts`
- Modify: `tsconfig.json`
- Modify: `tsconfig.packages.json`
- Modify: `packages/postgres/package.json`
- Modify: `packages/postgres/tsconfig.json`
- Modify: `apps/carneloot-bot/package.json`
- Modify: `apps/carneloot-bot/tsconfig.json`
- Regenerate: `pnpm-lock.yaml`

- [ ] **Step 1: Create package metadata**

Create `packages/postgres-migrator/package.json`:

```json
{
	"name": "@tfx/postgres-migrator",
	"version": "0.0.0",
	"license": "MIT",
	"files": [
		"dist"
	],
	"type": "module",
	"sideEffects": [],
	"exports": {
		".": "./src/index.ts",
		"./Migration": "./src/Migration.ts",
		"./MigrationError": "./src/MigrationError.ts",
		"./PostgresMigrator": "./src/PostgresMigrator.ts"
	},
	"publishConfig": {
		"exports": {
			".": "./dist/index.js",
			"./Migration": "./dist/Migration.js",
			"./MigrationError": "./dist/MigrationError.js",
			"./PostgresMigrator": "./dist/PostgresMigrator.js"
		},
		"access": "public"
	},
	"peerDependencies": {
		"@effect/sql-pg": "4.0.0-beta.98",
		"effect": "4.0.0-beta.98"
	},
	"engines": {
		"bun": "1.3.14",
		"node": ">=24 <25"
	}
}
```

- [ ] **Step 2: Create package TypeScript configuration**

Create `packages/postgres-migrator/tsconfig.json`:

```json
{
	"extends": "../../tsconfig.base.json",
	"compilerOptions": {
		"rootDir": "src",
		"outDir": "dist",
		"tsBuildInfoFile": "dist/.tsbuildinfo"
	},
	"include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create package root export surface**

Create `packages/postgres-migrator/src/index.ts`:

```ts
export const packageName = '@tfx/postgres-migrator' as const;
export * as Migration from './Migration.js';
export * as MigrationError from './MigrationError.js';
export * as PostgresMigrator from './PostgresMigrator.js';
```

- [ ] **Step 4: Document why the package does not use Effect's migrator**

Create `packages/postgres-migrator/README.md`:

```markdown
# @tfx/postgres-migrator

Strict PostgreSQL migration runner shared by TFX and Carneloot.

## Guarantees

- SHA-256 identity for every migration.
- Applied ledger must be an exact contiguous prefix of source migrations.
- Unknown future rows, gaps, reordered rows, renamed migrations, and checksum drift fail startup.
- Transaction-scoped PostgreSQL advisory lock is acquired before schema or ledger creation.
- Schema bootstrap, migrations, and ledger inserts commit or roll back together.
- Structured startup, application, completion, and failure logs.

## Why not effect/unstable/sql/Migrator?

The Effect 4.0.0-beta.98 migrator records only migration ID, name, and timestamp; skips everything at or below the highest applied ID; creates its PostgreSQL ledger before entering the migration transaction; and exposes an unstable API. Those semantics do not provide checksum validation, exact-prefix validation, or serialized first-time bootstrap required by this workspace.
```

- [ ] **Step 5: Add project references**

Add `packages/postgres-migrator` before `packages/postgres` in both root reference files.

`tsconfig.json` references:

```json
"references": [
	{ "path": "./packages/tfx" },
	{ "path": "./packages/postgres-migrator" },
	{ "path": "./packages/postgres" },
	{ "path": "./apps/carneloot-bot" }
]
```

`tsconfig.packages.json` references:

```json
"references": [
	{ "path": "packages/tfx" },
	{ "path": "packages/postgres-migrator" },
	{ "path": "packages/postgres" },
	{ "path": "apps/carneloot-bot" }
]
```

Add references in consumer configs:

```json
// packages/postgres/tsconfig.json
"references": [
	{ "path": "../tfx" },
	{ "path": "../postgres-migrator" }
]
```

```json
// apps/carneloot-bot/tsconfig.json
"references": [
	{ "path": "../../packages/tfx" },
	{ "path": "../../packages/postgres-migrator" },
	{ "path": "../../packages/postgres" }
]
```

- [ ] **Step 6: Add workspace runtime dependencies**

Add to `packages/postgres/package.json` dependencies:

```json
"dependencies": {
	"@tfx/postgres-migrator": "workspace:^",
	"tfx": "workspace:^"
}
```

Add to `apps/carneloot-bot/package.json` dependencies:

```json
"@tfx/postgres-migrator": "workspace:^"
```

Keep existing direct `effect` and `@effect/sql-pg` dependencies because both consumers import them directly.

- [ ] **Step 7: Regenerate lockfile and verify workspace resolution**

Run:

```bash
pnpm install
pnpm --filter @tfx/postgres-migrator exec node -e "console.log('workspace resolved')"
```

Expected: install succeeds and command prints `workspace resolved`.

- [ ] **Step 8: Commit scaffold**

```bash
git add pnpm-lock.yaml tsconfig.json tsconfig.packages.json \
  packages/postgres-migrator packages/postgres/package.json packages/postgres/tsconfig.json \
  apps/carneloot-bot/package.json apps/carneloot-bot/tsconfig.json
git commit -m "chore: scaffold shared postgres migrator package"
```

---

### Task 2: Implement Shared Manifest And Ledger Validation

**Files:**
- Create: `packages/postgres-migrator/src/Migration.ts`
- Create: `packages/postgres-migrator/src/MigrationError.ts`
- Create: `packages/postgres-migrator/src/internal/MigrationLedger.ts`
- Create: `packages/postgres-migrator/test/MigrationLedger.test.ts`

- [ ] **Step 1: Write failing validation tests**

Create `packages/postgres-migrator/test/MigrationLedger.test.ts`:

```ts
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import type { Migration } from '../src/Migration.js';
import {
	validateAppliedMigrations,
	validateManifest,
} from '../src/internal/MigrationLedger.js';

const checksum = (character: string) => character.repeat(64);
const migration = (
	version: number,
	name: string,
	digest: string,
): Migration => ({
	version,
	name,
	checksum: digest,
	up: () => Effect.void,
});
const known = [
	migration(1, 'one', checksum('a')),
	migration(2, 'two', checksum('b')),
] as const;
const result = <A, E>(effect: Effect.Effect<A, E>) =>
	Effect.runPromise(Effect.result(effect));

describe('migration manifest validation', () => {
	it('accepts a contiguous manifest with SHA-256 identities', async () => {
		expect(await result(validateManifest(known))).toMatchObject({
			_tag: 'Success',
		});
	});

	it.each([
		[migration(2, 'one', checksum('a'))],
		[known[0], migration(3, 'three', checksum('c'))],
		[migration(1, '', checksum('a'))],
		[migration(1, 'one', 'not-a-sha256')],
	] as const)('rejects malformed source manifests', async (...manifest) => {
		expect(await result(validateManifest(manifest))).toMatchObject({
			_tag: 'Failure',
			failure: {
				_tag: 'MigrationError',
				stage: 'manifest_validation',
			},
		});
	});
});

describe('applied migration validation', () => {
	it.each([
		{ applied: [] },
		{
			applied: [{ version: 1, name: 'one', checksum: checksum('a') }],
		},
		{
			applied: [
				{ version: 1, name: 'one', checksum: checksum('a') },
				{ version: 2, name: 'two', checksum: checksum('b') },
			],
		},
	] as const)('accepts an exact source prefix', async ({ applied }) => {
		expect(
			await result(validateAppliedMigrations(known, applied)),
		).toMatchObject({ _tag: 'Success' });
	});

	it.each([
		{
			applied: [{ version: 2, name: 'two', checksum: checksum('b') }],
		},
		{
			applied: [
				{ version: 1, name: 'one', checksum: checksum('a') },
				{ version: 3, name: 'future', checksum: checksum('c') },
			],
		},
		{
			applied: [
				{ version: 1, name: 'renamed', checksum: checksum('a') },
			],
		},
		{
			applied: [
				{ version: 1, name: 'one', checksum: checksum('f') },
			],
		},
	] as const)('rejects gaps, futures, names, and checksum drift', async ({ applied }) => {
		expect(
			await result(validateAppliedMigrations(known, applied)),
		).toMatchObject({
			_tag: 'Failure',
			failure: {
				_tag: 'MigrationError',
				stage: 'ledger_validation',
			},
		});
	});
});
```

- [ ] **Step 2: Run tests and verify missing-module failure**

Run:

```bash
pnpm vitest run packages/postgres-migrator/test/MigrationLedger.test.ts
```

Expected: FAIL because `Migration.ts`, `MigrationError.ts`, and `internal/MigrationLedger.ts` do not exist.

- [ ] **Step 3: Define migration model**

Create `packages/postgres-migrator/src/Migration.ts`:

```ts
import type * as PgClient from '@effect/sql-pg/PgClient';
import type * as Effect from 'effect/Effect';

export interface Migration {
	readonly version: number;
	readonly name: string;
	readonly checksum: string;
	readonly up: (
		sql: PgClient.PgClient,
	) => Effect.Effect<unknown, unknown>;
}

export interface AppliedMigration {
	readonly version: number;
	readonly name: string;
	readonly checksum: string;
}

export interface Options {
	readonly schema: string;
	readonly table: string;
	readonly lockKey: string;
	readonly logPrefix: string;
	readonly migrations: ReadonlyArray<Migration>;
}

export interface Result {
	readonly total: number;
	readonly applied: number;
	readonly appliedNow: number;
}
```

- [ ] **Step 4: Define shared typed error**

Create `packages/postgres-migrator/src/MigrationError.ts`:

```ts
import * as Data from 'effect/Data';

export type MigrationStage =
	| 'manifest_validation'
	| 'bootstrap'
	| 'ledger_validation'
	| 'apply'
	| 'transaction';

export class MigrationError extends Data.TaggedError('MigrationError')<{
	readonly stage: MigrationStage;
	readonly message: string;
	readonly cause?: unknown;
	readonly version?: number;
	readonly migrationName?: string;
}> {}
```

- [ ] **Step 5: Implement strict validators**

Create `packages/postgres-migrator/src/internal/MigrationLedger.ts`:

```ts
import * as Effect from 'effect/Effect';

import type {
	AppliedMigration,
	Migration,
} from '../Migration.js';
import { MigrationError } from '../MigrationError.js';

const invalid = (
	stage: 'manifest_validation' | 'ledger_validation',
	message: string,
) => new MigrationError({ stage, message });

export const validateManifest = (
	migrations: ReadonlyArray<Migration>,
): Effect.Effect<void, MigrationError> => {
	for (const [index, migration] of migrations.entries()) {
		const expectedVersion = index + 1;
		if (migration.version !== expectedVersion)
			return Effect.fail(
				invalid(
					'manifest_validation',
					`expected version ${expectedVersion} at position ${index}, received ${migration.version}`,
				),
			);
		if (migration.name.trim().length === 0)
			return Effect.fail(
				invalid('manifest_validation', `migration ${migration.version} has an empty name`),
			);
		if (!/^[0-9a-f]{64}$/u.test(migration.checksum))
			return Effect.fail(
				invalid(
					'manifest_validation',
					`migration ${migration.version} has an invalid SHA-256 checksum`,
				),
			);
	}
	return Effect.void;
};

export const validateAppliedMigrations = (
	migrations: ReadonlyArray<Migration>,
	applied: ReadonlyArray<AppliedMigration>,
): Effect.Effect<void, MigrationError> => {
	if (applied.length > migrations.length)
		return Effect.fail(
			invalid('ledger_validation', 'unknown future migration version'),
		);
	for (const [index, actual] of applied.entries()) {
		const expected = migrations[index];
		if (expected === undefined)
			return Effect.fail(
				invalid('ledger_validation', 'unknown future migration version'),
			);
		if (actual.version !== expected.version)
			return Effect.fail(
				invalid(
					'ledger_validation',
					`expected version ${expected.version} at position ${index}, received ${actual.version}`,
				),
			);
		if (
			actual.name !== expected.name ||
			actual.checksum !== expected.checksum
		)
			return Effect.fail(
				invalid(
					'ledger_validation',
					`migration ${expected.version} identity/checksum mismatch`,
				),
			);
	}
	return Effect.void;
};
```

- [ ] **Step 6: Run unit test**

Run:

```bash
pnpm vitest run packages/postgres-migrator/test/MigrationLedger.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit validation model**

```bash
git add packages/postgres-migrator/src packages/postgres-migrator/test/MigrationLedger.test.ts
git commit -m "feat(migrator): validate manifests and ledgers"
```

---

### Task 3: Implement Transactional PostgreSQL Runner

**Files:**
- Create: `packages/postgres-migrator/src/PostgresMigrator.ts`
- Create: `packages/postgres-migrator/test/internal/PostgresTestLayer.ts`
- Create: `packages/postgres-migrator/test/PostgresMigrator.integration.test.ts`

- [ ] **Step 1: Create disposable PostgreSQL test layer**

Create `packages/postgres-migrator/test/internal/PostgresTestLayer.ts`:

```ts
import * as PgClient from '@effect/sql-pg/PgClient';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';

const container = Layer.unwrap(
	Effect.map(
		Effect.acquireRelease(
			Effect.promise(() =>
				new PostgreSqlContainer('postgres:17-alpine').start(),
			),
			(value) => Effect.promise(() => value.stop()).pipe(Effect.asVoid),
		),
		(value) => PgClient.layer({ url: Redacted.make(value.getConnectionUri()) }),
	),
);

export const layer =
	process.env.TEST_DATABASE_URL === undefined
		? container
		: PgClient.layer({
				url: Redacted.make(process.env.TEST_DATABASE_URL),
			});
```

- [ ] **Step 2: Write runner integration tests**

Create `packages/postgres-migrator/test/PostgresMigrator.integration.test.ts`:

```ts
import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import type { Migration } from '../src/Migration.js';
import { run } from '../src/PostgresMigrator.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const checksum = (character: string) => character.repeat(64);
const options = (
	suffix: string,
	migrations: ReadonlyArray<Migration>,
) => ({
	schema: `migrator_${suffix}`,
	table: 'migrations',
	lockKey: `migrator:${suffix}`,
	logPrefix: `test.${suffix}`,
	migrations,
});

describe.skipIf(!enabled)('shared PostgreSQL migrator', () => {
	it('serializes concurrent bootstrap and applies each migration once', async () => {
		const suffix = crypto.randomUUID().replaceAll('-', '');
		const migrations: ReadonlyArray<Migration> = [
			{
				version: 1,
				name: 'one',
				checksum: checksum('a'),
				up: (sql) =>
					sql`CREATE TABLE ${sql(`migrator_${suffix}`)}.${sql('items')} (id integer PRIMARY KEY)`,
			},
		];
		const program = Effect.gen(function* () {
			yield* Effect.all(
				[run(options(suffix, migrations)), run(options(suffix, migrations))],
				{ concurrency: 'unbounded' },
			);
			const sql = yield* PgClient.PgClient;
			return yield* sql<{ count: string }>`SELECT count(*)::text AS count FROM ${sql(`migrator_${suffix}`)}.${sql('migrations')}`;
		});
		const rows = await Effect.runPromise(
			Effect.provide(program, PostgresTestLayer.layer),
		);
		expect(rows[0]?.count).toBe('1');
	});

	it('rejects unknown future ledger rows and checksum drift', async () => {
		const suffix = crypto.randomUUID().replaceAll('-', '');
		const migrations: ReadonlyArray<Migration> = [
			{
				version: 1,
				name: 'one',
				checksum: checksum('a'),
				up: () => Effect.void,
			},
		];
		const program = Effect.gen(function* () {
			yield* run(options(suffix, migrations));
			const sql = yield* PgClient.PgClient;
			const schema = sql(`migrator_${suffix}`);
			const table = sql('migrations');
			yield* sql`INSERT INTO ${schema}.${table} (version,name,checksum) VALUES (99,'future',${checksum('f')})`;
			const future = yield* Effect.result(run(options(suffix, migrations)));
			yield* sql`DELETE FROM ${schema}.${table} WHERE version=99`;
			yield* sql`UPDATE ${schema}.${table} SET checksum=${checksum('b')} WHERE version=1`;
			const drift = yield* Effect.result(run(options(suffix, migrations)));
			return { future, drift };
		});
		const result = await Effect.runPromise(
			Effect.provide(program, PostgresTestLayer.layer),
		);
		for (const failure of [result.future, result.drift])
			expect(failure).toMatchObject({
				_tag: 'Failure',
				failure: {
					_tag: 'MigrationError',
					stage: 'ledger_validation',
				},
			});
	});

	it('rolls back failed migration work and its ledger row', async () => {
		const suffix = crypto.randomUUID().replaceAll('-', '');
		const first: Migration = {
			version: 1,
			name: 'one',
			checksum: checksum('a'),
			up: () => Effect.void,
		};
		const second: Migration = {
			version: 2,
			name: 'two',
			checksum: checksum('b'),
			up: (sql) =>
				Effect.andThen(
					sql`CREATE TABLE ${sql(`migrator_${suffix}`)}.${sql('rolled_back')} (id integer)`,
					Effect.fail('expected failure'),
				),
		};
		const program = Effect.gen(function* () {
			yield* run(options(suffix, [first]));
			const failed = yield* Effect.result(
				run(options(suffix, [first, second])),
			);
			const sql = yield* PgClient.PgClient;
			const ledger = yield* sql<{ count: string }>`SELECT count(*)::text AS count FROM ${sql(`migrator_${suffix}`)}.${sql('migrations')}`;
			const table = yield* sql<{ value: string | null }>`SELECT to_regclass(${`migrator_${suffix}.rolled_back`})::text AS value`;
			return { failed, ledger, table };
		});
		const result = await Effect.runPromise(
			Effect.provide(program, PostgresTestLayer.layer),
		);
		expect(result.failed).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'MigrationError', stage: 'apply', version: 2 },
		});
		expect(result.ledger[0]?.count).toBe('1');
		expect(result.table[0]?.value).toBeNull();
	});
});
```

- [ ] **Step 3: Run integration test and verify missing runner failure**

Run:

```bash
RUN_TESTCONTAINERS=true pnpm vitest run --config vitest.integration.config.ts \
  packages/postgres-migrator/test/PostgresMigrator.integration.test.ts
```

Expected: FAIL because `PostgresMigrator.ts` does not exist.

- [ ] **Step 4: Implement runner**

Create `packages/postgres-migrator/src/PostgresMigrator.ts`:

```ts
import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';

import type { Options, Result } from './Migration.js';
import {
	MigrationError,
	type MigrationStage,
} from './MigrationError.js';
import {
	validateAppliedMigrations,
	validateManifest,
} from './internal/MigrationLedger.js';

const failure = (
	stage: MigrationStage,
	message: string,
	cause?: unknown,
	migration?: { readonly version: number; readonly name: string },
) =>
	new MigrationError({
		stage,
		message,
		...(cause === undefined ? {} : { cause }),
		...(migration === undefined
			? {}
			: {
					version: migration.version,
					migrationName: migration.name,
				}),
	});

const protect = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	stage: MigrationStage,
	message: string,
	migration?: { readonly version: number; readonly name: string },
): Effect.Effect<A, MigrationError, R> =>
	effect.pipe(
		Effect.mapError((cause) =>
			cause instanceof MigrationError
				? cause
				: failure(stage, message, cause, migration),
		),
	);

export const run = (
	options: Options,
): Effect.Effect<Result, MigrationError, PgClient.PgClient> =>
	Effect.gen(function* () {
		yield* validateManifest(options.migrations);
		const sql = yield* PgClient.PgClient;
		const schema = sql(options.schema);
		const table = sql(options.table);
		return yield* protect(
			sql.withTransaction(
				Effect.gen(function* () {
					yield* protect(
						sql`SELECT pg_advisory_xact_lock(hashtextextended(${options.lockKey}, 0))`,
						'bootstrap',
						'Failed to acquire migration lock',
					);
					yield* protect(
						sql`CREATE SCHEMA IF NOT EXISTS ${schema}`,
						'bootstrap',
						'Failed to create migration schema',
					);
					yield* protect(
						sql`CREATE TABLE IF NOT EXISTS ${schema}.${table} (
							version integer PRIMARY KEY,
							name text NOT NULL,
							checksum text NOT NULL,
							applied_at timestamptz NOT NULL DEFAULT now()
						)`,
						'bootstrap',
						'Failed to create migration ledger',
					);
					const applied = yield* protect(
						sql<{
							version: number;
							name: string;
							checksum: string;
						}>`SELECT version,name,checksum FROM ${schema}.${table} ORDER BY version`,
						'bootstrap',
						'Failed to read migration ledger',
					);
					yield* Effect.logInfo(`${options.logPrefix}.migrations.started`).pipe(
						Effect.annotateLogs({
							applied: applied.length,
							pending: Math.max(0, options.migrations.length - applied.length),
						}),
					);
					yield* validateAppliedMigrations(options.migrations, applied);
					for (const migration of options.migrations.slice(applied.length)) {
						yield* protect(
							migration.up(sql),
							'apply',
							`Migration ${migration.version}_${migration.name} failed`,
							migration,
						);
						yield* protect(
							sql`INSERT INTO ${schema}.${table} (version,name,checksum) VALUES (${migration.version},${migration.name},${migration.checksum})`,
							'apply',
							`Failed to record migration ${migration.version}_${migration.name}`,
							migration,
						);
						yield* Effect.logInfo(`${options.logPrefix}.migration.applied`).pipe(
							Effect.annotateLogs({
								version: migration.version,
								name: migration.name,
							}),
						);
					}
					const result = {
						total: options.migrations.length,
						applied: applied.length,
						appliedNow: options.migrations.length - applied.length,
					} satisfies Result;
					yield* Effect.logInfo(`${options.logPrefix}.migrations.completed`).pipe(
						Effect.annotateLogs({
							total: result.total,
							appliedNow: result.appliedNow,
						}),
					);
					return result;
				}),
			),
			'transaction',
			'Migration transaction failed',
		);
	}).pipe(
		Effect.tapError((error) =>
			Effect.logError(`${options.logPrefix}.migrations.failed`).pipe(
				Effect.annotateLogs({
					stage: error.stage,
					...(error.version === undefined
						? {}
						: { version: error.version }),
					...(error.migrationName === undefined
						? {}
						: { name: error.migrationName }),
				}),
			),
		),
	);
```

- [ ] **Step 5: Run shared package tests**

Run:

```bash
pnpm vitest run packages/postgres-migrator/test/MigrationLedger.test.ts
RUN_TESTCONTAINERS=true pnpm vitest run --config vitest.integration.config.ts \
  packages/postgres-migrator/test/PostgresMigrator.integration.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit runner**

```bash
git add packages/postgres-migrator
git commit -m "feat(migrator): run strict postgres migrations"
```

---

### Task 4: Move TFX Migrations To Shared Runner

**Files:**
- Create: `packages/postgres/src/Migrations.ts`
- Modify: `packages/postgres/src/index.ts`
- Modify: `packages/postgres/package.json`
- Modify: `packages/postgres/src/TfxPostgres.ts`
- Modify: `packages/postgres/src/PostgresConversationStorage.ts`
- Modify: `packages/postgres/src/PostgresJobStore.ts`
- Modify: `packages/postgres/src/PostgresUpdateDeduplicator.ts`
- Modify: `packages/postgres/test/Migrations.integration.test.ts`
- Modify: `packages/postgres/test/ConversationStorage.integration.test.ts`
- Modify: `packages/postgres/test/JobStore.integration.test.ts`
- Modify: `packages/postgres/test/Deduplicator.integration.test.ts`
- Modify: `apps/carneloot-bot/test/ConversationDurability.integration.test.ts`
- Delete: `packages/postgres/src/internal/Migrator.ts`
- Delete: `packages/postgres/test/Migrator.test.ts`
- Delete: `packages/postgres/migrations/0001_tfx_core.ts`

- [ ] **Step 1: Strengthen TFX integration expectation before replacing runner**

Extend `packages/postgres/test/Migrations.integration.test.ts` with a test that inserts version `99` and removes version `1`, then asserts both calls fail with shared strict-ledger semantics:

```ts
it('rejects unknown future versions and missing applied prefixes', async () => {
	const options = { schema: 'tfx_ledger_test', tablePrefix: 'case_' };
	const program = Effect.gen(function* () {
		yield* migrate(options);
		const sql = yield* PgClient.PgClient;
		yield* sql`INSERT INTO tfx_ledger_test.case_migrations (version,name,checksum) VALUES (99,'future',${'f'.repeat(64)})`;
		const future = yield* Effect.result(migrate(options));
		yield* sql`DELETE FROM tfx_ledger_test.case_migrations WHERE version=99`;
		yield* sql`DELETE FROM tfx_ledger_test.case_migrations WHERE version=1`;
		const gap = yield* Effect.result(migrate(options));
		return { future, gap };
	});
	const result = await Effect.runPromise(
		Effect.provide(program, PostgresTestLayer.layer),
	);
	for (const failure of [result.future, result.gap])
		expect(failure).toMatchObject({
			_tag: 'Failure',
			failure: {
				_tag: 'MigrationError',
				stage: 'ledger_validation',
			},
		});
});
```

- [ ] **Step 2: Run new TFX test and verify current behavior fails expectation**

Run:

```bash
RUN_TESTCONTAINERS=true pnpm vitest run --config vitest.integration.config.ts \
  packages/postgres/test/Migrations.integration.test.ts
```

Expected: FAIL because current TFX migrator accepts future rows and repairs gaps.

- [ ] **Step 3: Create TFX migration manifest adapter**

Create `packages/postgres/src/Migrations.ts`:

```ts
import type { Migration } from '@tfx/postgres-migrator/Migration';
import * as PostgresMigrator from '@tfx/postgres-migrator/PostgresMigrator';
import * as Effect from 'effect/Effect';

import type { Options } from './Options.js';
import { up as up0001 } from './internal/Migration0001.js';
import { up as up0002 } from './internal/Migration0002.js';
import { up as up0003 } from './internal/Migration0003.js';
import { migrationChecksums } from './internal/MigrationChecksums.js';
import { make } from './internal/Tables.js';

export const migrate = (options: Options = {}) => {
	const tables = make(options);
	const migrations: ReadonlyArray<Migration> = Object.freeze([
		{
			version: 1,
			name: 'tfx-core',
			checksum: migrationChecksums[1],
			up: (sql) => up0001(sql, tables).pipe(Effect.asVoid),
		},
		{
			version: 2,
			name: 'dedup-outcome-invariant',
			checksum: migrationChecksums[2],
			up: (sql) => up0002(sql, tables).pipe(Effect.asVoid),
		},
		{
			version: 3,
			name: 'job-state-invariant',
			checksum: migrationChecksums[3],
			up: (sql) => up0003(sql, tables).pipe(Effect.asVoid),
		},
	]);
	return PostgresMigrator.run({
		schema: tables.schema,
		table: tables.migrations,
		lockKey: `${tables.schema}:${tables.migrations}`,
		logPrefix: 'tfx.postgres',
		migrations,
	});
};
```

- [ ] **Step 4: Export TFX migration module**

Add package exports:

```json
// packages/postgres/package.json source exports
"./Migrations": "./src/Migrations.ts"
```

```json
// packages/postgres/package.json publishConfig.exports
"./Migrations": "./dist/Migrations.js"
```

Add to `packages/postgres/src/index.ts`:

```ts
export * as Migrations from './Migrations.js';
```

- [ ] **Step 5: Make individual TFX store layers pure**

In these files, remove `migrate` imports, remove `skipMigration`, and begin construction directly from `PgClient.PgClient`:

- `packages/postgres/src/PostgresConversationStorage.ts`
- `packages/postgres/src/PostgresJobStore.ts`
- `packages/postgres/src/PostgresUpdateDeduplicator.ts`

Apply these exact wrapper edits in each file while leaving statements inside the existing `(sql) => { ... }` callback byte-for-byte unchanged:

1. Change `export const layer = (options: Options = {}, skipMigration = false)` to `export const layer = (options: Options = {})`.
2. Delete the file's `migrate` import.
3. Replace:

```ts
Effect.andThen(
	protect(skipMigration ? Effect.void : migrate(options)),
	Effect.map(PgClient.PgClient, (sql) => {
```

with:

```ts
Effect.map(PgClient.PgClient, (sql) => {
```

4. At the end of the callback, replace the closing sequence for `Effect.andThen` plus `Effect.map`:

```ts
			}),
		),
	);
```

with the single `Effect.map` closing sequence:

```ts
		}),
	);
```

Do not alter service methods, SQL statements, decoding, or boundary error mapping.

- [ ] **Step 6: Keep aggregate TFX layer as sole migration owner**

Update `packages/postgres/src/TfxPostgres.ts` imports and construction:

```ts
import { migrate } from './Migrations.js';
```

```ts
Layer.unwrap(
	Effect.as(
		migrate(options).pipe(
			Effect.mapError(
				(cause) =>
					new JobStoreError(
						'PersistenceFailure',
						'PostgreSQL migration failed',
						safeCause(cause),
					),
			),
		),
		Layer.mergeAll(
			PostgresConversationStorage.layer(options),
			PostgresJobStore.layer(options),
			PostgresUpdateDeduplicator.layer(options),
		),
	),
);
```

- [ ] **Step 7: Update TFX tests to acquire aggregate layer**

For adapter tests, replace direct adapter provisioning with `TfxPostgres.layer(options)` while continuing to request only the service under test. Example for `packages/postgres/test/JobStore.integration.test.ts`:

```ts
import * as TfxPostgres from '../src/TfxPostgres.js';

const adapter = TfxPostgres.layer({
	schema: 'tfx_job_test',
	tablePrefix: 'case_',
});
const layer = Layer.provideMerge(adapter, PostgresTestLayer.layer);
```

Apply equivalent changes to:

- `packages/postgres/test/ConversationStorage.integration.test.ts`
- `packages/postgres/test/Deduplicator.integration.test.ts`
- `apps/carneloot-bot/test/ConversationDurability.integration.test.ts`

In `packages/postgres/test/Migrations.integration.test.ts`:

```ts
import { migrate } from '../src/Migrations.js';
```

Update checksum-drift expectation:

```ts
expect(result.result).toMatchObject({
	_tag: 'Failure',
	failure: {
		_tag: 'MigrationError',
		stage: 'ledger_validation',
	},
});
```

- [ ] **Step 8: Delete replaced migration engine and stale wrapper**

Delete:

```text
packages/postgres/src/internal/Migrator.ts
packages/postgres/test/Migrator.test.ts
packages/postgres/migrations/0001_tfx_core.ts
```

Keep `Migration0001.ts`, `Migration0002.ts`, `Migration0003.ts`, and `MigrationChecksums.ts`; they remain the TFX-owned migration content and identities.

- [ ] **Step 9: Run TFX unit and integration coverage**

Run:

```bash
pnpm test:unit
RUN_TESTCONTAINERS=true pnpm vitest run --config vitest.integration.config.ts \
  packages/postgres/test/Migrations.integration.test.ts \
  packages/postgres/test/ConversationStorage.integration.test.ts \
  packages/postgres/test/JobStore.integration.test.ts \
  packages/postgres/test/Deduplicator.integration.test.ts \
  apps/carneloot-bot/test/ConversationDurability.integration.test.ts
```

Expected: all selected tests PASS. TFX now rejects future rows and gaps.

- [ ] **Step 10: Commit TFX adoption**

```bash
git add packages/postgres apps/carneloot-bot/test/ConversationDurability.integration.test.ts
git commit -m "refactor(postgres): use shared migration runner"
```

---

### Task 5: Move Carneloot Migrations To Shared Runner And Single Owner

**Files:**
- Create: `apps/carneloot-bot/src/postgres/RepositoriesLive.ts`
- Modify: `apps/carneloot-bot/src/postgres/AppMigrator.ts`
- Modify: `apps/carneloot-bot/src/postgres/NotificationRepositoryLive.ts`
- Modify: `apps/carneloot-bot/src/Layers.ts`
- Modify: `apps/carneloot-bot/test/notifications/NotificationRepository.integration.test.ts`
- Modify: `apps/carneloot-bot/test/notifications/FeedingReminderScheduling.integration.test.ts`
- Modify: `apps/carneloot-bot/test/notifications/FeedingReminder.e2e.integration.test.ts`
- Modify: `apps/carneloot-bot/test/pet-food/PetFoodMigration.integration.test.ts`
- Delete: `apps/carneloot-bot/src/postgres/internal/MigrationLedger.ts`
- Delete: `apps/carneloot-bot/test/MigrationLedger.test.ts`

- [ ] **Step 1: Replace AppMigrator with a Carneloot manifest adapter**

Rewrite `apps/carneloot-bot/src/postgres/AppMigrator.ts`:

```ts
import type { Migration } from '@tfx/postgres-migrator/Migration';
import * as PostgresMigrator from '@tfx/postgres-migrator/PostgresMigrator';
import * as Effect from 'effect/Effect';

import { DomainPersistenceError } from '../domain/DomainError.js';
import { migration0001Checksum, migration0001Sql } from './Migration0001Sql.js';
import { migration0002Checksum, migration0002Sql } from './Migration0002Sql.js';
import { migration0003Checksum, migration0003Sql } from './Migration0003Sql.js';
import { migration0004Checksum, migration0004Sql } from './Migration0004Sql.js';
import { migration0005Checksum, migration0005Sql } from './Migration0005Sql.js';

const sqlMigration = (
	version: number,
	name: string,
	checksum: string,
	source: string,
): Migration => ({
	version,
	name,
	checksum,
	up: (sql) => sql.unsafe(source).pipe(Effect.asVoid),
});

const migrations: ReadonlyArray<Migration> = Object.freeze([
	sqlMigration(1, 'identity-pets', migration0001Checksum, migration0001Sql),
	sqlMigration(2, 'pet-food', migration0002Checksum, migration0002Sql),
	sqlMigration(
		3,
		'pet-food-source-constraints',
		migration0003Checksum,
		migration0003Sql,
	),
	sqlMigration(4, 'notifications', migration0004Checksum, migration0004Sql),
	sqlMigration(
		5,
		'unreachable-notification-deliveries',
		migration0005Checksum,
		migration0005Sql,
	),
]);

export const migrate = PostgresMigrator.run({
	schema: 'carneloot',
	table: 'app_migrations',
	lockKey: 'carneloot:app_migrations',
	logPrefix: 'carneloot',
	migrations,
}).pipe(
	Effect.mapError(
		(cause) =>
			new DomainPersistenceError({
				message: 'Carneloot migration failed',
				cause,
			}),
	),
	Effect.asVoid,
);
```

This preserves existing Carneloot event names while deleting duplicate transaction, lock, validation, and failure-log machinery.

- [ ] **Step 2: Create aggregate repository layer with one migration gate**

Create `apps/carneloot-bot/src/postgres/RepositoriesLive.ts`:

```ts
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import { migrate } from './AppMigrator.js';
import * as NotificationRecipientsLive from './NotificationRecipientsLive.js';
import * as NotificationRepositoryLive from './NotificationRepositoryLive.js';
import * as PetFoodRepositoryLive from './PetFoodRepositoryLive.js';
import * as PetRepositoryLive from './PetRepositoryLive.js';
import * as UserRepositoryLive from './UserRepositoryLive.js';

export const layer = Layer.unwrap(
	Effect.as(
		migrate,
		Layer.mergeAll(
			UserRepositoryLive.layer,
			PetRepositoryLive.layer,
			PetFoodRepositoryLive.layer,
			NotificationRepositoryLive.layer,
			NotificationRecipientsLive.layer,
		),
	),
);
```

- [ ] **Step 3: Remove hidden migration from NotificationRepositoryLive**

Remove this import:

```ts
import { migrate } from './AppMigrator.js';
```

Replace the acquisition wrapper:

```ts
Effect.andThen(
	migrate.pipe(
		Effect.mapError((cause) =>
			error('PersistenceFailure', 'Notification migration failed', cause),
		),
	),
	Effect.map(PgClient.PgClient, (sql) => {
```

with:

```ts
Effect.map(PgClient.PgClient, (sql) => {
```

At the end of that callback, remove the extra closing `),` belonging to `Effect.andThen`, exactly as in Task 4 Step 5. Do not change repository methods or SQL statements. The repository becomes a pure adapter and no longer mutates the full application schema when acquired alone.

- [ ] **Step 4: Simplify portable graph to use aggregate repository layer**

In `apps/carneloot-bot/src/Layers.ts`:

- Remove imports for `migrate` and every individual repository live module.
- Import `RepositoriesLive`.
- Replace the existing repository block with:

```ts
const repositories = Layer.provide(
	RepositoriesLive.layer,
	options.pg,
);
```

Keep all named `stores`, `repositories`, `foundation`, `application`, `bot`, and `worker` layer values. Reusing those same values is intentional and lets Effect memoize each acquisition once.

- [ ] **Step 5: Update notification integration graphs**

Use `RepositoriesLive.layer` instead of constructing individual Carneloot repositories in:

- `apps/carneloot-bot/test/notifications/NotificationRepository.integration.test.ts`
- `apps/carneloot-bot/test/notifications/FeedingReminderScheduling.integration.test.ts`
- `apps/carneloot-bot/test/notifications/FeedingReminder.e2e.integration.test.ts`

Notification repository example:

```ts
import * as RepositoriesLive from '../../src/postgres/RepositoriesLive.js';

const layer = Layer.provideMerge(
	RepositoriesLive.layer,
	PostgresTestLayer.layer,
);
```

For feeding tests, replace direct `PostgresJobStore.layer(...)` with the aggregate TFX graph and merge it with the Carneloot repository graph before providing PostgreSQL:

```ts
import * as TfxPostgres from '@tfx/postgres/TfxPostgres';
import * as RepositoriesLive from '../../src/postgres/RepositoriesLive.js';

const stores = Layer.provideMerge(
	Layer.merge(
		RepositoriesLive.layer,
		TfxPostgres.layer({
			schema: 'tfx_feeding_test',
			tablePrefix: 'case_',
		}),
	),
	pg,
);
```

Use `tfx_feeding_e2e` in the E2E file, preserving its existing schema isolation.

- [ ] **Step 6: Remove superseded app validator and update assertions**

Delete:

```text
apps/carneloot-bot/src/postgres/internal/MigrationLedger.ts
apps/carneloot-bot/test/MigrationLedger.test.ts
```

Shared package unit tests now own exact-prefix validation. Keep `PetFoodMigration.integration.test.ts` consumer assertions for `DomainPersistenceError` and exact `carneloot.migrations.failed` annotations. They verify boundary mapping and shared log configuration.

- [ ] **Step 7: Run app migration and notification coverage**

Run:

```bash
pnpm vitest run apps/carneloot-bot/test/MigrationArtifact.test.ts
RUN_TESTCONTAINERS=true pnpm vitest run --config vitest.integration.config.ts \
  apps/carneloot-bot/test/IdentityPets.integration.test.ts \
  apps/carneloot-bot/test/pet-food/PetFoodMigration.integration.test.ts \
  apps/carneloot-bot/test/notifications/NotificationRepository.integration.test.ts \
  apps/carneloot-bot/test/notifications/FeedingReminderScheduling.integration.test.ts \
  apps/carneloot-bot/test/notifications/FeedingReminder.e2e.integration.test.ts
```

Expected: all tests PASS. Concurrent migration remains safe. Ledger validation and logging remain unchanged at Carneloot boundary.

- [ ] **Step 8: Confirm only composition roots invoke migrations**

Run:

```bash
rg -n "\bmigrate\b" apps/carneloot-bot/src packages/postgres/src
```

Expected runtime ownership:

```text
apps/carneloot-bot/src/postgres/AppMigrator.ts
apps/carneloot-bot/src/postgres/RepositoriesLive.ts
packages/postgres/src/Migrations.ts
packages/postgres/src/TfxPostgres.ts
```

No individual repository or store layer should invoke migration.

- [ ] **Step 9: Commit Carneloot adoption**

```bash
git add apps/carneloot-bot packages/postgres
git commit -m "fix(carneloot): acquire application migrations once"
```

---

### Task 6: Add Full Portable-Layer Acquisition Regression

**Files:**
- Create: `apps/carneloot-bot/test/PortableLayer.integration.test.ts`

- [ ] **Step 1: Write full-graph log-count regression test**

Create `apps/carneloot-bot/test/PortableLayer.integration.test.ts` with these imports, fixtures, and logger capture:

```ts
import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import { Duration, Effect, Layer, Logger, References } from 'effect';
import * as Redacted from 'effect/Redacted';
import * as Telegram from 'tfx/Telegram';
import * as UpdateDelivery from 'tfx/UpdateDelivery';
import { describe, expect, it } from 'vitest';

import type { AppConfigService } from '../src/Config.js';
import * as Layers from '../src/Layers.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const config: AppConfigService = {
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
	tfxSchema: 'tfx_portable_test',
	tfxTablePrefix: 'case_',
};
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

describe.skipIf(!enabled)('portable PostgreSQL layer', () => {
	it('acquires each migration suite once per portable graph build', async () => {
		const telegram = Layer.provide(
			Telegram.layer(config.botToken),
			NodeHttpClient.layerFetch,
		);
		const graph = Layers.portable(config, {
			pg: PostgresTestLayer.layer,
			telegram,
			delivery: UpdateDelivery.manual,
			botUsername: config.botUsername,
		});
		const captured = await Effect.runPromise(
			captureLogs(Effect.scoped(Layer.build(graph))),
		);
		const messages = captured.logs.map((log) => log.message);
		expect(
			messages.filter(
				(message) => message === 'carneloot.migrations.started',
			),
		).toHaveLength(1);
		expect(
			messages.filter(
				(message) => message === 'carneloot.migrations.completed',
			),
		).toHaveLength(1);
		expect(
			messages.filter(
				(message) => message === 'tfx.postgres.migrations.started',
			),
		).toHaveLength(1);
		expect(
			messages.filter(
				(message) => message === 'tfx.postgres.migrations.completed',
			),
		).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run regression test against fixed graph**

Run:

```bash
RUN_TESTCONTAINERS=true pnpm vitest run --config vitest.integration.config.ts \
  apps/carneloot-bot/test/PortableLayer.integration.test.ts
```

Expected: PASS with one log pair per migration suite.

- [ ] **Step 3: Commit graph regression**

```bash
git add apps/carneloot-bot/test/PortableLayer.integration.test.ts
git commit -m "test(carneloot): assert single migration acquisition"
```

---

### Task 7: Make Bot Source Lifecycle Logging Precise

**Files:**
- Modify: `packages/tfx/src/BotRuntime.ts`
- Modify: `packages/tfx/test/BotRuntime.test.ts`

- [ ] **Step 1: Update expected event name first**

In `packages/tfx/test/BotRuntime.test.ts`, change:

```ts
expect(logs).toContainEqual({
	message: 'tfx.bot.source_forked',
	level: 'Info',
	annotations: { botId: 'bot', concurrency: 1, capacity: 4 },
});
```

- [ ] **Step 2: Run focused test and verify failure**

Run:

```bash
pnpm vitest run packages/tfx/test/BotRuntime.test.ts
```

Expected: FAIL because runtime still emits `tfx.bot.source_started`.

- [ ] **Step 3: Move and rename lifecycle event**

In `packages/tfx/src/BotRuntime.ts`, fork first, then log what actually happened:

```ts
const sourceFiber = yield* Effect.forkScoped(
	source.run(dispatcher.dispatch),
);
yield* Effect.logInfo('tfx.bot.source_forked').pipe(
	Effect.annotateLogs({ botId: bot.name, concurrency, capacity }),
);
```

Keep `tfx.polling.ready` unchanged. It remains the signal that Telegram initialization (`getMe`, webhook deletion, and command setup) completed.

- [ ] **Step 4: Run runtime tests**

Run:

```bash
pnpm vitest run packages/tfx/test/BotRuntime.test.ts packages/tfx/test/Polling.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit observability correction**

```bash
git add packages/tfx/src/BotRuntime.ts packages/tfx/test/BotRuntime.test.ts
git commit -m "fix(tfx): clarify source fiber startup log"
```

---

### Task 8: Final Verification And Cleanup

**Files:**
- Inspect all changed files
- Update generated formatting only through project formatter

- [ ] **Step 1: Search for removed engines and stale event names**

Run:

```bash
rg -n "MigrationChecksumMismatchError|internal/Migrator|internal/MigrationLedger|source_started|skipMigration" \
  apps packages
```

Expected: no matches.

- [ ] **Step 2: Verify package boundaries**

Run:

```bash
rg -n "effect/unstable/sql/Migrator|@effect/sql-pg/PgMigrator" apps packages
```

Expected: no runtime imports. The rationale may mention Effect Migrator only in `packages/postgres-migrator/README.md`.

- [ ] **Step 3: Format and lint**

Run:

```bash
pnpm format:fix
pnpm format
pnpm lint
```

Expected: formatter check and linter PASS.

- [ ] **Step 4: Typecheck and build all project references**

Run:

```bash
pnpm check
pnpm build
```

Expected: both commands PASS and `packages/postgres-migrator/dist` is built before consumer packages.

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

Expected: PASS, including shared migrator concurrency/rollback tests and portable graph acquisition count.

- [ ] **Step 7: Review final diff for accidental compatibility code**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD~7..HEAD
```

Expected:

- No whitespace errors.
- No compatibility shims, legacy ledger conversion, or duplicated migration runner remains.
- One shared runner package.
- One migration owner per aggregate graph.
- Clean working tree after final commit.

- [ ] **Step 8: Commit formatter-only corrections if needed**

If formatting changed tracked files after prior commits:

```bash
git add .
git commit -m "style: format shared migration lifecycle changes"
```

Do not amend earlier commits.

## Acceptance Criteria

- `@tfx/postgres-migrator` is a first-class workspace package and builds before consumers.
- TFX and Carneloot use `PostgresMigrator.run`; neither contains transaction/ledger runner duplication.
- Both reject malformed source manifests, gaps, future rows, renamed rows, and checksum drift.
- Advisory lock is acquired before schema and ledger DDL inside one transaction.
- Migration application and ledger insertion roll back atomically.
- Individual repository/store layers perform no migration side effects.
- `RepositoriesLive.layer` owns Carneloot migration sequencing.
- `TfxPostgres.layer` owns TFX migration sequencing.
- Full portable graph emits exactly one Carneloot and one TFX started/completed pair.
- Existing Carneloot log names and `DomainPersistenceError` boundary remain stable.
- `tfx.bot.source_forked` describes fiber creation; `tfx.polling.ready` remains network readiness.
- `pnpm format`, `pnpm lint`, `pnpm check`, `pnpm build`, `pnpm test:unit`, and integration suite pass.

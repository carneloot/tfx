# Effect Reliability Hardening Implementation Plan

**Goal:** Fix reviewed reliability, validation, persistence-invariant, observability, and test-tooling weaknesses without changing intended bot behavior.

**Architecture:** Validate caller-controlled timing and retry-policy values at their owning boundaries, convert invalid job policy output into quarantined job outcomes, and keep transient worker failures isolated from the bot runtime. Persisted job state receives matching TypeScript and PostgreSQL invariants. High-value Effect workflows gain stable `Effect.fn` names, while test commands become deterministic and correctly discover integration suites.

**Tech Stack:** Effect v4 beta.98, TypeScript 7, Vitest 4, PostgreSQL 17, `@effect/sql-pg`, pnpm.

---

> **Prerequisite:** Implement `docs/plans/2026-07-15-effect-native-temporal-types.md` first. This plan assumes its `DateTime.Utc` instant contracts, `Duration.Duration` runtime interval contracts, and `Duration.Input` configuration boundaries throughout.

## Scope and sequencing

After prerequisite rebase, this plan is one umbrella hardening effort, but every task is independently testable and committable. Execute tasks in order because PostgreSQL invariant work depends on runtime state normalization introduced in earlier tasks, and final `Effect.fn` wrapping should happen after workflow behavior stabilizes.

Not included: unrelated domain features, broad service-interface redesign, replacing every existing error class, or adding retries around non-idempotent Telegram sends.

## Validation policy

Use Schema for untrusted boundary data, reusable scalar constraints, structural decoding, and field-local normalization. Manual logic remains only where validation depends on multiple fields, current time, persisted state, byte-level platform limits, authorization, or arithmetic performed after decoding.

| Validation | Decision | Reason |
| --- | --- | --- |
| UUID syntax/version/variant | Schema | `Schema.isUUID()` already implements RFC UUID semantics and diagnostics. |
| Nil/max UUID exclusion | Schema custom filter | Domain policy beyond generic UUID syntax; centralize once. |
| Positive/non-negative safe integers | Schema | `Schema.isInt()` uses `Number.isSafeInteger`; combine with range checks. |
| PostgreSQL bigint string normalization | Schema transformation | `Schema.NumberFromString` plus `Schema.isInt()` replaces repeated `Number(...)` checks. |
| PostgreSQL timestamp normalization | Schema transformation | Reuse the prerequisite plan’s `DateTime.Utc` row codec; PostgreSQL adapters alone convert database `Date` values at the boundary. |
| Job status/lease/outcome relationship | Manual predicate plus SQL CHECK | Cross-field state-machine invariant must match database transitions. |
| Heartbeat less than lease | Manual after scalar Schema decode | Relationship between two already-valid values. |
| Retry instant after `DateTime.addDuration(finishedAt, delay)` | Manual after duration normalization | Computed instant validity depends on the current `DateTime.Utc`. |
| PostgreSQL identifier 63-byte limit | Manual byte-length filter inside Schema | Limit is UTF-8 bytes, not JavaScript string length. |
| Authorization, dedupe ownership, lease fencing | Manual Effect workflow | Decisions require services/current state, not data-shape validation. |

Full conversion of Carneloot's five application PostgreSQL adapters (`UserRepositoryLive`, `PetRepositoryLive`, `PetFoodRepositoryLive`, `NotificationRepositoryLive`, `NotificationRecipientsLive`) is intentionally a follow-up refactor. Their current helpers already map malformed rows into typed repository failures; replacing all timestamp/bigint mapping in this reliability plan would mix a broad adapter rewrite with worker/state fixes. Task 0 establishes and tests the codec pattern in `@tfx/postgres`; apply the same pattern to application adapters in a separate plan after this plan lands.

`Config.ts` remains hybrid: field-local username, SQL-identifier, bot-id, and numeric rules should move to `Config.schema`, while redacted-secret checks and cross-field relationships remain explicit. This is also a focused follow-up because changing config recipes changes startup error rendering and must be reviewed for secret leakage.

## File map

### New files

- `apps/carneloot-bot/src/domain/Uuid.ts` — shared non-sentinel RFC UUID schema for branded application identifiers.
- `packages/postgres/test/RowValidation.test.ts` — focused row-codec tests for bigint normalization and the prerequisite `DateTime.Utc` timestamp codec.
- `packages/tfx/src/internal/BoundedMapSweep.ts` — resumable bounded `Map` cleanup used by memory deduplication.
- `packages/tfx/test/BoundedMapSweep.test.ts` — proves bounded scans eventually reach entries beyond first batch.
- `packages/postgres/src/internal/JobStateInvariant.ts` — one TypeScript predicate for decoded job status/lease/outcome combinations.
- `packages/postgres/src/internal/Migration0003.ts` — normalizes legacy active-job outcomes and adds durable job-state constraint.
- `packages/postgres/test/JobStateInvariant.test.ts` — unit matrix for decoder-side state invariants.

### Modified runtime files

- `apps/carneloot-bot/src/domain/Ids.ts`
- `apps/carneloot-bot/src/domain/pet-food/PetFood.ts`
- `apps/carneloot-bot/src/domain/notifications/NotificationEvent.ts`
- `apps/carneloot-bot/src/domain/notifications/NotificationDelivery.ts`
- `packages/postgres/src/internal/RowValidation.ts`
- `packages/postgres/src/PostgresConversationStorage.ts`
- `packages/tfx/src/Job.ts`
- `packages/tfx/src/JobRuntime.ts`
- `packages/tfx/src/MemoryJobStore.ts`
- `packages/tfx/src/Polling.ts`
- `packages/tfx/src/MemoryUpdateDeduplicator.ts`
- `packages/tfx/src/internal/update-source/PollingSource.ts`
- `packages/tfx/src/internal/runtime/DeduplicatedDispatch.ts`
- `packages/postgres/src/internal/Tables.ts`
- `packages/postgres/src/internal/Migrator.ts`
- `packages/postgres/src/internal/MigrationChecksums.ts`
- `packages/postgres/src/PostgresJobStore.ts`
- `packages/postgres/src/PostgresUpdateDeduplicator.ts`
- `apps/carneloot-bot/src/application/DispatchNotificationDelivery.ts`
- `apps/carneloot-bot/src/JobWorker.ts`

### Modified tests and tooling

- `apps/carneloot-bot/test/Ids.test.ts`
- `packages/tfx/test/Job.test.ts`
- `packages/tfx/test/JobRuntime.test.ts`
- `packages/tfx/test/Polling.test.ts`
- `packages/tfx/test/UpdateDeduplicator.test.ts`
- `packages/postgres/test/Deduplicator.integration.test.ts`
- `packages/postgres/test/JobStore.integration.test.ts`
- `packages/postgres/test/Migrations.integration.test.ts`
- `packages/postgres/test/Identifiers.test.ts`
- `apps/carneloot-bot/test/JobWorker.test.ts`
- `apps/carneloot-bot/test/notifications/DispatchNotificationDelivery.test.ts`
- `packages/tfx/test/package-exports.test.ts`
- `packages/postgres/test/package-exports.test.ts`
- `apps/carneloot-bot/package.json`

---

## Tasks

### Task 0: Consolidate UUID and PostgreSQL scalar boundary schemas

**Files:**
- Create: `apps/carneloot-bot/src/domain/Uuid.ts`
- Create: `packages/postgres/test/RowValidation.test.ts`
- Modify: `apps/carneloot-bot/src/domain/Ids.ts`
- Modify: `apps/carneloot-bot/src/domain/pet-food/PetFood.ts`
- Modify: `apps/carneloot-bot/src/domain/notifications/NotificationEvent.ts`
- Modify: `apps/carneloot-bot/src/domain/notifications/NotificationDelivery.ts`
- Modify: `apps/carneloot-bot/test/Ids.test.ts`
- Modify: `packages/postgres/src/internal/RowValidation.ts`
- Modify: `packages/postgres/src/PostgresJobStore.ts:26-148`
- Modify: `packages/postgres/src/PostgresConversationStorage.ts:23-120`
- Modify: `packages/postgres/src/PostgresUpdateDeduplicator.ts:20-102`

- [ ] **Step 1: Add UUID compatibility tests**

Extend `apps/carneloot-bot/test/Ids.test.ts` imports with `UserId`, `PetId`, `FoodEntryId`, `EventId`, and `DeliveryId`. Add:

```ts
const validUuid = '00000000-0000-4000-8000-000000000001';
const uuidDecoders: ReadonlyArray<(value: unknown) => string> = [
	Schema.decodeUnknownSync(UserId),
	Schema.decodeUnknownSync(PetId),
	Schema.decodeUnknownSync(FoodEntryId),
	Schema.decodeUnknownSync(EventId),
	Schema.decodeUnknownSync(DeliveryId),
];

it('accepts RFC UUIDs and rejects malformed or sentinel identifiers', () => {
	for (const decode of uuidDecoders) {
		expect(decode(validUuid)).toBe(validUuid);
		for (const invalid of [
			'not-a-uuid',
			'00000000-0000-0000-0000-000000000000',
			'ffffffff-ffff-ffff-ffff-ffffffffffff',
		])
			expect(() => decode(invalid)).toThrow();
	}
});
```

Preserving nil/max rejection avoids silently widening existing identifier semantics while removing duplicated regex implementation.

- [ ] **Step 2: Add PostgreSQL row-codec tests**

Create `packages/postgres/test/RowValidation.test.ts`:

```ts
import { DateTime, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import {
	NullableInteger,
	NullableTimestamp,
	RawInteger,
	Timestamp,
	Uuid,
} from '../src/internal/RowValidation.js';

describe('PostgreSQL row validation schemas', () => {
	it('validates non-sentinel RFC UUIDs', () => {
		const decode = Schema.decodeUnknownSync(Uuid);
		expect(decode('00000000-0000-4000-8000-000000000001')).toBe(
			'00000000-0000-4000-8000-000000000001',
		);
		for (const invalid of [
			'not-a-uuid',
			'00000000-0000-0000-0000-000000000000',
			'ffffffff-ffff-ffff-ffff-ffffffffffff',
		])
			expect(() => decode(invalid)).toThrow();
	});

	it('normalizes safe bigint numbers and strings', () => {
		const decode = Schema.decodeUnknownSync(RawInteger);
		expect(decode(42)).toBe(42);
		expect(decode('42')).toBe(42);
		for (const invalid of [
			'1.5',
			'not-a-number',
			'9007199254740992',
			Number.POSITIVE_INFINITY,
		])
			expect(() => decode(invalid)).toThrow();
		expect(Schema.decodeUnknownSync(NullableInteger)(null)).toBeNull();
	});

	it('normalizes supported timestamp representations to DateTime.Utc', () => {
		const decode = Schema.decodeUnknownSync(Timestamp);
		const instant = '2024-01-02T03:04:05.000Z';
		expect(DateTime.formatIso(decode(instant))).toBe(instant);
		expect(DateTime.formatIso(decode(Date.parse(instant)))).toBe(instant);
		expect(Schema.decodeUnknownSync(NullableTimestamp)(null)).toBeNull();
		for (const invalid of ['not-a-date', Number.NaN, {}])
			expect(() => decode(invalid)).toThrow();
	});
});
```

- [ ] **Step 3: Run tests and verify transformed row schemas are missing**

```bash
pnpm exec vitest run apps/carneloot-bot/test/Ids.test.ts packages/postgres/test/RowValidation.test.ts
```

Expected: UUID tests pass under duplicated regexes; row-codec test fails because transformed schemas do not exist.

- [ ] **Step 4: Create one application UUID schema**

Create `apps/carneloot-bot/src/domain/Uuid.ts`:

```ts
import * as Schema from 'effect/Schema';

const nilUuid = '00000000-0000-0000-0000-000000000000';
const maxUuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

export const Uuid = Schema.String.check(
	Schema.isUUID(),
	Schema.makeFilter(
		(value) => {
			const normalized = value.toLowerCase();
			return normalized !== nilUuid && normalized !== maxUuid;
		},
		{ message: 'Expected a non-sentinel UUID' },
	),
);
```

Replace all application UUID regex declarations with `Uuid.pipe(Schema.brand(...))`:

```ts
export const UserId = Uuid.pipe(Schema.brand('CarnelootUserId'));
export const PetId = Uuid.pipe(Schema.brand('CarnelootPetId'));
export const FoodEntryId = Uuid.pipe(Schema.brand('FoodEntryId'));
export const EventId = Uuid.pipe(Schema.brand('NotificationEventId'));
export const DeliveryId = Uuid.pipe(Schema.brand('NotificationDeliveryId'));
```

Also change `NotificationEvent.jobId` from `Schema.NullOr(Schema.String)` to `Schema.NullOr(Uuid)` because persisted job IDs are UUIDs.

- [ ] **Step 5: Replace raw integer/timestamp helpers with Schema codecs**

In `packages/postgres/src/internal/RowValidation.ts`, define:

```ts
const nilUuid = '00000000-0000-0000-0000-000000000000';
const maxUuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
export const Uuid = Schema.String.check(
	Schema.isUUID(),
	Schema.makeFilter(
		(value) => {
			const normalized = value.toLowerCase();
			return normalized !== nilUuid && normalized !== maxUuid;
		},
		{ message: 'Expected a non-sentinel UUID' },
	),
);

export const RawInteger = Schema.Union([
	Schema.Int,
	Schema.NumberFromString.check(Schema.isInt()),
]);
export const NullableInteger = Schema.NullOr(RawInteger);
export const NonNegativeRawInteger = RawInteger.check(
	Schema.isGreaterThanOrEqualTo(0),
);
export const PositiveRawInteger = RawInteger.check(
	Schema.isGreaterThan(0),
);

Reuse `Timestamp` and `NullableTimestamp` from the prerequisite temporal migration. They decode supported PostgreSQL timestamp representations directly to `DateTime.Utc`; do not add a parallel `Date`-returning schema.
```

Remove exported `safeInteger` and `timestamp` functions after all three adapters use these schemas. Keep `expectOne`, `safeCause`, outcome schemas, and `decode` error mapping.

- [ ] **Step 6: Push scalar validation into each row schema**

Use field-local schemas instead of post-decode checks. Import `Uuid` from `RowValidation` in `PostgresJobStore`, then use:

```ts
const RowSchema = Schema.Struct({
	id: Uuid,
	declaration: Schema.NonEmptyString,
	payload_version: Schema.Int.check(Schema.isGreaterThan(0)),
	payload_json: Schema.Unknown,
	status: Schema.Literals([
		'scheduled',
		'running',
		'completed',
		'failed',
		'quarantined',
		'cancelled',
	]),
	conflict_key: NullableString,
	attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	max_attempts: Schema.Int.check(Schema.isGreaterThan(0)),
	run_at: Timestamp,
	lease_generation: NonNegativeRawInteger,
	lease_phase: Schema.Union([
		Schema.Null,
		Schema.Literals(['migration', 'execution']),
	]),
	lease_expires_at: NullableTimestamp,
	cancellation_requested: Schema.Boolean,
	last_error_json: NullableUnknown,
	outcome_json: NullableUnknown,
	created_at: Timestamp,
	updated_at: Timestamp,
});
```

Apply same field-local pattern in conversation and dedup row schemas:

```ts
bot_id: Schema.NonEmptyString,
conversation_id: Schema.NonEmptyString,
version: Schema.Int.check(Schema.isGreaterThan(0)),
step: Schema.NonEmptyString,
revision: NonNegativeRawInteger,
expires_at: NullableTimestamp,
```

```ts
update_id: RawInteger,
lease_generation: NonNegativeRawInteger,
lease_expires_at: Timestamp,
completed_at: NullableTimestamp,
```

After decode, keep timestamps as `DateTime.Utc` and use decoded integer values directly. Convert with `DateTime.toDateUtc` only when binding PostgreSQL parameters. Keep only relational checks such as `attempts <= maxAttempts`, status/outcome pairing, generation overflow after increment, and lease/current-time comparisons.

- [ ] **Step 7: Run row, adapter, and domain tests**

```bash
pnpm exec vitest run apps/carneloot-bot/test/Ids.test.ts packages/postgres/test/RowValidation.test.ts
RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts packages/postgres/test/ConversationStorage.integration.test.ts packages/postgres/test/JobStore.integration.test.ts packages/postgres/test/Deduplicator.integration.test.ts
pnpm check
```

Expected: UUID semantics remain unchanged; PostgreSQL bigint strings and timestamps normalize through Schema; malformed scalar rows remain typed invariant failures.

- [ ] **Step 8: Commit**

```bash
git add apps/carneloot-bot/src/domain/Uuid.ts apps/carneloot-bot/src/domain/Ids.ts apps/carneloot-bot/src/domain/pet-food/PetFood.ts apps/carneloot-bot/src/domain/notifications/NotificationEvent.ts apps/carneloot-bot/src/domain/notifications/NotificationDelivery.ts apps/carneloot-bot/test/Ids.test.ts packages/postgres/src/internal/RowValidation.ts packages/postgres/src/PostgresJobStore.ts packages/postgres/src/PostgresConversationStorage.ts packages/postgres/src/PostgresUpdateDeduplicator.ts packages/postgres/test/RowValidation.test.ts
git commit -m "refactor(schema): centralize boundary scalar validation"
```

---

### Task 1: Make job retry policies total and reject duplicate declarations

**Files:**
- Modify: `packages/tfx/src/Job.ts`
- Modify: `packages/tfx/src/JobRuntime.ts`
- Modify: `packages/tfx/test/Job.test.ts`
- Modify: `packages/tfx/test/JobRuntime.test.ts`

- [ ] **Step 1: Extend duration-native retry tests**

Verify `Job.retry` accepts `Duration.Input`, normalizes once to `Duration.Duration`, keeps `Duration.zero` valid for immediate retry, and rejects invalid, negative, or infinite inputs. Add arbitrary-policy tests using valid durations plus forged negative/infinite `Duration.Duration` values; invalid policy output must quarantine the job rather than defect the worker. Use `DateTime.Utc` fixtures for finish/retry instants and compare computed retry instants with `DateTime.Equivalence`.

- [ ] **Step 2: Evaluate callback output safely inside `JobRuntime`**

Keep retry evaluation duration-native:

```ts
type RetryEvaluation =
	| {
			readonly _tag: 'Retry';
			readonly delay: Duration.Duration;
			readonly retryAt: DateTime.Utc;
	  }
	| { readonly _tag: 'Permanent' };

const validRetryDuration = (value: Duration.Duration): boolean =>
	Duration.isFinite(value) && !Duration.isNegative(value);

const retryAt = DateTime.addDuration(finishedAt, delay);
if (!validRetryDuration(delay) || !Number.isFinite(DateTime.toDateUtc(retryAt).getTime()))
	throw new TypeError('Job retry delay must produce a valid instant');
```

`Job.retry(input)` performs `Duration.Input` normalization at the helper boundary. Custom `schedule` callbacks already return `Duration.Duration`; catch thrown callbacks and reject forged invalid durations. Persist retry outcomes with the normalized duration and pass `DateTime.Utc` directly to `JobStore.finalize`. Never convert duration to milliseconds for runtime validation.

- [ ] **Step 3: Reject duplicate declaration names synchronously**

At start of `JobRuntime.layer`, before constructing `Layer.effect`, validate declaration names with a `Set` and throw `TypeError("Duplicate job declaration '<name>'")` on duplicates. This remains a programmer configuration error detected before acquisition.

- [ ] **Step 4: Run focused tests, type-check, and commit**

```bash
pnpm exec vitest run packages/tfx/test/Job.test.ts packages/tfx/test/JobRuntime.test.ts
pnpm check
git add packages/tfx/src/Job.ts packages/tfx/src/JobRuntime.ts packages/tfx/test/Job.test.ts packages/tfx/test/JobRuntime.test.ts
git commit -m "fix(tfx): validate job retry policies"
```

Expected: duration-native policy tests pass, invalid callbacks quarantine jobs, duplicate declarations fail before layer acquisition, and no numeric temporal API is introduced.

---

### Task 2: Validate polling options without numeric duration contracts

**Files:**
- Modify: `packages/tfx/src/Polling.ts`
- Modify: `packages/tfx/test/Polling.test.ts`

- [ ] **Step 1: Add public constructor tests**

Test `timeout` and `retryDelay` with `Duration.Input` values. Reject invalid, zero, negative, and infinite durations; accept boundaries from `Duration.seconds(1)` through `Duration.seconds(50)` for Telegram long polling. Keep `limit` as an integer number in `[1, 100]`.

- [ ] **Step 2: Normalize temporal options once in `Polling.make`**

Use the prerequisite plan's duration normalizer. Store `Duration.Duration` in normalized polling options. Validate timeout bounds with `Duration.compare`; validate `limit` with Schema integer/range checks. Convert timeout through `Duration.toSeconds` only when constructing Telegram `getUpdates` request, where protocol requires integer seconds. Pass `retryDelay` directly to `Effect.sleep`.

```ts
const timeout = normalizeDuration(options.timeout ?? '30 seconds', 'timeout');
const retryDelay = normalizeDuration(
	options.retryDelay ?? '1 second',
	'retryDelay',
);
if (
	Duration.isZero(timeout) ||
	Duration.isNegative(timeout) ||
	Duration.isInfinite(timeout) ||
	Duration.greaterThan(timeout, Duration.seconds(50))
)
	throw new TypeError('Polling timeout must be between 1 and 50 seconds');
```

- [ ] **Step 3: Run tests, type-check, and commit**

```bash
pnpm exec vitest run packages/tfx/test/Polling.test.ts packages/tfx/test/PollingSource.test.ts
pnpm check
git add packages/tfx/src/Polling.ts packages/tfx/src/internal/update-source/PollingSource.ts packages/tfx/test/Polling.test.ts packages/tfx/test/PollingSource.test.ts
git commit -m "fix(tfx): validate polling options"
```

Expected: temporal options remain Effect durations internally; only Telegram request serialization uses numeric seconds.

---

### Task 3: Make bounded memory deduplication cleanup eventually complete

**Files:**
- Create: `packages/tfx/src/internal/BoundedMapSweep.ts`
- Create: `packages/tfx/test/BoundedMapSweep.test.ts`
- Modify: `packages/tfx/src/MemoryUpdateDeduplicator.ts:24-64,121-131`

- [ ] **Step 1: Write bounded-sweep regression test**

Create `packages/tfx/test/BoundedMapSweep.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
	makeCursor,
	sweep,
} from '../src/internal/BoundedMapSweep.js';

describe('BoundedMapSweep', () => {
	it('resumes after the previous batch instead of rescanning the head', () => {
		const rows = new Map(
			Array.from({ length: 20 }, (_, index) => [
				index,
				{ expired: index >= 16 },
			] as const),
		);
		const cursor = makeCursor<number, { readonly expired: boolean }>();
		sweep(rows, cursor, (row) => row.expired, 16);
		expect(rows.size).toBe(20);
		sweep(rows, cursor, (row) => row.expired, 16);
		expect([...rows.keys()]).toEqual(
			Array.from({ length: 16 }, (_, index) => index),
		);
	});
});
```

- [ ] **Step 2: Run test and verify missing module failure**

```bash
pnpm exec vitest run packages/tfx/test/BoundedMapSweep.test.ts
```

Expected: FAIL because `BoundedMapSweep.js` does not exist.

- [ ] **Step 3: Implement resumable sweep helper**

Create `packages/tfx/src/internal/BoundedMapSweep.ts`:

```ts
export interface SweepCursor<K, V> {
	iterator: Iterator<[K, V]> | undefined;
}

export const makeCursor = <K, V>(): SweepCursor<K, V> => ({
	iterator: undefined,
});

export const sweep = <K, V>(
	values: Map<K, V>,
	cursor: SweepCursor<K, V>,
	shouldDelete: (value: V) => boolean,
	limit: number,
): void => {
	cursor.iterator ??= values.entries();
	let scanned = 0;
	while (scanned < limit) {
		const next = cursor.iterator.next();
		if (next.done) {
			cursor.iterator = undefined;
			return;
		}
		scanned++;
		const [key, value] = next.value;
		if (shouldDelete(value)) values.delete(key);
	}
};
```

- [ ] **Step 4: Integrate helper into memory deduplicator**

Import `makeCursor` and `sweep`. Create cursor once beside `rows`:

```ts
const records = new Map<number, Row>();
const cleanup = makeCursor<number, Row>();
```

Use existing variable name if retaining `rows`; do not maintain two maps. Replace head-only cleanup loop with:

```ts
sweep(
	rows,
	cleanup,
	(row) =>
		row.released ||
		(row.completed !== undefined && row.retentionUntil! <= now),
	16,
);
```

In `release`, after completing waiter notification, delete released row immediately:

```ts
row.released = true;
Deferred.doneUnsafe(
	row.completion,
	Effect.succeed({ _tag: 'Released' }),
);
rows.delete(token.updateId);
return true;
```

- [ ] **Step 5: Run tests and commit**

```bash
pnpm exec vitest run packages/tfx/test/BoundedMapSweep.test.ts packages/tfx/test/UpdateDeduplicator.test.ts
pnpm check
git add packages/tfx/src/internal/BoundedMapSweep.ts packages/tfx/src/MemoryUpdateDeduplicator.ts packages/tfx/test/BoundedMapSweep.test.ts packages/tfx/test/UpdateDeduplicator.test.ts
git commit -m "fix(tfx): rotate memory dedup cleanup"
```

Expected: sweep regression and existing deduplication behavior pass.

---

### Task 4: Align memory and PostgreSQL deduplicator timing validation

**Files:**
- Modify: `packages/tfx/src/MemoryUpdateDeduplicator.ts`
- Modify: `packages/tfx/test/UpdateDeduplicator.test.ts`
- Modify: `packages/postgres/src/PostgresUpdateDeduplicator.ts`
- Modify: `packages/postgres/test/Deduplicator.integration.test.ts`

- [ ] **Step 1: Expand adapter validation matrices**

Exercise `claim` lease/wait options, `heartbeat` lease duration, and `complete` retention with valid `Duration.Duration` values plus forged zero, negative, and infinite durations. Both adapters must return typed `UpdateDeduplicatorError` failures before mutation or SQL. Configuration-facing option construction may accept `Duration.Input`, but service methods receive normalized `Duration.Duration` from the prerequisite migration.

- [ ] **Step 2: Share duration-native validation behavior**

Validate without converting to milliseconds:

```ts
const positive = (
	value: Duration.Duration,
	name: string,
): Effect.Effect<void, UpdateDeduplicatorError> =>
	Duration.isFinite(value) &&
	!Duration.isZero(value) &&
	!Duration.isNegative(value)
		? Effect.void
		: Effect.fail(
				new UpdateDeduplicatorError(
					'InvariantViolation',
					`${name} must be a finite positive duration`,
				),
			);
```

Run validation inside each existing `Effect.gen` workflow before reading `DateTime.now` or opening a transaction. PostgreSQL operations compute expiry with `DateTime.addDuration` and bind instants with `DateTime.toDateUtc`:

```ts
const now = yield* DateTime.now;
const leaseExpiresAt = DateTime.addDuration(now, duration);
const rows = yield* sql`UPDATE ${schema}.${table}
  SET lease_expires_at=${DateTime.toDateUtc(leaseExpiresAt)},
      updated_at=${DateTime.toDateUtc(now)}
  WHERE bot_id=${botId}
    AND update_id=${token.updateId}
    AND lease_generation=${token.generation}
    AND status='processing'
  RETURNING update_id`;
```

Because `protect` preserves existing `UpdateDeduplicatorError`, invalid arguments remain `InvariantViolation` rather than becoming `PersistenceFailure`.

- [ ] **Step 3: Run parity tests and commit**

```bash
pnpm exec vitest run packages/tfx/test/UpdateDeduplicator.test.ts
RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts packages/postgres/test/Deduplicator.integration.test.ts
pnpm check
git add packages/tfx/src/MemoryUpdateDeduplicator.ts packages/tfx/test/UpdateDeduplicator.test.ts packages/postgres/src/PostgresUpdateDeduplicator.ts packages/postgres/test/Deduplicator.integration.test.ts
git commit -m "fix(postgres): validate dedup timing options"
```

---

### Task 5: Enforce job state invariants in code and PostgreSQL

**Files:**
- Create: `packages/postgres/src/internal/JobStateInvariant.ts`
- Create: `packages/postgres/src/internal/Migration0003.ts`
- Create: `packages/postgres/test/JobStateInvariant.test.ts`
- Modify: `packages/tfx/src/MemoryJobStore.ts:140-175`
- Modify: `packages/postgres/src/internal/Tables.ts:3-28`
- Modify: `packages/postgres/src/internal/Migrator.ts:1-35`
- Modify: `packages/postgres/src/internal/MigrationChecksums.ts`
- Modify: `packages/postgres/src/PostgresJobStore.ts:71-148,296-330`
- Modify: `packages/postgres/test/Identifiers.test.ts`
- Modify: `packages/postgres/test/Migrations.integration.test.ts`
- Modify: `packages/postgres/test/JobStore.integration.test.ts`

- [ ] **Step 1: Write TypeScript invariant matrix**

Create `packages/postgres/test/JobStateInvariant.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { validJobState } from '../src/internal/JobStateInvariant.js';

describe('job state invariant', () => {
	it.each([
		['scheduled', undefined, false, undefined],
		['scheduled', 'migration', true, 'RetryableFailure'],
		['scheduled', 'migration', true, 'LeaseLost'],
		['running', 'execution', true, undefined],
		['completed', undefined, false, 'Succeeded'],
		['failed', undefined, false, 'RetryableFailure'],
		['failed', undefined, false, 'PermanentFailure'],
		['failed', undefined, false, 'LeaseLost'],
		['quarantined', undefined, false, undefined],
		['quarantined', undefined, false, 'FatalFailure'],
		['cancelled', undefined, false, 'Cancelled'],
	] as const)('accepts %s/%s/%s/%s', (status, phase, expiry, outcome) => {
		expect(validJobState(status, phase, expiry, outcome)).toBe(true);
	});

	it.each([
		['scheduled', 'execution', true, undefined],
		['running', undefined, false, undefined],
		['running', 'execution', true, 'RetryableFailure'],
		['completed', undefined, false, undefined],
		['completed', 'execution', true, 'Succeeded'],
		['failed', undefined, false, 'Succeeded'],
		['quarantined', 'migration', true, undefined],
		['cancelled', undefined, false, 'Succeeded'],
	] as const)('rejects %s/%s/%s/%s', (status, phase, expiry, outcome) => {
		expect(validJobState(status, phase, expiry, outcome)).toBe(false);
	});
});
```

- [ ] **Step 2: Write migration and adapter integration expectations**

Update migration ledger expectation in `packages/postgres/test/Migrations.integration.test.ts` with:

```ts
{
	version: 3,
	name: 'job-state-invariant',
	checksum: sourceChecksum('Migration0003.ts'),
},
```

Change checksum-drift ledger count from `'2'` to `'3'`.

Add this test to `packages/postgres/test/JobStore.integration.test.ts`:

```ts
it('enforces persisted status, lease, and outcome combinations', async () => {
	const program = Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const store = yield* JobStore;
		const scheduled = yield* store.schedule({
			name: `state-${crypto.randomUUID()}`,
			payload: {},
			payloadVersion: 1,
			maxAttempts: 2,
			runAt: DateTime.makeUnsafe(0),
			now: 0,
		});
		const id = scheduled.record.id;
		const invalid = [
			sql`UPDATE tfx_job_test.case_jobs SET status='running',lease_phase=NULL,lease_expires_at=NULL,outcome_json=NULL WHERE id=${id}::uuid`,
			sql`UPDATE tfx_job_test.case_jobs SET status='completed',lease_phase='execution',lease_expires_at=now() + interval '1 minute',outcome_json='{"_tag":"Succeeded"}'::jsonb WHERE id=${id}::uuid`,
			sql`UPDATE tfx_job_test.case_jobs SET status='completed',lease_phase=NULL,lease_expires_at=NULL,outcome_json=NULL WHERE id=${id}::uuid`,
		];
		const results = yield* Effect.forEach(invalid, Effect.result);
		yield* sql`DELETE FROM tfx_job_test.case_jobs WHERE id=${id}::uuid`;
		return results;
	});
	const results = await Effect.runPromise(
		Effect.provide(program, diagnosticLayer),
	);
	expect(results.every((result) => result._tag === 'Failure')).toBe(true);
});
```

Add this fail-fast migration test to `packages/postgres/test/Migrations.integration.test.ts`:

```ts
it('fails atomically on an unnormalizable legacy job row', async () => {
	const options = { schema: 'tfx_corrupt_test', tablePrefix: 'case_' };
	const program = Effect.gen(function* () {
		yield* migrate(options);
		const sql = yield* PgClient.PgClient;
		yield* sql`ALTER TABLE tfx_corrupt_test.case_jobs DROP CONSTRAINT case_jobs_state_chk`;
		yield* sql`DELETE FROM tfx_corrupt_test.case_migrations WHERE version=3`;
		const id = crypto.randomUUID();
		yield* sql`INSERT INTO tfx_corrupt_test.case_jobs (id,declaration,payload_version,payload_json,status,attempts,max_attempts,run_at,lease_generation,cancellation_requested,outcome_json,created_at,updated_at) VALUES (${id}::uuid,'corrupt',1,'{}'::jsonb,'completed',0,1,now(),0,false,NULL,now(),now())`;
		const result = yield* Effect.result(migrate(options));
		const failedLedger = yield* sql<{ count: string }>`SELECT count(*)::text AS count FROM tfx_corrupt_test.case_migrations`;
		yield* sql`DELETE FROM tfx_corrupt_test.case_jobs WHERE id=${id}::uuid`;
		yield* migrate(options);
		const repairedLedger = yield* sql<{ count: string }>`SELECT count(*)::text AS count FROM tfx_corrupt_test.case_migrations`;
		return {
			result,
			failedCount: failedLedger[0]?.count,
			repairedCount: repairedLedger[0]?.count,
		};
	});
	const result = await Effect.runPromise(
		Effect.provide(program, PostgresTestLayer.layer),
	);
	expect(result.result._tag).toBe('Failure');
	expect(result.failedCount).toBe('2');
	expect(result.repairedCount).toBe('3');
});
```

Policy: migration 3 normalizes only stale outcomes produced by known prior runtime transitions (`running` and migration-time `quarantined`). Any other legacy corruption fails migration atomically and requires operator repair before retry.

- [ ] **Step 3: Run tests and verify failures**

```bash
pnpm exec vitest run packages/postgres/test/JobStateInvariant.test.ts
RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts packages/postgres/test/Migrations.integration.test.ts packages/postgres/test/JobStore.integration.test.ts
```

Expected: unit test fails because helper is missing; migration ledger lacks v3; invalid SQL writes are accepted.

- [ ] **Step 4: Implement shared TypeScript predicate**

Create `packages/postgres/src/internal/JobStateInvariant.ts`:

```ts
import type { JobStatus, LeasePhase } from 'tfx/JobStore';

export type JobOutcomeTag =
	| 'Succeeded'
	| 'RetryableFailure'
	| 'PermanentFailure'
	| 'FatalFailure'
	| 'Cancelled'
	| 'LeaseLost';

export const validJobState = (
	status: JobStatus,
	leasePhase: LeasePhase | undefined,
	hasLeaseExpiry: boolean,
	outcome: JobOutcomeTag | undefined,
): boolean => {
	if ((leasePhase === undefined) !== !hasLeaseExpiry) return false;
	switch (status) {
		case 'scheduled':
			return (
				(leasePhase === undefined || leasePhase === 'migration') &&
				(outcome === undefined ||
					outcome === 'RetryableFailure' ||
					outcome === 'LeaseLost')
			);
		case 'running':
			return leasePhase === 'execution' && outcome === undefined;
		case 'completed':
			return leasePhase === undefined && outcome === 'Succeeded';
		case 'failed':
			return (
				leasePhase === undefined &&
				(outcome === 'RetryableFailure' ||
					outcome === 'PermanentFailure' ||
					outcome === 'LeaseLost')
			);
		case 'quarantined':
			return (
				leasePhase === undefined &&
				(outcome === undefined || outcome === 'FatalFailure')
			);
		case 'cancelled':
			return leasePhase === undefined && outcome === 'Cancelled';
	}
};
```

- [ ] **Step 5: Normalize runtime transitions before enforcing constraint**

In both memory and PostgreSQL `promoteToRunning`, clear stale prior outcome:

```ts
outcome: undefined,
```

for memory record update and:

```sql
outcome_json=NULL
```

for PostgreSQL update.

In both `quarantineMigration` implementations, clear stale prior outcome for migration-time quarantine. Keep execution-time `FatalFailure` outcome unchanged because it is produced through `finalize`.

- [ ] **Step 6: Apply predicate in row decoder**

After decoding `outcome` in `PostgresJobStore.decodeRow`, call:

```ts
if (
	!validJobState(
		row.status,
		row.lease_phase === null ? undefined : row.lease_phase,
		leaseExpiresAt !== undefined,
		outcome?._tag,
	)
)
	return yield* Effect.fail(
		invariant('Job status/lease/outcome invariant violated'),
	);
```

Keep existing phase/expiry check or fold it into this predicate; do not return malformed records.

- [ ] **Step 7: Add named table constraint**

Add `jobStateConstraint` to `Tables` and initialize it as:

```ts
jobStateConstraint: composed(prefix, 'jobs_state_chk'),
```

Update `packages/postgres/test/Identifiers.test.ts` expected table names with `case_jobs_state_chk`.

Create `packages/postgres/src/internal/Migration0003.ts`:

```ts
import type * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';

import type { Tables } from './Tables.js';

export const up = (sql: PgClient.PgClient, tables: Tables) => {
	const schema = sql(tables.schema);
	const jobs = sql(tables.jobs);
	const constraint = sql(tables.jobStateConstraint);
	return Effect.gen(function* () {
		yield* sql`UPDATE ${schema}.${jobs} SET outcome_json=NULL WHERE status='running'`;
		yield* sql`UPDATE ${schema}.${jobs} SET outcome_json=NULL WHERE status='quarantined' AND outcome_json IS NOT NULL AND outcome_json->>'_tag' <> 'FatalFailure'`;
		yield* sql`ALTER TABLE ${schema}.${jobs} ADD CONSTRAINT ${constraint} CHECK (
			(
				status='scheduled'
				AND (
					(lease_phase IS NULL AND lease_expires_at IS NULL)
					OR (lease_phase='migration' AND lease_expires_at IS NOT NULL)
				)
				AND (
					outcome_json IS NULL
					OR COALESCE(outcome_json->>'_tag' IN ('RetryableFailure','LeaseLost'), false)
				)
			)
			OR (
				status='running'
				AND lease_phase='execution'
				AND lease_expires_at IS NOT NULL
				AND outcome_json IS NULL
			)
			OR (
				status='completed'
				AND lease_phase IS NULL
				AND lease_expires_at IS NULL
				AND COALESCE(outcome_json->>'_tag'='Succeeded', false)
			)
			OR (
				status='failed'
				AND lease_phase IS NULL
				AND lease_expires_at IS NULL
				AND COALESCE(outcome_json->>'_tag' IN ('RetryableFailure','PermanentFailure','LeaseLost'), false)
			)
			OR (
				status='quarantined'
				AND lease_phase IS NULL
				AND lease_expires_at IS NULL
				AND (
					outcome_json IS NULL
					OR COALESCE(outcome_json->>'_tag'='FatalFailure', false)
				)
			)
			OR (
				status='cancelled'
				AND lease_phase IS NULL
				AND lease_expires_at IS NULL
				AND COALESCE(outcome_json->>'_tag'='Cancelled', false)
			)
		)`;
	});
};
```

- [ ] **Step 8: Register immutable migration and checksum**

Import `up as up0003`, append migration:

```ts
{
	version: 3,
	name: 'job-state-invariant',
	checksum: migrationChecksums[3],
	up: up0003,
},
```

Generate checksum only after `Migration0003.ts` is final:

```bash
sha256sum packages/postgres/src/internal/Migration0003.ts
```

Copy exact 64-character output into `migrationChecksums[3]` and update checksum comment to `Migration000{1,2,3}.ts`.

- [ ] **Step 9: Run migration, unit, and integration tests**

```bash
pnpm exec vitest run packages/postgres/test/JobStateInvariant.test.ts packages/postgres/test/Identifiers.test.ts packages/postgres/test/Migrator.test.ts
RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts packages/postgres/test/Migrations.integration.test.ts packages/postgres/test/JobStore.integration.test.ts
pnpm check
```

Expected: matrix passes; migration ledger contains versions 1–3; direct invalid state writes fail; ordinary job lifecycle tests remain green.

- [ ] **Step 10: Commit**

```bash
git add packages/tfx/src/MemoryJobStore.ts packages/postgres/src/internal/JobStateInvariant.ts packages/postgres/src/internal/Migration0003.ts packages/postgres/src/internal/Tables.ts packages/postgres/src/internal/Migrator.ts packages/postgres/src/internal/MigrationChecksums.ts packages/postgres/src/PostgresJobStore.ts packages/postgres/test/JobStateInvariant.test.ts packages/postgres/test/Identifiers.test.ts packages/postgres/test/Migrations.integration.test.ts packages/postgres/test/JobStore.integration.test.ts
git commit -m "fix(postgres): enforce durable job state invariants"
```

---

### Task 6: Preserve notification failure classification

**Files:**
- Modify: `apps/carneloot-bot/src/application/DispatchNotificationDelivery.ts:15-22,254-263`
- Modify: `apps/carneloot-bot/test/notifications/DispatchNotificationDelivery.test.ts`

- [ ] **Step 1: Make harness inject repository reasons before Telegram**

Add to `HarnessOptions`:

```ts
readonly repositoryFailure?: NotificationRepositoryError['reason'];
```

Change `getDispatchContext` in harness to:

```ts
getDispatchContext: () =>
	options.repositoryFailure === undefined
		? Effect.succeed({
				id: eventId,
				botId: options.mismatchedEvent
					? Schema.decodeUnknownSync(BotId)('another-bot')
					: botId,
				kind: 'feeding-reminder',
				ownerUserId: ownerId,
				petId,
				foodEntryId,
				scheduledFor: DateTime.makeUnsafe(0),
				status: options.eventStatus ?? 'scheduled',
				dedupeKey: 'key',
				jobId: null,
				createdAt: DateTime.makeUnsafe(0),
				updatedAt: DateTime.makeUnsafe(0),
				completedAt: null,
				cancelledAt: null,
			})
		: Effect.fail(
				new NotificationRepositoryError({
					reason: options.repositoryFailure,
					message: 'repository test failure',
				}),
			),
```

- [ ] **Step 2: Add classification tests**

```ts
it('retries repository persistence failures', async () => {
	const h = harness(Effect.succeed({ message_id: 1 }), {
		repositoryFailure: 'PersistenceFailure',
	});
	const result = await Effect.runPromise(
		Effect.provide(Effect.result(Dispatch.execute(payload)), h.layer),
	);
	expect(result).toMatchObject({
		_tag: 'Failure',
		failure: { _tag: 'FeedingReminderRetryError', retryAfter: Duration.seconds(1) },
	});
	expect(h.calls()).toBe(0);
});

it.each(['InvariantViolation', 'NotFound', 'Conflict'] as const)(
	'makes repository %s failures permanent',
	async (repositoryFailure) => {
		const h = harness(Effect.succeed({ message_id: 1 }), {
			repositoryFailure,
		});
		const result = await Effect.runPromise(
			Effect.provide(Effect.result(Dispatch.execute(payload)), h.layer),
		);
		expect(result).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'FeedingReminderPermanentError' },
		});
		expect(h.calls()).toBe(0);
	},
);
```

- [ ] **Step 3: Run test and verify permanent cases fail**

```bash
pnpm exec vitest run apps/carneloot-bot/test/notifications/DispatchNotificationDelivery.test.ts
```

Expected: persistence case passes under current generic mapping; permanent cases incorrectly produce `FeedingReminderRetryError`.

- [ ] **Step 4: Import error class as value and classify by reason**

Change import from `type NotificationRepositoryError` to value import. Add:

```ts
const mapRepositoryError = (
	error: NotificationRepositoryError,
): FeedingReminderRetryError | FeedingReminderPermanentError =>
	error.reason === 'PersistenceFailure'
		? new FeedingReminderRetryError({
				message: 'Reminder delivery persistence failed',
				retryAfter: Duration.seconds(1),
			})
		: new FeedingReminderPermanentError({
				message: `Reminder delivery ${error.reason}`,
			});
```

Replace final `mapError` body with:

```ts
Effect.mapError((cause) =>
	cause instanceof FeedingReminderRetryError ||
	cause instanceof FeedingReminderPermanentError
		? cause
		: cause instanceof NotificationRepositoryError
			? mapRepositoryError(cause)
			: new FeedingReminderRetryError({
					message: 'Reminder delivery infrastructure failed',
					retryAfter: Duration.seconds(1),
				}),
),
```

Unknown adapter/Telegram dependencies remain retryable or are already classified inside workflow; deterministic repository state failures become permanent.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm exec vitest run apps/carneloot-bot/test/notifications/DispatchNotificationDelivery.test.ts apps/carneloot-bot/test/notifications/FeedingReminderJob.test.ts
pnpm check
git add apps/carneloot-bot/src/application/DispatchNotificationDelivery.ts apps/carneloot-bot/test/notifications/DispatchNotificationDelivery.test.ts
git commit -m "fix(carneloot): preserve notification failure semantics"
```

---

### Task 7: Keep transient job-store failures from stopping bot runtime

**Files:**
- Modify: `apps/carneloot-bot/src/JobWorker.ts`
- Modify: `apps/carneloot-bot/test/JobWorker.test.ts`

- [ ] **Step 1: Replace fail-fast persistence test with deterministic recovery test**

Use `TestClock.adjust('10 seconds')` and deterministic `Random` to prove six transient `PersistenceFailure` results are retried and a later pass succeeds. Preserve a separate assertion that non-transient `InvariantViolation` still surfaces through `JobWorker.await`.

- [ ] **Step 2: Validate normalized worker durations**

`JobWorkerLive.layer` remains a configuration boundary: its options accept `Duration.Input`, normalize once, and store `Duration.Duration`. Test valid Effect duration values and invalid inputs for `idleDelay`, `leaseDuration`, and `heartbeatInterval`. Keep `heartbeatInterval < leaseDuration` as explicit relational validation using `Duration.lessThan` after normalization.

```ts
const validate = (
	value: Duration.Duration,
	option: 'idleDelay' | 'leaseDuration' | 'heartbeatInterval',
) =>
	Duration.isFinite(value) &&
	!Duration.isZero(value) &&
	!Duration.isNegative(value)
		? Effect.void
		: Effect.fail(
				new JobWorkerOptionsError({
					option,
					message: `${option} must be a finite positive duration`,
				}),
			);
```

- [ ] **Step 3: Add bounded exponential retry burst**

Build schedule directly from normalized duration:

```ts
const persistenceRetry = Schedule.exponential(options.idleDelay).pipe(
	Schedule.jittered,
	Schedule.upTo({ times: 5 }),
);
```

Retry only `JobStoreError` with reason `PersistenceFailure`. After exhaustion, log `JobWorker.persistence_retry_exhausted`, sleep `idleDelay`, and continue outer loop. Let all non-transient errors fail the worker. Pass normalized lease and heartbeat durations directly into `jobs.runOne` and `Effect.sleep`.

- [ ] **Step 4: Run focused tests and commit**

```bash
pnpm exec vitest run apps/carneloot-bot/test/JobWorker.test.ts
pnpm check
git add apps/carneloot-bot/src/JobWorker.ts apps/carneloot-bot/test/JobWorker.test.ts
git commit -m "fix(carneloot): recover job worker persistence failures"
```

Expected: worker recovers deterministically from transient bursts, permanent errors remain visible, and worker temporal contracts contain no numeric units.

---

### Task 8: Add stable `Effect.fn` names to touched boundaries

**Files:**
- Modify: `packages/tfx/src/JobRuntime.ts`
- Modify: `packages/tfx/src/MemoryUpdateDeduplicator.ts`
- Modify: `packages/tfx/src/internal/update-source/PollingSource.ts`
- Modify: `packages/tfx/src/internal/runtime/DeduplicatedDispatch.ts`
- Modify: `packages/postgres/src/PostgresJobStore.ts`
- Modify: `packages/postgres/src/PostgresUpdateDeduplicator.ts`
- Modify: `apps/carneloot-bot/src/application/DispatchNotificationDelivery.ts`
- Modify: `apps/carneloot-bot/src/JobWorker.ts`

- [ ] **Step 1: Record behavioral baseline**

```bash
pnpm exec vitest run packages/tfx/test/JobRuntime.test.ts packages/tfx/test/Polling.test.ts packages/tfx/test/UpdateDeduplicator.test.ts packages/postgres/test/JobStateInvariant.test.ts apps/carneloot-bot/test/JobWorker.test.ts apps/carneloot-bot/test/notifications/DispatchNotificationDelivery.test.ts
```

Expected: all focused tests pass before observability-only wrappers.

- [ ] **Step 2: Wrap public/non-trivial functions without changing bodies**

Use these exact names:

```text
JobRuntime.schedule
JobRuntime.runOne
JobRuntime.cancel
JobRuntime.releaseFailed
MemoryUpdateDeduplicator.claim
MemoryUpdateDeduplicator.heartbeat
MemoryUpdateDeduplicator.complete
MemoryUpdateDeduplicator.release
PollingSource.run
DeduplicatedDispatch.dispatch
PostgresJobStore.get
PostgresJobStore.promoteToRunning
PostgresJobStore.quarantineMigration
PostgresJobStore.finalize
PostgresUpdateDeduplicator.claim
PostgresUpdateDeduplicator.heartbeat
PostgresUpdateDeduplicator.complete
PostgresUpdateDeduplicator.release
DispatchNotificationDelivery.execute
JobWorker.runOnePass
```

For `DispatchNotificationDelivery.execute`, replace its arrow-plus-`Effect.gen` opening with a named generator while retaining every statement and final `mapError` transform:

```ts
export const execute = Effect.fn('DispatchNotificationDelivery.execute')(
	function* (
		payload: DispatchPayload,
		options: { readonly leaseDuration?: Duration.Input } = {},
	) {
		const leaseDuration = normalizeDuration(
			options.leaseDuration ?? '30 seconds',
			'leaseDuration',
		);
```

The current generator's final `}).pipe(Effect.mapError(...))` becomes the whole-function transform passed after generator:

```ts
	},
	(effect) =>
		effect.pipe(
			Effect.mapError((cause) =>
				cause instanceof FeedingReminderRetryError ||
				cause instanceof FeedingReminderPermanentError
					? cause
					: cause instanceof NotificationRepositoryError
						? mapRepositoryError(cause)
						: new FeedingReminderRetryError({
								message: 'Reminder delivery infrastructure failed',
								retryAfter: Duration.seconds(1),
							}),
			),
		),
);
```

For service object members, preserve interface signatures:

```ts
const heartbeat: UpdateDeduplicatorService['heartbeat'] = Effect.fn(
	'PostgresUpdateDeduplicator.heartbeat',
)(function* (token, duration = Duration.seconds(30)) {
	yield* positive(duration, 'leaseDuration');
	const now = yield* DateTime.now;
	const leaseExpiresAt = DateTime.addDuration(now, duration);
	const rows = yield* sql`UPDATE ${schema}.${table} SET lease_expires_at=${DateTime.toDateUtc(leaseExpiresAt)},updated_at=${DateTime.toDateUtc(now)} WHERE bot_id=${botId} AND update_id=${token.updateId} AND lease_generation=${token.generation} AND status='processing' RETURNING update_id`;
	return rows.length > 0;
});
```

Assign named constants into service objects. Do not wrap recursive `loop`, heartbeat monitor, or schema decoder helpers; their owning operation already supplies trace context.

- [ ] **Step 3: Verify names exist and no public type changed**

```bash
for name in \
  JobRuntime.schedule \
  JobRuntime.runOne \
  MemoryUpdateDeduplicator.claim \
  PollingSource.run \
  DeduplicatedDispatch.dispatch \
  PostgresJobStore.finalize \
  PostgresUpdateDeduplicator.claim \
  DispatchNotificationDelivery.execute \
  JobWorker.runOnePass
do
  rg -F "'$name'" packages apps >/dev/null || exit 1
done
pnpm check
```

Expected: command exits zero and TypeScript signatures remain compatible.

- [ ] **Step 4: Re-run behavioral suite and commit**

```bash
pnpm exec vitest run packages/tfx/test/JobRuntime.test.ts packages/tfx/test/Polling.test.ts packages/tfx/test/UpdateDeduplicator.test.ts packages/postgres/test/JobStateInvariant.test.ts apps/carneloot-bot/test/JobWorker.test.ts apps/carneloot-bot/test/notifications/DispatchNotificationDelivery.test.ts
git add packages/tfx/src/JobRuntime.ts packages/tfx/src/MemoryUpdateDeduplicator.ts packages/tfx/src/internal/update-source/PollingSource.ts packages/tfx/src/internal/runtime/DeduplicatedDispatch.ts packages/postgres/src/PostgresJobStore.ts packages/postgres/src/PostgresUpdateDeduplicator.ts apps/carneloot-bot/src/application/DispatchNotificationDelivery.ts apps/carneloot-bot/src/JobWorker.ts
git commit -m "refactor(effect): name runtime operation boundaries"
```

---

### Task 9: Repair integration discovery and de-flake package export tests

**Files:**
- Modify: `apps/carneloot-bot/package.json:6-13`
- Modify: `packages/tfx/test/package-exports.test.ts`
- Modify: `packages/postgres/test/package-exports.test.ts`

- [ ] **Step 1: Capture current failures**

```bash
pnpm --filter carneloot-bot test:integration
pnpm test:unit
```

Expected before changes:
- app command exits 1 with `No test files found`;
- unit suite can time out one or both `npm pack --dry-run` tests at default 5 seconds under parallel load.

- [ ] **Step 2: Fix app integration filter**

Replace script with directory filter; integration config already limits accepted suffixes:

```json
"test:integration": "vitest run --root ../.. --config vitest.integration.config.ts apps/carneloot-bot/test"
```

This discovers top-level, `notifications/`, `pet-food/`, and `e2e/` integration suites without relying on shell globstar expansion.

- [ ] **Step 3: Give package subprocess tests an explicit budget**

Change each package export test declaration from:

```ts
it('does not export or pack private database helpers', async () => {
```

or its tfx equivalent to Vitest timeout options:

```ts
it('does not export or pack private database helpers', async () => {
```

and append options after callback:

```ts
}, { timeout: 30_000 });
```

For tfx use identical `{ timeout: 30_000 }`. Keep `npm pack --dry-run` and private-export assertions unchanged; measured failures were timeout/resource contention, not assertion failures.

- [ ] **Step 4: Verify discovery and repeated export stability**

```bash
pnpm --filter carneloot-bot test:integration
for run in 1 2 3; do
  pnpm exec vitest run packages/tfx/test/package-exports.test.ts packages/postgres/test/package-exports.test.ts || exit 1
done
```

Expected:
- app command discovers app integration/e2e files and exits zero when suites are skipped for missing database activation;
- all six package-export executions pass without 5-second timeout.

- [ ] **Step 5: Commit**

```bash
git add apps/carneloot-bot/package.json packages/tfx/test/package-exports.test.ts packages/postgres/test/package-exports.test.ts
git commit -m "test: stabilize integration and package checks"
```

---

### Task 10: Full validation and review

**Files:**
- Review all files changed by Tasks 1–9.

- [ ] **Step 1: Format and lint**

```bash
pnpm format:fix
pnpm lint
```

Expected: formatter completes and lint reports no errors.

- [ ] **Step 2: Run clean type-check and unit suite**

```bash
pnpm clean
pnpm check
pnpm test:unit
```

Expected: clean project build passes; unit suite has no package-export timeout.

- [ ] **Step 3: Run PostgreSQL integration/e2e suite**

```bash
RUN_TESTCONTAINERS=true pnpm test:integration
```

Expected: migrations 1–3 apply once under contention; job-state constraint tests, dedup parity tests, app integration tests, and e2e tests pass.

- [ ] **Step 4: Run package/build gates**

```bash
pnpm build
pnpm check:tfx:package
pnpm check:packed
pnpm check:packed:consumers
```

Expected: package exports remain private where intended and packed consumers compile.

- [ ] **Step 5: Inspect final diff for scope and migration immutability**

```bash
git status --short
git diff --check
git diff --stat
git diff -- packages/postgres/src/internal/Migration0001.ts packages/postgres/src/internal/Migration0002.ts
sha256sum packages/postgres/src/internal/Migration0003.ts
```

Expected:
- no whitespace errors;
- migrations 1 and 2 unchanged;
- migration 3 hash exactly matches `migrationChecksums[3]`;
- every changed file maps to this plan.

- [ ] **Step 6: Request code review**

Review specifically:

```text
1. Invalid retry policies cannot defect worker or write invalid runAt values.
2. Persistence retries preserve interruption and do not retry invariant/configuration errors.
3. Memory and PostgreSQL deduplicators reject same invalid timing values.
4. TypeScript and PostgreSQL job-state matrices agree.
5. Migration 3 normalizes only known legacy active-state outcomes.
6. Notification permanent failures cannot consume retry budget.
7. Effect.fn wrappers preserve all public service types.
8. Integration and package-export commands are stable under parallel execution.
```

Fix critical/important findings with follow-up commits; do not amend existing commits.

## Acceptance criteria

- Duplicated UUID regexes are removed; application and PostgreSQL row boundaries use shared RFC UUID schemas while preserving nil/max rejection.
- PostgreSQL bigint and timestamp normalization is schema-backed; manual checks remain only for cross-field, computed, or contextual invariants.
- Retry, polling, deduplication, and worker boundaries normalize `Duration.Input` once and retain `Duration.Duration` internally.
- `Job.retry` rejects invalid explicit durations; arbitrary custom retry callbacks cannot defect `JobRuntime` or write invalid instants.
- Duplicate job declaration names fail before layer acquisition.
- Polling timeout is a duration from 1 through 50 seconds, limit is integer `1..100`, and retry delay is a finite positive duration.
- Memory cleanup reaches entries beyond first 16 and released entries are removed immediately.
- Memory and PostgreSQL deduplicators return typed `InvariantViolation` failures unless lease, wait, heartbeat, and retention values are finite positive durations.
- Job status, lease phase/expiry, and outcome combinations are checked by both decoder and PostgreSQL migration 3.
- Repository persistence failures retry; invariant/not-found/conflict notification failures become permanent.
- Transient `JobStoreError('PersistenceFailure')` uses bounded exponential/jittered retry bursts without stopping Telegram runtime; non-transient failures still surface.
- Listed high-value workflows have stable `Effect.fn` names.
- App-local integration command discovers nested integration/e2e suites.
- Package export tests remain green under repeated parallel unit runs.
- Format, lint, clean type-check, unit, integration/e2e, build, and package gates pass.

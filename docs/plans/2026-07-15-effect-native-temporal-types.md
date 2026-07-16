# Effect-Native Temporal Types Implementation Plan

**Goal:** Replace ambiguous epoch-millisecond and duration-millisecond numbers with `DateTime.Utc` and `Duration.Duration` across `tfx`, PostgreSQL adapters, and Carneloot consumers.

**Architecture:** `tfx` owns Effect-native temporal contracts: absolute instants are `DateTime.Utc`, elapsed intervals are `Duration.Duration`, and counters/IDs remain numbers. Memory implementations use DateTime/Duration arithmetic directly. PostgreSQL keeps existing `timestamptz` and bigint/JSON encodings, converting only at adapter boundaries. Carneloot migrates after `tfx` so no compatibility layer or mixed temporal arithmetic remains.

**Tech Stack:** Effect v4 beta.98 (`DateTime`, `Duration`, `Schema`), TypeScript 7, Vitest 4, PostgreSQL 17, `@effect/sql-pg`, pnpm.

---

## Relationship to reliability hardening

This plan is a prerequisite for `docs/plans/2026-07-15-effect-reliability-hardening.md`. Do not implement number-based retry, lease, timestamp, or polling-delay snippets from that plan first. After this migration lands, rebase reliability tasks onto `DateTime.Utc` and `Duration.Duration` in Task 12.

Because this is a workspace-wide breaking type migration, Tasks 1–10 remain uncommitted checkpoints. Focused tests and package-local builds guide each slice, but the first commit occurs only in Task 11 after `pnpm check` is green across `tfx`, `@tfx/postgres`, and Carneloot. This avoids knowingly broken intermediate commits without adding temporary number overloads.

## Temporal model

### Use `DateTime.Utc`

- conversation expiry
- job `runAt`, lease expiry, retry instant, creation/update instants
- deduplication lease/retention/completion instants
- Carneloot user/pet/food/notification lifecycle instants
- repository `now` arguments and day-window boundaries

### Use `Duration.Duration`

- conversation idle timeout
- job retry delay and backoff
- job/dedup lease and heartbeat intervals
- dedup wait timeout and retention
- Telegram long-poll timeout and polling retry delay
- worker idle delay
- reminder delay
- notification retry/lease delays

### Keep numbers

- IDs, versions, attempts, generations, capacities, concurrency, limits
- Telegram payload timestamps until decoded at Telegram/domain boundary
- persisted duration encoding in bigint/JSON, converted with Schema codecs

### Option and boundary rules

Configuration-facing constructors/layers accept `Duration.Input` so callers may use `"10 seconds"`, `Duration.seconds(10)`, or other Effect duration inputs. Normalize exactly once during construction; stored domain values, service interfaces, and implementation state use `Duration.Duration` only.

```ts
const normalizeDuration = (
	input: Duration.Input,
	name: string,
): Duration.Duration =>
	Option.match(Duration.fromInput(input), {
		onNone: () => {
			throw new TypeError(`${name} is not a valid Duration input`);
		},
		onSome: (duration) => duration,
	});
```

Do not repeatedly call `Duration.fromInput` inside loops or persistence methods.

```ts
// Effect clock
const now: DateTime.Utc = yield* DateTime.now;

// Arithmetic
const expiresAt = DateTime.addDuration(now, leaseDuration);
const elapsed = DateTime.distance(startedAt, now);

// SQL timestamptz
const sqlDate = DateTime.toDateUtc(now);

// Persisted millis
const millis = Duration.toMillis(duration);

// Telegram protocol seconds — conversion only at request construction
const timeoutSeconds = Duration.toSeconds(longPollTimeout);
```

No SQL column type migration is required.

## File map

### `tfx` contracts and runtime

- Modify: `packages/tfx/src/ErrorSchema.ts`
- Modify: `packages/tfx/src/Conversation.ts`
- Modify: `packages/tfx/src/ConversationStorage.ts`
- Modify: `packages/tfx/src/Conversations.ts`
- Modify: `packages/tfx/src/MemoryConversationStorage.ts`
- Modify: `packages/tfx/src/Job.ts`
- Modify: `packages/tfx/src/JobOutcome.ts`
- Modify: `packages/tfx/src/JobStore.ts`
- Modify: `packages/tfx/src/JobRuntime.ts`
- Modify: `packages/tfx/src/MemoryJobStore.ts`
- Modify: `packages/tfx/src/UpdateDeduplicator.ts`
- Modify: `packages/tfx/src/MemoryUpdateDeduplicator.ts`
- Modify: `packages/tfx/src/BotRuntime.ts`
- Modify: `packages/tfx/src/Polling.ts`
- Modify: `packages/tfx/src/internal/runtime/Dispatcher.ts`
- Modify: `packages/tfx/src/internal/runtime/DeduplicatedDispatch.ts`
- Modify: `packages/tfx/src/internal/update-source/PollingSource.ts`

### PostgreSQL adapter

- Modify: `packages/postgres/src/internal/RowValidation.ts`
- Modify: `packages/postgres/src/PostgresConversationStorage.ts`
- Modify: `packages/postgres/src/PostgresJobStore.ts`
- Modify: `packages/postgres/src/PostgresUpdateDeduplicator.ts`

### Carneloot

- Modify: `apps/carneloot-bot/src/Config.ts`
- Modify: `apps/carneloot-bot/src/Layers.ts`
- Modify: `apps/carneloot-bot/src/domain/{User.ts,Pet.ts}`
- Modify: `apps/carneloot-bot/src/domain/pet-food/{PetFood.ts,FoodDateTime.ts,DayBoundary.ts}`
- Modify: `apps/carneloot-bot/src/domain/notifications/{NotificationEvent.ts,NotificationDelivery.ts,DeliveryOutcome.ts}`
- Modify: `apps/carneloot-bot/src/ports/{PetFoodRepository.ts,NotificationRepository.ts,ReminderScheduler.ts}`
- Modify: `apps/carneloot-bot/src/postgres/{UserRepositoryLive.ts,PetRepositoryLive.ts,PetFoodRepositoryLive.ts,NotificationRepositoryLive.ts,ReminderSchedulerLive.ts}`
- Modify: affected application, job, bot, conversation, demo, and production wiring files

### Tests/docs/release

- Modify: tfx unit/conformance/type tests touching temporal fields
- Modify: postgres unit/integration tests touching temporal fields
- Modify: Carneloot unit/integration/e2e tests touching temporal fields
- Modify: `docs/specs/2026-07-14-tfx-carneloot-design.md`
- Modify: `docs/plans/2026-07-15-effect-reliability-hardening.md`
- Create: `.changeset/effect-native-temporal-types.md`

---

## Tasks

### Task 1: Lock Effect-native public contracts with type tests

**Files:**
- Modify: `packages/tfx/type-test/Job.tst.ts`
- Modify: `packages/tfx/type-test/Declaration.tst.ts` if conversation declarations are covered there
- Modify: `packages/tfx/src/{ErrorSchema.ts,Conversation.ts,ConversationStorage.ts,Job.ts,JobOutcome.ts,JobStore.ts,UpdateDeduplicator.ts,BotRuntime.ts}`

- [ ] **Step 1: Add compile-time temporal assertions**

Add imports:

```ts
import type * as DateTime from 'effect/DateTime';
import type * as Duration from 'effect/Duration';
```

Add assignments that must compile after migration:

```ts
declare const jobRecord: JobRecord;
const runAt: DateTime.Utc = jobRecord.runAt;
const leaseExpiresAt: DateTime.Utc | undefined = jobRecord.leaseExpiresAt;
const createdAt: DateTime.Utc = jobRecord.createdAt;
const updatedAt: DateTime.Utc = jobRecord.updatedAt;

declare const retryDecision: RetryDecision;
if (retryDecision._tag === 'Retry') {
	const retryAfter: Duration.Duration | undefined = retryDecision.retryAfter;
	void retryAfter;
}

declare const conversation: Conversation.Conversation<
	any,
	any,
	any,
	any,
	any,
	any
>;
const idleTimeout: Duration.Duration | undefined = conversation.idleTimeout;
void idleTimeout;
```

Add `// @ts-expect-error` number assignments to prohibit regression:

```ts
// @ts-expect-error epoch numbers are not job instants
const invalidRunAt: number = jobRecord.runAt;
// @ts-expect-error duration millis are not retry durations
const invalidRetryAfter: number | undefined =
	retryDecision._tag === 'Retry' ? retryDecision.retryAfter : undefined;
```

- [ ] **Step 2: Run type-check and verify failures**

```bash
pnpm check
```

Expected: type tests fail because current public contracts use numbers.

- [ ] **Step 3: Change public contract types atomically**

Use exact contract shapes:

```ts
// Conversation.ts runtime declaration
readonly idleTimeout: Duration.Duration | undefined;
// Constructor Options
readonly idleTimeout?: Duration.Input;
```

```ts
// ConversationStorage.ts
readonly expiresAt: DateTime.Utc | undefined;
// Persist mutation
readonly expiresAt?: DateTime.Utc;
```

```ts
// Job.ts
export type RetryDecision =
	| { readonly _tag: 'Retry'; readonly retryAfter?: Duration.Duration }
	| { readonly _tag: 'Permanent' };
readonly schedule: (attempt: number) => Duration.Duration;
// Options.schedule has same return type
```

```ts
// JobOutcome.ts
readonly retryAfter?: Duration.Duration;
```

```ts
// JobStore.ts
readonly runAt: DateTime.Utc;
readonly leaseExpiresAt?: DateTime.Utc;
readonly createdAt: DateTime.Utc;
readonly updatedAt: DateTime.Utc;

export interface ScheduleRequest {
	readonly runAt: DateTime.Utc;
	readonly now: DateTime.Utc;
}
```

`JobRuntime.runOne` accepts configuration inputs and normalizes once per invocation:

```ts
readonly runOne: (options?: {
	readonly leaseDuration?: Duration.Input;
	readonly heartbeatInterval?: Duration.Input;
}) => Effect.Effect<JobRecord | undefined, JobRuntimeError>;
```

Every lower-level JobStore method receives `DateTime.Utc` for `now`/`retryAt` and normalized `Duration.Duration` for lease duration:

```ts
readonly claimForMigration: (
	now: DateTime.Utc,
	leaseDuration: Duration.Duration,
) => Effect.Effect<Claim | undefined, JobStoreError>;

readonly finalize: (
	token: ClaimToken,
	outcome: JobOutcome,
	now: DateTime.Utc,
	retryAt?: DateTime.Utc,
) => Effect.Effect<boolean, JobStoreError>;
```

```ts
// UpdateDeduplicator.ts
readonly claim: (
	updateId: number,
	options?: {
		readonly leaseDuration?: Duration.Duration;
		readonly waitTimeout?: Duration.Duration;
	},
) => Effect.Effect<Claim, UpdateDeduplicatorError>;
readonly heartbeat: (
	token: ClaimToken,
	leaseDuration?: Duration.Duration,
) => Effect.Effect<boolean, UpdateDeduplicatorError>;
readonly complete: (
	token: ClaimToken,
	outcome: CompletedOutcome,
	retention?: Duration.Duration,
) => Effect.Effect<boolean, UpdateDeduplicatorError>;
```

```ts
// BotRuntime.ts public layer Options
readonly leaseDuration?: Duration.Input;
readonly waitTimeout?: Duration.Input;
readonly retention?: Duration.Input;
readonly heartbeatInterval?: Duration.Input;
```

Normalize BotRuntime options once during layer construction into an internal object whose fields are `Duration.Duration`; `Dispatcher` and `UpdateDeduplicator` never receive `Duration.Input`.

Add a structural service-free error schema so JobRuntime can encode declared errors without hidden Effect requirements:

```ts
export type ServiceFreeErrorSchema = ErrorSchema & {
	readonly EncodingServices: never;
};

type HasServiceFreeEncoding<S extends ErrorSchema> =
	[Schema.Codec.EncodingServices<S>] extends [never] ? true : false;

export type ServiceFreeValid<S extends ErrorSchema> =
	HasServiceFreeEncoding<S> extends true ? Valid<S> : never;
```

Keep general `Valid` unchanged for conversations and middleware. Change `Job`/`Job.Options`/related job generics from `ES extends ErrorSchema.ErrorSchema` to `ES extends ErrorSchema.ServiceFreeErrorSchema`, and require `error: ErrorSchema.ServiceFreeValid<ES>` in `Job.make`. Existing tagged error schemas remain valid; an error schema requiring encoding services becomes a compile-time error. The generic bound lets `Schema.encodeSync(declaration.error)` compile inside JobRuntime.

Do not add parallel number overloads. Numeric milliseconds are accepted only where an option is explicitly `Duration.Input`, then normalized immediately. Workspace packages are unreleased `0.0.0`; one clean break prevents dual stored representations.

- [ ] **Step 4: Run type-check to obtain implementation worklist**

```bash
pnpm check 2>&1 | tee /tmp/effectloot-temporal-typecheck.log
```

Expected: public contract assertions pass; implementation and consumer errors identify every remaining numeric temporal use.

- [ ] **Step 5: Keep contract break as an uncommitted checkpoint**

```bash
git diff --check
git status --short
```

Expected: only temporal migration files are modified. Do not commit while implementations/consumers remain red.

---

### Task 2: Migrate conversations to DateTime and Duration

**Files:**
- Modify: `packages/tfx/src/{Conversation.ts,Conversations.ts,MemoryConversationStorage.ts}`
- Modify: `packages/tfx/test/{Conversation.test.ts,MemoryConversationStorage.test.ts}`
- Modify: `packages/tfx/test/internal/ConversationStorageConformance.ts`

- [ ] **Step 1: Update conversation fixtures first**

Replace duration millis:

```ts
idleTimeout: Duration.seconds(1),
```

Replace expiry epochs:

```ts
expiresAt: DateTime.makeUnsafe(1_000),
```

Use `DateTime.Equivalence` for instant equality and `Duration.equals` for duration equality. Keep `TestClock.adjust(Duration.millis(...))` or string duration inputs.

- [ ] **Step 2: Run conversation tests and verify implementation failures**

```bash
pnpm exec vitest run packages/tfx/test/Conversation.test.ts packages/tfx/test/MemoryConversationStorage.test.ts
```

Expected: compile/runtime failures at numeric addition and comparison sites.

- [ ] **Step 3: Normalize and validate idle timeout in constructor**

Normalize `Duration.Input` once, then use Effect Duration guards:

```ts
const idleTimeout =
	options.idleTimeout === undefined
		? undefined
		: normalizeDuration(options.idleTimeout, 'idleTimeout');
if (
	idleTimeout !== undefined &&
	(!Duration.isFinite(idleTimeout) || !Duration.isPositive(idleTimeout))
)
	throw new TypeError('idleTimeout must be finite and positive');
```

Store normalized `idleTimeout` on the returned conversation declaration.

Keep version, initial-step, and migration-history checks unchanged.

- [ ] **Step 4: Replace clock and expiry arithmetic**

In `Conversations.start` and `resume`:

```ts
const now = yield* DateTime.now;
const expiresAt =
	built.declaration.idleTimeout === undefined
		? undefined
		: DateTime.addDuration(now, built.declaration.idleTimeout);
```

In memory storage, replace numeric comparisons:

```ts
const expired =
	row.expiresAt !== undefined &&
	DateTime.isLessThanOrEqualTo(row.expiresAt, now);
```

Obtain `now` with `DateTime.now`, not `Clock.currentTimeMillis`.

- [ ] **Step 5: Run focused tests and checkpoint**

```bash
pnpm exec vitest run packages/tfx/test/Conversation.test.ts packages/tfx/test/MemoryConversationStorage.test.ts
git diff --check
git status --short
```

Expected: conversation tests pass. Do not run workspace `pnpm check` or commit until all consumers migrate.

---

### Task 3: Migrate job declarations, outcomes, runtime, and memory store

**Files:**
- Modify: `packages/tfx/src/{Job.ts,JobOutcome.ts,JobRuntime.ts,MemoryJobStore.ts}`
- Modify: `packages/tfx/test/{Job.test.ts,JobRuntime.test.ts,MemoryJobStore.test.ts}`
- Modify: `packages/tfx/test/internal/JobStoreConformance.ts`

- [ ] **Step 1: Convert job tests and conformance fixtures**

Use:

```ts
const epoch = DateTime.makeUnsafe(0);
const lease = Duration.millis(100);
const retryAfter = Duration.millis(100);
```

Expected assertions:

```ts
expect(Duration.equals(job.schedule(1), Duration.seconds(1))).toBe(true);
expect(
	DateTime.Equivalence(record.runAt, DateTime.makeUnsafe(100)),
).toBe(true);
```

- [ ] **Step 2: Run focused tests and capture failures**

```bash
pnpm exec vitest run packages/tfx/test/Job.test.ts packages/tfx/test/JobRuntime.test.ts packages/tfx/test/MemoryJobStore.test.ts
```

Expected: failures at default backoff, clock reads, arithmetic, sorting, and comparisons.

- [ ] **Step 3: Make job policies Duration-native**

```ts
schedule:
	options.schedule ??
	((attempt) =>
		Duration.millis(
			Math.min(60_000, 1_000 * 2 ** (attempt - 1)),
		)),
```

Validate policy output without converting to millis:

```ts
const validRetryDuration = (value: Duration.Duration): boolean =>
	Duration.isFinite(value) && !Duration.isNegative(value);
```

`Job.retry()` accepts `Duration.Input | undefined`, normalizes immediately, and stores `Duration.Duration` in `RetryDecision`. `JobRuntime` catches thrown policy callbacks, rejects invalid/infinite/negative durations, and computes:

```ts
const retryAt = DateTime.addDuration(finishedAt, retryAfter);
const sqlDate = DateTime.toDateUtc(retryAt);
if (!Number.isFinite(sqlDate.getTime()))
	return yield* invalidRetryPolicy;
```

- [ ] **Step 4: Normalize JobRuntime options, then replace clocks/arithmetic**

Normalize `leaseDuration`/`heartbeatInterval` from `Duration.Input` at start of `runOne`; validate finite positive values and heartbeat less than lease. Use `DateTime.now` for claim, promotion, finish, cancellation, and release instants. Pass `Duration.Duration` directly into `Effect.sleep` heartbeat monitor.

```ts
const claimNow = yield* DateTime.now;
const monitor = Effect.suspend(() =>
	Effect.andThen(
		Effect.sleep(heartbeatInterval),
		Effect.gen(function* () {
			const current = yield* store.get(running.id);
			if (current?.cancellationRequested)
				return yield* Effect.fail(new CancelSignal());
			const heartbeatNow = yield* DateTime.now;
			if (!(yield* store.heartbeat(claim.token, heartbeatNow, leaseDuration)))
				return yield* Effect.fail(new LeaseSignal());
			return yield* monitor;
		}),
	),
);
```

- [ ] **Step 5: Replace MemoryJobStore temporal representation**

Use `DateTime.addDuration` for lease expiry and `DateTime` comparison APIs for due/expired checks. Sort with `DateTime.Order`:

```ts
.sort(
	(a, b) =>
		DateTime.Order(a.runAt, b.runAt) ||
		DateTime.Order(a.createdAt, b.createdAt),
)
```

Examples:

```ts
DateTime.isLessThanOrEqualTo(row.runAt, now)
DateTime.isLessThanOrEqualTo(row.leaseExpiresAt, now)
DateTime.addDuration(now, leaseDuration)
```

Do not use `DateTime.toEpochMillis` for business arithmetic.

- [ ] **Step 6: Keep JobOutcome runtime-native**

```ts
export const retryableFailure = <E>(
	error: E,
	retryAfter?: Duration.Duration,
): JobOutcome<E> =>
	Object.freeze({
		_tag: 'RetryableFailure',
		error,
		...(retryAfter === undefined ? {} : { retryAfter }),
	});
```

Before constructing a persisted outcome, `JobRuntime` must encode the declaration error with its own schema:

```ts
class InvalidJobError extends Data.TaggedError('InvalidJobError')<{
	readonly cause: unknown;
}> {}

const encoded = yield* Effect.result(
	Effect.try({
		try: () => Schema.encodeSync(declaration.error)(failure.value),
		catch: (cause) => new InvalidJobError({ cause }),
	}),
);
if (encoded._tag === 'Failure') {
	yield* store.finalize(
		claim.token,
		JobOutcome.fatalFailure('Invalid job error encoding'),
		finishedAt,
	);
	return yield* store.get(running.id);
}
const encodedError = encoded.success;
```

Use raw `failure.value` for `declaration.retry(...)`, then use `encodedError` in `JobOutcome.retryableFailure` / `permanentFailure`. This ensures nested domain fields such as `FeedingReminderRetryError.retryAfter: Duration.Duration` are encoded by their declaration schema before either memory or PostgreSQL storage sees them. Add a JobRuntime test whose error schema uses `Schema.DurationFromMillis` and assert stored `outcome.error.retryAfter === 100` while retry policy received a Duration.

- [ ] **Step 7: Run job suite and checkpoint**

```bash
pnpm exec vitest run packages/tfx/test/Job.test.ts packages/tfx/test/JobRuntime.test.ts packages/tfx/test/MemoryJobStore.test.ts
git diff --check
git status --short
```

Expected: job tests pass; workspace consumers remain intentionally uncommitted until migrated.

---

### Task 4: Migrate deduplication, bot runtime, and polling retry delay

**Files:**
- Modify: `packages/tfx/src/{UpdateDeduplicator.ts,MemoryUpdateDeduplicator.ts,BotRuntime.ts,Polling.ts}`
- Modify: `packages/tfx/src/internal/runtime/{Dispatcher.ts,DeduplicatedDispatch.ts}`
- Modify: `packages/tfx/src/internal/update-source/PollingSource.ts`
- Modify: `packages/tfx/test/{UpdateDeduplicator.test.ts,BotRuntime.test.ts,Polling.test.ts}`
- Modify: `packages/tfx/test/internal/DeduplicatorConformance.ts`

- [ ] **Step 1: Convert option and conformance fixtures**

```ts
leaseDuration: '30 seconds',
waitTimeout: '5 seconds',
retention: '1 day',
heartbeatInterval: '10 seconds',
timeout: '30 seconds',
retryDelay: '1 second',
```

Keep only `limit: 100` numeric. Long-poll timeout is Duration in tfx and converts to integer seconds at Telegram request construction.

- [ ] **Step 2: Run focused tests and verify numeric assumptions fail**

```bash
pnpm exec vitest run packages/tfx/test/UpdateDeduplicator.test.ts packages/tfx/test/BotRuntime.test.ts packages/tfx/test/Polling.test.ts
```

Expected: failures at duration validation, lease arithmetic, timeout comparisons, and polling sleep.

- [ ] **Step 3: Validate durations with Duration guards**

Public `BotRuntime`/`Polling` options normalize `Duration.Input` once. Internal `Dispatcher`, `DeduplicatedDispatch`, and `UpdateDeduplicator` signatures stay `Duration.Duration`. Use one file-local validator after normalization:

```ts
const finitePositive = (value: Duration.Duration): boolean =>
	Duration.isFinite(value) && Duration.isPositive(value);
```

Keep heartbeat/lease relationship explicit:

```ts
if (!Duration.isLessThan(heartbeatInterval, leaseDuration))
	return yield* Effect.die(
		new Error('heartbeatInterval must be less than leaseDuration'),
	);
```

- [ ] **Step 4: Migrate memory dedup instants**

```ts
interface Row {
	generation: number;
	leaseExpiresAt: DateTime.Utc;
	completed?: CompletedOutcome;
	retentionUntil?: DateTime.Utc;
	completion: Deferred.Deferred<ObservedCompletion>;
	released: boolean;
}
```

Use `DateTime.now`, `DateTime.addDuration`, and DateTime comparisons. Pass `waitTimeout` directly to `Effect.sleep`.

- [ ] **Step 5: Migrate dispatch heartbeat**

`Dispatcher` and `DeduplicatedDispatch` forward `Duration.Duration` unchanged. Defaults use constructors:

```ts
const leaseDuration = options.leaseDuration ?? Duration.seconds(30);
const heartbeatInterval =
	options.heartbeatInterval ??
	Duration.millis(
		Math.max(1, Math.floor(Duration.toMillis(leaseDuration) / 3)),
	);
```

This conversion is allowed only for deriving a duration, not for instant arithmetic.

- [ ] **Step 6: Migrate polling timeout and retry delay**

Change public options to inputs and define an internal normalized options type:

```ts
export interface PollingOptions {
	readonly timeout?: Duration.Input;
	readonly retryDelay?: Duration.Input;
	// unchanged limit/allowedUpdates/commands fields
}
interface NormalizedPollingOptions extends Omit<
	PollingOptions,
	'timeout' | 'retryDelay'
> {
	readonly timeout: Duration.Duration;
	readonly retryDelay: Duration.Duration;
}
```

Normalize in `Polling.make`, then pass `NormalizedPollingOptions` to `PollingSource`. Validate timeout as finite, positive, whole seconds from 1 through 50:

```ts
const timeout = normalizeDuration(
	options.timeout ?? '30 seconds',
	'timeout',
);
const timeoutSeconds = Duration.toSeconds(timeout);
if (
	!Duration.isFinite(timeout) ||
	!Number.isSafeInteger(timeoutSeconds) ||
	timeoutSeconds < 1 ||
	timeoutSeconds > 50
)
	throw new TypeError(
		'Polling timeout must be a whole-second Duration between 1 and 50 seconds',
	);
```

`PollingSource` sends only the converted protocol scalar:

```ts
telegram.getUpdates({
	// ...offset, limit, allowed_updates
	timeout: timeoutSeconds,
});
```

Rate-limit conversion returns provider Duration directly:

```ts
const retryDelay = (
	error: TelegramError,
	fallback: Duration.Duration,
): Duration.Duration | undefined =>
	error.reason._tag === 'RateLimitError'
		? error.reason.retryAfter
		: fallback;
```

Normalize retry default from `options.retryDelay ?? '1 second'`; `Effect.sleep(delay)` receives the normalized Duration. Add boundary tests rejecting sub-second, fractional-second, zero, infinite, and over-50-second long-poll timeouts while asserting `Duration.seconds(30)` is encoded as Telegram `timeout: 30`.

- [ ] **Step 7: Validate complete tfx slice and checkpoint**

```bash
pnpm exec vitest run packages/tfx/test
pnpm exec tsc -b packages/tfx/tsconfig.json --pretty false
git diff --check
git status --short
```

Expected: `tfx` tests and package-local build pass. Root workspace remains uncommitted until PostgreSQL and Carneloot consumers migrate.

---

### Task 5: Introduce PostgreSQL DateTime and Duration codecs

**Files:**
- Modify: `packages/postgres/src/internal/RowValidation.ts`
- Create or modify: `packages/postgres/test/RowValidation.test.ts`

- [ ] **Step 1: Write codec tests**

```ts
import { DateTime, Duration, Schema } from 'effect';

it('decodes PostgreSQL timestamps to UTC DateTime', () => {
	const instant = '2024-01-02T03:04:05.000Z';
	const decode = Schema.decodeUnknownSync(Timestamp);
	for (const input of [new Date(instant), instant, Date.parse(instant)])
		expect(DateTime.formatIso(decode(input))).toBe(instant);
	for (const invalid of ['bad', Number.NaN, new Date(Number.NaN)])
		expect(() => decode(invalid)).toThrow();
});

it('round-trips persisted duration millis', () => {
	const decode = Schema.decodeUnknownSync(DurationMillis);
	const encode = Schema.encodeSync(DurationMillis);
	const duration = decode(1_500);
	expect(Duration.toMillis(duration)).toBe(1_500);
	expect(encode(duration)).toBe(1_500);
});
```

- [ ] **Step 2: Implement UTC timestamp schema**

```ts
export const Timestamp = Schema.Union([
	Schema.DateTimeUtcFromDate,
	Schema.DateTimeUtcFromString,
	Schema.DateTimeUtcFromMillis,
]);
export const NullableTimestamp = Schema.NullOr(Timestamp);
```

All branches decode to `DateTime.Utc` and reject invalid input through `DateValid`/`DateTime.make`.

- [ ] **Step 3: Implement persisted duration schema**

```ts
export const DurationMillis = Schema.DurationFromMillis.check(
	Schema.makeFilter(
		(value) => Duration.isFinite(value) && !Duration.isNegative(value),
		{ message: 'Expected a finite non-negative duration' },
	),
);
```

For strictly positive lease/timeout values, define:

```ts
export const PositiveDurationMillis = Schema.DurationFromMillis.check(
	Schema.makeFilter(
		(value) => Duration.isFinite(value) && Duration.isPositive(value),
		{ message: 'Expected a finite positive duration' },
	),
);
```

- [ ] **Step 4: Encode JobOutcome retry duration explicitly**

Change persisted `JobOutcome` schema field:

```ts
retryAfter: Schema.optionalKey(DurationMillis),
```

Before `sql.json(outcome)`, encode through schema:

```ts
const encodedOutcome = yield* Schema.encodeEffect(JobOutcomeSchema)(outcome).pipe(
	Effect.mapError((cause) => invariant('Invalid job outcome', cause)),
);
```

Use `sql.json(encodedOutcome)`. This preserves existing JSON `{ retryAfter: number }` while runtime `JobOutcome` contains Duration.

- [ ] **Step 5: Run codec tests and checkpoint**

```bash
pnpm exec vitest run packages/postgres/test/RowValidation.test.ts
git diff --check
git status --short
```

Expected: codec tests pass. Keep changes uncommitted until adapters and consumers compile.

---

### Task 6: Migrate PostgreSQL adapters without changing SQL schema

**Files:**
- Modify: `packages/postgres/src/{PostgresConversationStorage.ts,PostgresJobStore.ts,PostgresUpdateDeduplicator.ts}`
- Modify: `packages/postgres/test/{ConversationStorage.integration.test.ts,JobStore.integration.test.ts,Deduplicator.integration.test.ts}`

- [ ] **Step 1: Convert integration/conformance fixtures**

Use `DateTime.makeUnsafe(...)` for instants and `Duration.millis(...)` for durations. Keep raw SQL `timestamptz` assertions unchanged.

- [ ] **Step 2: Run integration tests and verify adapter failures**

```bash
RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts packages/postgres/test/ConversationStorage.integration.test.ts packages/postgres/test/JobStore.integration.test.ts packages/postgres/test/Deduplicator.integration.test.ts
```

Expected: type errors and failures at `new Date(...)`, numeric comparisons, and arithmetic.

- [ ] **Step 3: Decode rows directly to DateTime**

Use `Timestamp`/`NullableTimestamp` in row schemas. Return decoded values directly in service records; do not call `.getTime()` or `DateTime.toEpochMillis`.

- [ ] **Step 4: Add one SQL conversion helper**

```ts
const sqlDate = (instant: DateTime.Utc): Date =>
	DateTime.toDateUtc(instant);
```

Replace every `new Date(instant)` with `sqlDate(instant)`. Replace `new Date(now + duration)` with:

```ts
sqlDate(DateTime.addDuration(now, duration))
```

- [ ] **Step 5: Replace comparisons and elapsed checks**

```ts
DateTime.isLessThanOrEqualTo(row.leaseExpiresAt, now)
DateTime.isLessThanOrEqualTo(row.runAt, now)
Duration.isGreaterThanOrEqualTo(DateTime.distance(started, now), waitTimeout)
```

For dedup observation pacing:

```ts
Effect.sleep(Duration.min(Duration.millis(50), waitTimeout))
```

- [ ] **Step 6: Preserve encoded JSON compatibility**

Decode legacy numeric `retryAfter` through `DurationMillis`; encode all new outcomes through same schema before `sql.json`. Add integration assertion:

```ts
expect(
	rows[0]?.outcome_json.retryAfter,
).toBe(100);
```

while runtime assertion uses:

```ts
expect(Duration.toMillis(record.outcome.retryAfter)).toBe(100);
```

- [ ] **Step 7: Run adapters and checkpoint**

```bash
RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts packages/postgres/test/ConversationStorage.integration.test.ts packages/postgres/test/JobStore.integration.test.ts packages/postgres/test/Deduplicator.integration.test.ts packages/postgres/test/Layers.integration.test.ts
pnpm exec tsc -b packages/tfx/tsconfig.json packages/postgres/tsconfig.json --pretty false
git diff --check
git status --short
```

Expected: tfx and PostgreSQL package-local builds/tests pass. Keep workspace migration uncommitted.

---

### Task 7: Validate `tfx` as an Effect-native package

**Files:**
- Modify: remaining `packages/tfx/test/**/*.ts`
- Modify: `packages/tfx/type-test/**/*.tst.ts`
- Modify: `packages/tfx/src` only where numeric temporal residue remains

- [ ] **Step 1: Search production code for forbidden temporal patterns**

```bash
rg -n 'currentTimeMillis|new Date\(|Date\.now\(|\+\s*(leaseDuration|retryAfter|retention|idleTimeout)|:\s*number.*(Duration|Timeout|runAt|expiresAt|retryAt)' packages/tfx/src packages/postgres/src
```

Expected after Tasks 1–6:
- no `Clock.currentTimeMillis` in temporal workflows
- no instant-plus-duration numeric arithmetic
- `new Date` only absent or limited to non-temporal unrelated code
- only the Telegram request-local `timeoutSeconds` scalar remains numeric

- [ ] **Step 2: Run all tfx/postgres tests**

```bash
pnpm exec vitest run packages/tfx/test packages/postgres/test --exclude '**/*.integration.test.ts'
RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts packages/postgres/test
pnpm exec tsc -b packages/tfx/tsconfig.json packages/postgres/tsconfig.json --pretty false
```

Expected: package-local unit, conformance, type, integration, and build checks pass.

- [ ] **Step 3: Verify package declarations**

```bash
pnpm build
rg -n 'runAt: number|expiresAt: number|retryAfter\?: number|leaseDuration\?: number|idleTimeout\?: number' packages/tfx/dist packages/postgres/dist
```

Expected: no ambiguous temporal declarations. Protocol/counter numbers remain documented exceptions.

- [ ] **Step 4: Checkpoint package cleanup**

```bash
git diff --check
git status --short
```

Expected: only planned migration files are modified. Do not commit before Carneloot is green.

---

### Task 8: Migrate Carneloot domain models to DateTime and Duration

**Files:**
- Modify: `apps/carneloot-bot/src/domain/{User.ts,Pet.ts}`
- Modify: `apps/carneloot-bot/src/domain/pet-food/{PetFood.ts,FoodDateTime.ts,DayBoundary.ts}`
- Modify: `apps/carneloot-bot/src/domain/notifications/{NotificationEvent.ts,NotificationDelivery.ts,DeliveryOutcome.ts}`
- Modify: corresponding domain tests

- [ ] **Step 1: Convert domain test fixtures**

Use:

```ts
const instant = DateTime.makeUnsafe('2024-01-02T12:00:00Z');
const reminderDelay = Duration.minutes(30);
```

Compare with `DateTime.Equivalence`, `DateTime.formatIso`, `Duration.equals`, or `Duration.toMillis` only in assertions.

- [ ] **Step 2: Change domain schemas**

Absolute fields use `Schema.DateTimeUtc`:

```ts
createdAt: Schema.DateTimeUtc,
updatedAt: Schema.DateTimeUtc,
fedAt: Schema.DateTimeUtc,
scheduledFor: Schema.NullOr(Schema.DateTimeUtc),
```

Reminder delay uses a bounded Duration schema:

```ts
export const ReminderDelay = Schema.Duration.check(
	Schema.makeFilter(
		(value) => {
			const millis = Duration.toMillis(value);
			return (
				Number.isSafeInteger(millis) &&
				millis >= 1 &&
				millis <= Duration.toMillis(Duration.days(30))
			);
		},
		{ message: 'Reminder delay must be between 1ms and 30 days' },
	),
).annotate({ identifier: 'ReminderDelay' });
```

Rename `ReminderDelayMs` to `ReminderDelay`. Add boundary tests for zero, `1ms`, sub-millisecond Duration, `30 days`, and `30 days + 1ms`; only integral millisecond values from 1ms through 30 days pass. Update all imports in the atomic migration commit.

- [ ] **Step 3: Migrate day boundaries and parsing**

```ts
export interface Window {
	readonly start: DateTime.Utc;
	readonly end: DateTime.Utc;
}
```

`FoodDateTime.parse` returns `Effect.Effect<DateTime.Utc, ...>`. Use DateTime constructors/zone conversion; do not return epoch millis. `DayBoundary.current` accepts `DateTime.Utc` and compares DateTime values.

- [ ] **Step 4: Run domain tests and checkpoint**

```bash
pnpm exec vitest run apps/carneloot-bot/test/Ids.test.ts apps/carneloot-bot/test/PetName.test.ts apps/carneloot-bot/test/pet-food/DayBoundary.test.ts apps/carneloot-bot/test/pet-food/FoodDateTime.test.ts apps/carneloot-bot/test/pet-food/FoodAmount.test.ts apps/carneloot-bot/test/notifications/NotificationDomain.test.ts
git diff --check
git status --short
```

Expected: domain-focused tests pass. Application ports/workflows remain uncommitted until Tasks 9–11 finish.

---

### Task 9: Decode runtime config to Duration and migrate layer wiring

**Files:**
- Modify: `apps/carneloot-bot/src/{Config.ts,Layers.ts,Production.ts}`
- Modify: `apps/carneloot-bot/{.env.example,README.md}`
- Modify: `apps/carneloot-bot/test/{Config.test.ts,BotLayers.test.ts,NodeSmoke.test.ts}`

- [ ] **Step 1: Update config tests and environment names**

Use human-readable Effect duration strings:

```ts
POLLING_TIMEOUT: '30 seconds',
POLLING_RETRY_DELAY: '1 second',
JOB_IDLE: '100 millis',
JOB_LEASE: '30 seconds',
JOB_HEARTBEAT: '10 seconds',
DEDUP_LEASE: '30 seconds',
DEDUP_HEARTBEAT: '10 seconds',
DEDUP_WAIT: '5 seconds',
DEDUP_RETENTION: '1 day',
```

Assert decoded values:

```ts
expect(Duration.equals(config.jobIdle, Duration.millis(100))).toBe(true);
expect(Duration.equals(config.jobLease, Duration.seconds(30))).toBe(true);
expect(Duration.equals(config.dedupRetention, Duration.days(1))).toBe(true);
```

Rename service fields:

```text
pollingRetryDelayMillis → pollingRetryDelay
jobIdleMillis → jobIdle
jobLeaseMillis → jobLease
jobHeartbeatMillis → jobHeartbeat
 dedupLeaseMillis → dedupLease
 dedupHeartbeatMillis → dedupHeartbeat
 dedupWaitMillis → dedupWait
 dedupRetentionMillis → dedupRetention
```

Rename AppConfig service field `pollingTimeoutSeconds` to `pollingTimeout: Duration.Duration`; capacities and concurrency remain numeric. Update `.env.example` and README with the new names/units; do not retain misleading `_MILLIS`/`_SECONDS` aliases in this unreleased app.

- [ ] **Step 2: Read config with Effect's Duration parser**

Use `Config.duration`, which is the pinned shortcut for `Config.schema(Schema.DurationFromString, name)` and accepts values such as `"10 seconds"`:

```ts
pollingTimeout: Config.duration('POLLING_TIMEOUT'),
pollingRetryDelay: Config.duration('POLLING_RETRY_DELAY'),
jobIdle: Config.duration('JOB_IDLE'),
jobLease: Config.duration('JOB_LEASE'),
jobHeartbeat: Config.duration('JOB_HEARTBEAT'),
dedupLease: Config.duration('DEDUP_LEASE'),
dedupHeartbeat: Config.duration('DEDUP_HEARTBEAT'),
dedupWait: Config.duration('DEDUP_WAIT'),
dedupRetention: Config.duration('DEDUP_RETENTION'),
```

After `Config.all`, reject infinite, negative, and zero durations with Duration guards. For polling timeout additionally require whole seconds from 1 through 50. Keep redacted-secret checks and cross-field relations explicit.

- [ ] **Step 3: Replace numeric relations**

```ts
if (!Duration.isLessThan(value.jobHeartbeat, value.jobLease))
	return yield* invalidConfig(
		'JOB_HEARTBEAT must be less than JOB_LEASE',
	);
```

Use Duration comparisons for dedup heartbeat/wait/lease relationships.

- [ ] **Step 4: Pass Duration values directly through Layers**

```ts
const runtimeOptions = (config: AppConfigService, router: Router) => ({
	capacity: config.dispatchCapacity,
	concurrency: config.dispatchConcurrency,
	leaseDuration: config.dedupLease,
	waitTimeout: config.dedupWait,
	retention: config.dedupRetention,
	heartbeatInterval: config.dedupHeartbeat,
	router,
});
```

No `Duration.toMillis` belongs in application wiring.

- [ ] **Step 5: Run focused config tests and checkpoint**

```bash
pnpm exec vitest run apps/carneloot-bot/test/Config.test.ts apps/carneloot-bot/test/BotLayers.test.ts apps/carneloot-bot/test/NodeSmoke.test.ts
git diff --check
git status --short
```

Expected: focused tests pass where their consumer graph has migrated; keep all app changes uncommitted.

---

### Task 10: Migrate Carneloot ports and PostgreSQL adapters

**Files:**
- Modify: `apps/carneloot-bot/src/ports/{PetFoodRepository.ts,NotificationRepository.ts,ReminderScheduler.ts}`
- Modify: `apps/carneloot-bot/src/postgres/{UserRepositoryLive.ts,PetRepositoryLive.ts,PetFoodRepositoryLive.ts,NotificationRepositoryLive.ts,ReminderSchedulerLive.ts}`
- Modify: repository integration tests

- [ ] **Step 1: Change port signatures together**

Examples:

```ts
readonly fedAt: DateTime.Utc;
readonly now: DateTime.Utc;
readonly runAt: DateTime.Utc;
readonly retryAt: DateTime.Utc | null;
readonly leaseDuration: Duration.Duration;
```

`NotificationRepository.claimNext` becomes:

```ts
readonly claimNext: (
	eventId: EventId,
	now: DateTime.Utc,
	leaseDuration: Duration.Duration,
) => Effect.Effect<DeliveryClaim | undefined, NotificationRepositoryError>;
```

Do not retain number overloads.

- [ ] **Step 2: Add application adapter codecs**

Create file-local or shared internal schemas:

```ts
const Timestamp = Schema.Union([
	Schema.DateTimeUtcFromDate,
	Schema.DateTimeUtcFromString,
	Schema.DateTimeUtcFromMillis,
]);
const NullableTimestamp = Schema.NullOr(Timestamp);
const DurationMillis = Schema.DurationFromMillis;
```

Use `DateTime.toDateUtc` for every `timestamptz` SQL parameter and `Duration.toMillis` only for `reminder_delay_ms` bigint.

- [ ] **Step 3: Preserve equality and dedupe semantics**

Replace object identity comparisons:

```ts
DateTime.Equivalence(existing.scheduledFor, input.scheduledFor)
```

Preserve reminder dedupe key encoding:

```ts
const runAtMillis = DateTime.toEpochMillis(request.runAt);
const baseDedupe = `feeding-reminder:${request.botId}:${request.petId}:${request.foodEntryId}:${runAtMillis}`;
```

This keeps existing numeric-key compatibility.

- [ ] **Step 4: Replace SQL instant arithmetic**

```ts
const leaseExpiresAt = DateTime.addDuration(now, leaseDuration);
```

Bind `DateTime.toDateUtc(now)` and `DateTime.toDateUtc(leaseExpiresAt)`. Do not add Duration millis to epoch numbers.

- [ ] **Step 5: Run repository tests and checkpoint**

```bash
RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts apps/carneloot-bot/test/IdentityPets.integration.test.ts apps/carneloot-bot/test/pet-food/PetFood.integration.test.ts apps/carneloot-bot/test/notifications/NotificationRepository.integration.test.ts apps/carneloot-bot/test/notifications/FeedingReminderScheduling.integration.test.ts
git diff --check
git status --short
```

Expected: repository-focused tests pass after their immediate consumers compile; keep workspace changes uncommitted.

---

### Task 11: Migrate Carneloot workflows, jobs, bot presentation, and tests

**Files:**
- Modify: affected files under `apps/carneloot-bot/src/application`, `src/jobs`, `src/bot`, `src/JobWorker.ts`, `src/demo-test.ts`
- Modify: remaining app unit/integration/e2e tests

- [ ] **Step 1: Reconcile concurrent AddFood work before editing**

```bash
git status --short apps/carneloot-bot/src/application/AddFood.ts
git diff -- apps/carneloot-bot/src/application/AddFood.ts
```

If modified, preserve/rebase that work first. Never overwrite it with stale plan snippets.

- [ ] **Step 2: Replace application clocks and arithmetic**

Use `DateTime.now`. Examples:

```ts
const now = yield* DateTime.now;
const runAt = DateTime.addDuration(entry.fedAt, settings.reminderDelay);
```

Notification retry:

```ts
const retryAt = DateTime.addDuration(now, disposition.delay);
const retryAfter = DateTime.distance(now, retryAt);
```

`JobWorker.layer` accepts `Duration.Input` for idle/lease/heartbeat options, normalizes once during layer acquisition, and passes `Duration.Duration` to `Effect.sleep`, `Schedule`, and `JobRuntime`.

- [ ] **Step 3: Update FeedingReminder errors/job policy**

`FeedingReminderRetryError.retryAfter` becomes a runtime Duration with numeric-millis encoding:

```ts
retryAfter: Schema.optionalKey(Schema.DurationFromMillis),
```

`JobRuntime` encodes declaration errors before constructing stored outcomes (Task 3), so raw `outcome_json.error.retryAfter` remains a number. Add a job integration test that decodes a legacy numeric retry error and inspects a newly written row for the same numeric shape.

```ts
schedule: (attempt) =>
	Duration.min(
		Duration.minutes(30),
		Duration.minutes(2 ** (attempt - 1)),
	),
```

- [ ] **Step 4: Update bot formatting**

Pass `DateTime.Utc` to presentation helpers. Convert only for locale rendering:

```ts
DateTime.toDateUtc(instant).toLocaleString('pt-BR', options)
```

Elapsed labels use `DateTime.distance` and Duration formatting/comparison.

- [ ] **Step 5: Update all remaining tests**

Fixtures use `DateTime.makeUnsafe` and Duration constructors. Keep `TestClock.setTime`/`adjust`; convert observed domain values with `DateTime.Equivalence`/`Duration.equals`.

```bash
pnpm exec vitest run apps/carneloot-bot/test --exclude '**/*.integration.test.ts' --exclude '**/*.e2e.test.ts'
RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts apps/carneloot-bot/test
pnpm check
```

Expected: all app unit, integration, and e2e tests pass with no numeric temporal contracts.

- [ ] **Step 6: Make the first atomic migration commit**

```bash
pnpm check
git diff --check
git add packages/tfx packages/postgres apps/carneloot-bot/src apps/carneloot-bot/test
git commit -m "refactor: adopt Effect-native temporal types"
```

Expected: root type-check and all focused suites are green before commit; no intermediate broken contract commit exists.

---

### Task 12: Documentation, reliability-plan rebase, release note, and final gates

**Files:**
- Modify: `docs/specs/2026-07-14-tfx-carneloot-design.md`
- Modify: `docs/plans/2026-07-15-effect-reliability-hardening.md`
- Create: `.changeset/effect-native-temporal-types.md`

- [ ] **Step 1: Document temporal decision**

Add design rule:

```markdown
- Runtime absolute instants use `DateTime.Utc`.
- Runtime elapsed intervals use `Duration.Duration`.
- Configuration-facing options accept `Duration.Input` and normalize once.
- Environment duration values use Effect strings such as `"10 seconds"` via `Config.duration`.
- PostgreSQL adapters alone convert `DateTime.Utc` to `Date`.
- Config/storage codecs alone convert Duration to/from milliseconds.
- IDs, counters, capacities, and protocol-native scalar units remain numbers.
```

- [ ] **Step 2: Rebase reliability plan**

Update every temporal snippet:

```text
number retry delay       → Duration.Input at option/helper boundary, normalized Duration.Duration internally
number lease/retention   → Duration.Input at config boundary, normalized Duration.Duration internally
polling timeout seconds  → Duration.Duration; convert with Duration.toSeconds only in Telegram request
number runAt/retryAt     → DateTime.Utc
Clock.currentTimeMillis  → DateTime.now
instant + duration       → DateTime.addDuration
instant subtraction      → DateTime.distance
new Date(instant)        → DateTime.toDateUtc
```

Delete Task 0's proposed `Date`-returning timestamp schema and reference this prerequisite plan's `DateTime.Utc` codec instead. Ensure no reliability task reintroduces number-millis APIs.

- [ ] **Step 3: Add changeset**

```markdown
---
"tfx": minor
"@tfx/postgres": minor
---

Adopt Effect-native `DateTime.Utc` and `Duration.Duration` temporal contracts while preserving PostgreSQL and JSON encodings.
```

- [ ] **Step 4: Run repository-wide forbidden-pattern checks**

```bash
rg -n 'currentTimeMillis|new Date\(|Date\.now\(' packages/tfx/src packages/postgres/src apps/carneloot-bot/src
rg -n '(runAt|expiresAt|retryAt|leaseDuration|retryAfter|idleTimeout)\??:\s*number' packages apps
```

Expected exceptions must be documented inline and limited to external protocol/storage DTOs. No application/domain/service temporal contract remains numeric.

- [ ] **Step 5: Run full gates**

```bash
pnpm format:fix
pnpm lint
pnpm clean
pnpm check
pnpm test:unit
RUN_TESTCONTAINERS=true pnpm test:integration
pnpm build
pnpm check:tfx:package
pnpm check:packed
pnpm check:packed:consumers
```

Expected: all gates pass.

- [ ] **Step 6: Inspect and test persistence compatibility**

Inventory every JSON persistence site:

```bash
rg -n 'sql\.json|payload_json|state_json|outcome_json|last_error_json|error_json|safe_error_json' packages apps
```

Add legacy/new round-trip fixtures covering:

```text
jobs.payload_json                     unchanged declaration payload encoding
jobs.outcome_json.retryAfter          numeric milliseconds
jobs.outcome_json.error.retryAfter    numeric milliseconds
job_attempts.error_json               same encoded outcome shape
conversation state_json               unchanged step-state encoding
notification safe_error_json          unchanged sanitized error shape
pet_food_settings.reminder_delay_ms   integral bigint milliseconds
reminder dedupe key suffix            epoch milliseconds
```

Run raw SQL assertions after runtime-level assertions. Then inspect migrations:

```bash
git diff -- packages/postgres/src/internal/Migration0001.ts packages/postgres/src/internal/Migration0002.ts apps/carneloot-bot/migrations
```

Expected: no SQL migration content changed solely for TypeScript temporal representation; legacy rows decode and new rows retain existing wire/storage shapes.

- [ ] **Step 7: Request code review**

Review specifically:

```text
1. tfx runtime temporal values are DateTime.Utc/Duration.Duration; only configuration option positions expose Duration.Input.
2. No mixed number/DateTime arithmetic or equality remains.
3. PostgreSQL timestamptz and duration-millis encodings remain backward compatible.
4. JobOutcome.retryAfter JSON remains numeric millis.
5. Polling timeout and retryDelay are Duration in tfx; only Telegram request timeout is integer seconds.
6. TestClock determinism and interruption behavior remain intact.
7. Reliability plan no longer proposes number-based temporal validation.
```

Fix critical/important findings with follow-up commits; never amend previous commits.

- [ ] **Step 8: Commit documentation and release metadata**

```bash
git add docs/specs/2026-07-14-tfx-carneloot-design.md docs/plans/2026-07-15-effect-native-temporal-types.md docs/plans/2026-07-15-effect-reliability-hardening.md .changeset/effect-native-temporal-types.md
git commit -m "docs: record Effect-native temporal model"
```

## Acceptance criteria

- `tfx` runtime contracts use `DateTime.Utc` for instants and `Duration.Duration` for normalized intervals.
- Configuration-facing constructors accept `Duration.Input`, including strings such as `"10 seconds"`, and normalize once.
- `tfx` production code contains no epoch-millisecond arithmetic.
- Memory stores use DateTime ordering/arithmetic and Duration sleeps.
- PostgreSQL adapters decode `timestamptz` to DateTime and bind only through `DateTime.toDateUtc`.
- Persisted top-level and declaration-error retry durations remain numeric milliseconds through explicit Schema encoding.
- Carneloot domain, ports, workflows, and config use Effect temporal types.
- Database schemas and existing persisted values remain compatible.
- IDs, counters, capacities, limits, and protocol-native scalar values remain numbers.
- Reliability hardening plan is rebased and cannot reintroduce temporal numbers.
- Format, lint, type-check, unit, integration/e2e, build, and package gates pass.

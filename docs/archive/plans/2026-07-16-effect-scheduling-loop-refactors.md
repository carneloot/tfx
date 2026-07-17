# Effect Scheduling Loop Refactors Implementation Plan

**Goal:** Replace four hand-written recursive Effect loops with explicit `Effect.repeat`, `Effect.retry`, and `Schedule` policies while preserving first-run timing, failure propagation, interruption, polling offsets, and timeout behavior.

**Architecture:** Execute this plan after `docs/plans/2026-07-15-effect-native-temporal-types.md` so every schedule receives normalized `Duration.Duration` values and PostgreSQL deadlines use `DateTime.Utc`. Infinite heartbeat monitors repeat successful checks with `Schedule.spaced`; Telegram polling retries recoverable request failures with an error-aware schedule and repeats successful poll passes without delay; PostgreSQL observation repeats a finite `Pending` state until completion, release, or timeout. Keep loop policy beside each workflow instead of introducing a cross-package scheduling abstraction.

**Tech Stack:** Effect v4 beta.98 (`Effect`, `Schedule`, `Duration`, `DateTime`, `TestClock`), TypeScript 7, Vitest 4, PostgreSQL 17, pnpm.

---

## Dependency and ordering

Implement in this order:

1. Complete and commit `docs/plans/2026-07-15-effect-native-temporal-types.md`.
2. Run this scheduling-loop plan.
3. Implement `docs/plans/2026-07-15-effect-reliability-hardening.md` against the resulting code.

Do not implement this plan before the temporal migration. Both plans modify the same blocks in:

- `packages/tfx/src/JobRuntime.ts`
- `packages/tfx/src/internal/runtime/DeduplicatedDispatch.ts`
- `packages/tfx/src/internal/update-source/PollingSource.ts`
- `packages/postgres/src/PostgresUpdateDeduplicator.ts`

The temporal migration changes every relevant interval from numeric milliseconds to normalized `Duration.Duration`, and changes PostgreSQL elapsed-time checks from number subtraction to `DateTime.distance`. Implementing scheduling first would create same-hunk conflicts and then immediately rewrite each schedule input.

The reliability plan should follow this plan because its stable `Effect.fn` naming task touches all four workflows. Naming final repeat/retry boundaries once is cleaner than naming recursive helpers and renaming them after this refactor.

## Behavioral invariants

Preserve these rules throughout:

- Job and dispatch heartbeats wait one full heartbeat interval before first check.
- Subsequent heartbeat checks wait one full interval after previous check completes; use `Schedule.spaced`, not `Schedule.fixed`.
- Heartbeat typed failures stop repetition immediately and continue through existing race/error mapping.
- Losing race branch remains interruptible.
- Telegram successful polls repeat immediately because `getUpdates` already performs long polling.
- Telegram recoverable failures wait for configured fallback delay, except rate limits use provider `retryAfter`.
- Telegram authentication, conflict, forbidden, invalid request/response, and unknown failures retain current fatal classification.
- `allowed_updates` remains present only on first successful polling cycle.
- Polling offsets advance only through contiguous acknowledgeable outcomes.
- PostgreSQL observation reads immediately, waits between `Pending` reads, checks timeout before each read, and may overshoot timeout by at most one polling interval as it does today.
- No refactor catches defects or interruptions.

## File map

### tfx heartbeat monitors

- Modify: `packages/tfx/src/JobRuntime.ts:177-200`
- Modify: `packages/tfx/test/JobRuntime.test.ts:76-130`
- Modify: `packages/tfx/src/internal/runtime/DeduplicatedDispatch.ts:55-66`
- Modify: `packages/tfx/test/UpdateDeduplicator.test.ts:80-210`

### Telegram polling

- Modify: `packages/tfx/src/internal/update-source/PollingSource.ts:25-106`
- Modify: `packages/tfx/test/Polling.test.ts:1-75`

### PostgreSQL observation

- Create: `packages/postgres/src/internal/DeduplicationObserver.ts`
- Create: `packages/postgres/test/DeduplicationObserver.test.ts`
- Modify: `packages/postgres/src/PostgresUpdateDeduplicator.ts:184-215`
- Test: `packages/postgres/test/Deduplicator.integration.test.ts`

---

### Task 1: Replace JobRuntime heartbeat recursion

**Files:**
- Modify: `packages/tfx/src/JobRuntime.ts:177-200`
- Modify: `packages/tfx/test/JobRuntime.test.ts:1-130`

- [ ] **Step 1: Add heartbeat-counting test support**

After temporal migration, extend test imports:

```ts
import {
	DateTime,
	Duration,
	Effect,
	Fiber,
	Layer,
	Ref,
	Schema,
} from 'effect';
```

Add a test-local decorator that uses the real memory store but records each heartbeat:

```ts
const withCountingStore = <A, E>(
	effect: Effect.Effect<A, E, JobRuntime | JobStore>,
	implementation: Job.Implementation<typeof declaration, never>,
	onHeartbeat: Effect.Effect<void>,
): Effect.Effect<A, E, never> =>
	Effect.gen(function* () {
		const base = yield* JobStore;
		const counted = JobStore.of({
			...base,
			heartbeat: (token, now, leaseDuration) =>
				onHeartbeat.pipe(
					Effect.andThen(base.heartbeat(token, now, leaseDuration)),
				),
		});
		const runtimeLayer = JobRuntimeLive.layer(implementation).pipe(
			Layer.provide(Layer.succeed(JobStore, counted)),
		);
		return yield* effect.pipe(
			Effect.provide(runtimeLayer),
			Effect.provideService(JobStore, counted),
		);
	}).pipe(Effect.provide(MemoryJobStore.layer));
```

- [ ] **Step 2: Add delayed-first and repeated-heartbeat characterization test**

Add beside existing cancellation test:

```ts
it('delays the first heartbeat and repeats successful heartbeats', async () => {
	const implementation = Job.implement(declaration, () => Effect.never);
	const program = Effect.gen(function* () {
		const count = yield* Ref.make(0);
		yield* withCountingStore(
			Effect.gen(function* () {
				const runtime = yield* JobRuntime;
				const store = yield* JobStore;
				const scheduled = yield* runtime.schedule(declaration, {
					value: 'wait',
				});
				const worker = yield* Effect.forkChild(
					runtime.runOne({
						leaseDuration: Duration.millis(40),
						heartbeatInterval: Duration.millis(10),
					}),
				);
				const awaitRunning: Effect.Effect<void, JobStoreError> =
					Effect.suspend(() =>
						Effect.flatMap(store.get(scheduled.id), (row) =>
							row?.status === 'running'
								? Effect.void
								: Effect.andThen(Effect.yieldNow, awaitRunning),
						),
					);
				yield* awaitRunning;
				expect(yield* Ref.get(count)).toBe(0);
				yield* TestClock.adjust('9 millis');
				expect(yield* Ref.get(count)).toBe(0);
				yield* TestClock.adjust('1 millis');
				expect(yield* Ref.get(count)).toBe(1);
				yield* TestClock.adjust('10 millis');
				expect(yield* Ref.get(count)).toBe(2);
				yield* Fiber.interrupt(worker);
			}),
			implementation,
			Ref.update(count, (value) => value + 1),
		);
	});
	await Effect.runPromise(Effect.provide(program, TestClock.layer()));
});
```

Use `DateTime` only if post-migration fixture construction requires it; remove unused imports after formatting.

- [ ] **Step 3: Run characterization tests before refactoring**

```bash
pnpm exec vitest run packages/tfx/test/JobRuntime.test.ts
```

Expected: PASS against existing suspended recursion. This is a behavior-preserving refactor, so characterization tests establish baseline rather than intentionally failing.

- [ ] **Step 4: Replace recursive monitor with delayed repeat**

Add source import:

```ts
import * as Schedule from 'effect/Schedule';
```

Replace recursive `monitor` definition with:

```ts
const heartbeat = Effect.gen(function* () {
	const current = yield* store.get(running.id);
	if (current?.cancellationRequested)
		return yield* Effect.fail(new CancelSignal());
	const heartbeatNow = yield* DateTime.now;
	if (
		!(yield* store.heartbeat(
			claim.token,
			heartbeatNow,
			leaseDuration,
		))
	)
		return yield* Effect.fail(new LeaseSignal());
});
const monitor: Effect.Effect<
	never,
	CancelSignal | LeaseSignal | JobStoreError
> = heartbeat.pipe(
	Effect.repeat(Schedule.spaced(heartbeatInterval)),
	Effect.delay(heartbeatInterval),
	Effect.andThen(Effect.never),
);
```

`Effect.delay` wraps the whole repeat driver, so only first heartbeat receives this extra delay. `Schedule.spaced` supplies each later delay. `Effect.andThen(Effect.never)` records that infinite schedule cannot produce a successful monitor value while preserving failures.

- [ ] **Step 5: Run JobRuntime tests and type-check tfx**

```bash
pnpm exec vitest run packages/tfx/test/JobRuntime.test.ts
pnpm exec tsc -b packages/tfx/tsconfig.json --pretty false
```

Expected: tests pass; monitor remains `Effect<never, CancelSignal | LeaseSignal | JobStoreError>`; no recursive `monitor` reference remains.

- [ ] **Step 6: Commit JobRuntime refactor**

```bash
git add packages/tfx/src/JobRuntime.ts packages/tfx/test/JobRuntime.test.ts
git commit -m "refactor(tfx): schedule job heartbeats with repeat"
```

---

### Task 2: Replace dispatch heartbeat recursion

**Files:**
- Modify: `packages/tfx/src/internal/runtime/DeduplicatedDispatch.ts:55-66`
- Modify: `packages/tfx/test/UpdateDeduplicator.test.ts:80-210`

- [ ] **Step 1: Add delayed-first and repeated dispatch-heartbeat test**

Extend imports after temporal migration:

```ts
import { Deferred, Duration, Effect, Fiber, Ref } from 'effect';
```

Add:

```ts
it('delays the first dispatch heartbeat and repeats while behavior runs', async () => {
	const program = Effect.gen(function* () {
		const claimed = yield* Deferred.make<void>();
		const heartbeats = yield* Ref.make(0);
		const service: UpdateDeduplicatorModule.UpdateDeduplicatorService = {
			diagnostics: { mode: 'memory', backend: 'test' },
			claim: () =>
				Deferred.succeed(claimed, undefined).pipe(
					Effect.as({
						_tag: 'Acquired' as const,
						token: { updateId: 1, generation: 1 },
					}),
				),
			heartbeat: () =>
				Ref.update(heartbeats, (value) => value + 1).pipe(Effect.as(true)),
			complete: () => Effect.succeed(true),
			release: () => Effect.succeed(true),
		};
		const fiber = yield* Effect.forkChild(
			DeduplicatedDispatch.dispatch(
				service,
				{ update_id: 1 } as Update,
				Effect.never,
				{
					leaseDuration: Duration.millis(40),
					heartbeatInterval: Duration.millis(10),
				},
			),
		);
		yield* Deferred.await(claimed);
		expect(yield* Ref.get(heartbeats)).toBe(0);
		yield* TestClock.adjust('9 millis');
		expect(yield* Ref.get(heartbeats)).toBe(0);
		yield* TestClock.adjust('1 millis');
		expect(yield* Ref.get(heartbeats)).toBe(1);
		yield* TestClock.adjust('10 millis');
		expect(yield* Ref.get(heartbeats)).toBe(2);
		yield* Fiber.interrupt(fiber);
	});
	await Effect.runPromise(Effect.provide(program, TestClock.layer()));
});
```

- [ ] **Step 2: Run characterization test before refactoring**

```bash
pnpm exec vitest run packages/tfx/test/UpdateDeduplicator.test.ts
```

Expected: PASS against existing suspended recursion.

- [ ] **Step 3: Replace recursive monitor with delayed repeat**

Add:

```ts
import * as Schedule from 'effect/Schedule';
```

Replace monitor with:

```ts
const heartbeat = Effect.flatMap(
	dedup.heartbeat(claim.token, leaseDuration),
	(alive) => (alive ? Effect.void : Effect.fail(new ClaimLost())),
);
const monitor: Effect.Effect<never, ClaimLost | UpdateDeduplicatorError> =
	heartbeat.pipe(
		Effect.repeat(Schedule.spaced(heartbeatInterval)),
		Effect.delay(heartbeatInterval),
		Effect.andThen(Effect.never),
	);
```

Do not move `catchTag('ClaimLost', ...)`, `uninterruptibleMask`, `restore`, completion fencing, or release finalizer. Their current placement defines interruption and settlement behavior.

- [ ] **Step 4: Run dedup tests and type-check tfx**

```bash
pnpm exec vitest run packages/tfx/test/UpdateDeduplicator.test.ts packages/tfx/test/BotRuntime.test.ts
pnpm exec tsc -b packages/tfx/tsconfig.json --pretty false
```

Expected: delayed/repeated heartbeat test, lease-loss mapping, completion fencing, release, and interruption tests pass.

- [ ] **Step 5: Commit dispatch heartbeat refactor**

```bash
git add packages/tfx/src/internal/runtime/DeduplicatedDispatch.ts packages/tfx/test/UpdateDeduplicator.test.ts
git commit -m "refactor(tfx): schedule dedup heartbeats with repeat"
```

---

### Task 3: Compose Telegram request retry with successful polling repeat

**Files:**
- Modify: `packages/tfx/src/internal/update-source/PollingSource.ts:25-106`
- Modify: `packages/tfx/test/Polling.test.ts:1-75`

- [ ] **Step 1: Add deterministic fallback-retry timing test**

Extend imports:

```ts
import { Deferred, Duration, Effect, Fiber, Ref } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import {
	NetworkError,
	TelegramError,
} from '../src/TelegramError.js';
```

Add a local constructor:

```ts
const telegramError = (reason: TelegramError['reason']): TelegramError =>
	new TelegramError({
		module: 'Telegram',
		method: 'getUpdates',
		reason,
	});
```

Add test:

```ts
it('waits for configured delay before retrying a recoverable poll failure', async () => {
	const program = Effect.gen(function* () {
		const attempts = yield* Ref.make(0);
		const firstAttempt = yield* Deferred.make<void>();
		const telegram = {
			getMe: () => Effect.succeed({ id: 1 }),
			deleteWebhook: () => Effect.succeed(true),
			setMyCommands: () => Effect.succeed(true),
			getUpdates: () =>
				Ref.updateAndGet(attempts, (value) => value + 1).pipe(
					Effect.tap(() => Deferred.succeed(firstAttempt, undefined)),
					Effect.flatMap(() =>
						Effect.fail(
							telegramError(new NetworkError({ message: 'offline' })),
						),
					),
		} as unknown as TelegramService;
		const source = PollingSource.make(telegram, {
			timeout: Duration.seconds(30),
			retryDelay: Duration.millis(25),
		});
		const fiber = yield* Effect.forkChild(
			source.run(() => Effect.succeed(DispatchOutcome.handled)),
		);
		yield* Deferred.await(firstAttempt);
		expect(yield* Ref.get(attempts)).toBe(1);
		yield* TestClock.adjust('24 millis');
		expect(yield* Ref.get(attempts)).toBe(1);
		yield* TestClock.adjust('1 millis');
		expect(yield* Ref.get(attempts)).toBe(2);
		yield* Fiber.interrupt(fiber);
	});
	await Effect.runPromise(Effect.provide(program, TestClock.layer()));
});
```

- [ ] **Step 2: Add provider rate-limit timing test**

Import `RateLimitError` and add the same harness with:

```ts
const failure = telegramError(
	new RateLimitError({
		errorCode: 429,
		description: 'slow down',
		retryAfterSeconds: 2,
	}),
);
```

Configure `retryDelay: Duration.millis(25)`, then assert:

```ts
yield* TestClock.adjust('1999 millis');
expect(yield* Ref.get(attempts)).toBe(1);
yield* TestClock.adjust('1 millis');
expect(yield* Ref.get(attempts)).toBe(2);
```

This proves provider delay overrides fallback delay.

- [ ] **Step 3: Run polling tests before refactoring**

```bash
pnpm exec vitest run packages/tfx/test/Polling.test.ts
```

Expected: existing recursive implementation passes immediate-success, fatal-error, fallback-delay, and rate-limit-delay characterization.

- [ ] **Step 4: Define error-aware retry schedule**

Add source import:

```ts
import * as Schedule from 'effect/Schedule';
```

Inside `run`, after normalized options are available, define:

```ts
const pollRetrySchedule = Schedule.forever.pipe(
	Schedule.setInputType<TelegramError>(),
	Schedule.modifyDelay(({ input }) =>
		Effect.succeed(
			retryDelay(input, options.retryDelay) ?? Duration.zero,
		),
	),
);
```

Keep `retryDelay` as the single classification function. Returning `undefined` means failure is not retryable.

- [ ] **Step 5: Extract one poll pass and apply retry**

Replace recursive request construction with a suspended request so each retry invokes `telegram.getUpdates` again:

```ts
const pollOnce: Effect.Effect<
	void,
	TelegramError | FatalPollingDispatchError
> = Effect.suspend(() =>
	telegram
		.getUpdates({
			...(offset === undefined ? {} : { offset }),
			limit: options.limit ?? 100,
			timeout: Duration.toSeconds(options.timeout),
			...(first && options.allowedUpdates !== undefined
				? { allowed_updates: options.allowedUpdates }
				: {}),
		})
		.pipe(
			Effect.retry({
				while: (error) =>
					retryDelay(error, options.retryDelay) !== undefined,
				schedule: pollRetrySchedule,
			}),
			Effect.flatMap((updates: ReadonlyArray<Update>) => {
				first = false;
				return Effect.flatMap(
					Effect.forEach(
						updates,
						(update) =>
							Effect.map(deliver(update), (outcome) => ({
								update,
								outcome,
							})),
						{ concurrency: 'unbounded' },
					),
					(settled) => {
						const ordered = [...settled].sort(
							(a, b) => a.update.update_id - b.update.update_id,
						);
						for (const item of ordered) {
							if (DispatchOutcome.isTerminal(item.outcome))
								return Effect.fail(
									new FatalPollingDispatchError({
										updateId: item.update.update_id,
									}),
								);
							if (!DispatchOutcome.isAcknowledgeable(item.outcome)) break;
							offset = item.update.update_id + 1;
						}
						return Effect.void;
					},
				);
			}),
		),
);
```

Keep `Duration.toSeconds(options.timeout)` at Telegram request construction; do not add a numeric timeout field to normalized runtime options.

- [ ] **Step 6: Repeat successful poll passes without delay**

Replace final recursive `poll` execution with:

```ts
return yield* pollOnce.pipe(
	Effect.repeat(Schedule.forever),
	Effect.andThen(Effect.never),
);
```

`Schedule.forever` has zero delay. Recoverable request failures are controlled only by `pollRetrySchedule`; successful polls do not inherit retry delay.

- [ ] **Step 7: Run polling and tfx gates**

```bash
pnpm exec vitest run packages/tfx/test/Polling.test.ts packages/tfx/test/BotRuntime.test.ts
pnpm exec tsc -b packages/tfx/tsconfig.json --pretty false
```

Expected:

- second successful poll begins immediately
- contiguous offset remains `2` in existing test
- `allowed_updates` appears only on first cycle
- fallback and provider delays pass under `TestClock`
- fatal Telegram errors and terminal dispatch outcomes stop polling

- [ ] **Step 8: Commit polling refactor**

```bash
git add packages/tfx/src/internal/update-source/PollingSource.ts packages/tfx/test/Polling.test.ts
git commit -m "refactor(tfx): compose polling retry and repeat"
```

---

### Task 4: Replace PostgreSQL observer recursion with finite repeat

**Files:**
- Create: `packages/postgres/src/internal/DeduplicationObserver.ts`
- Create: `packages/postgres/test/DeduplicationObserver.test.ts`
- Modify: `packages/postgres/src/PostgresUpdateDeduplicator.ts:184-215`
- Test: `packages/postgres/test/Deduplicator.integration.test.ts`

- [ ] **Step 1: Write focused observer tests**

Create `packages/postgres/test/DeduplicationObserver.test.ts`:

```ts
import { DateTime, Duration, Effect, Fiber, Ref } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { describe, expect, it } from 'vitest';

import * as Observer from '../src/internal/DeduplicationObserver.js';

describe('DeduplicationObserver', () => {
	it('reads immediately and spaces pending observations', async () => {
		const program = Effect.gen(function* () {
			const attempts = yield* Ref.make(0);
			const startedAt = yield* DateTime.now;
			const fiber = yield* Effect.forkChild(
				Observer.observe({
					startedAt,
					waitTimeout: Duration.millis(200),
					check: Ref.updateAndGet(attempts, (value) => value + 1).pipe(
						Effect.map((attempt) =>
							attempt < 3
								? Observer.pending
								: ({ _tag: 'Released' } as const),
						),
					),
				}),
			);
			yield* Effect.yieldNow;
			expect(yield* Ref.get(attempts)).toBe(1);
			yield* TestClock.adjust('49 millis');
			expect(yield* Ref.get(attempts)).toBe(1);
			yield* TestClock.adjust('1 millis');
			expect(yield* Ref.get(attempts)).toBe(2);
			yield* TestClock.adjust('50 millis');
			expect(yield* Fiber.join(fiber)).toEqual({ _tag: 'Released' });
			expect(yield* Ref.get(attempts)).toBe(3);
		});
		await Effect.runPromise(Effect.provide(program, TestClock.layer()));
	});

	it('checks timeout before reading and preserves one-interval overshoot', async () => {
		const program = Effect.gen(function* () {
			const attempts = yield* Ref.make(0);
			const startedAt = yield* DateTime.now;
			const fiber = yield* Effect.forkChild(
				Observer.observe({
					startedAt,
					waitTimeout: Duration.millis(75),
					check: Ref.update(attempts, (value) => value + 1).pipe(
						Effect.as(Observer.pending),
					),
				}),
			);
			yield* Effect.yieldNow;
			yield* TestClock.adjust('50 millis');
			expect(yield* Ref.get(attempts)).toBe(2);
			yield* TestClock.adjust('49 millis');
			expect(yield* Ref.get(attempts)).toBe(2);
			yield* TestClock.adjust('1 millis');
			expect(yield* Fiber.join(fiber)).toEqual({ _tag: 'TimedOut' });
			expect(yield* Ref.get(attempts)).toBe(2);
		});
		await Effect.runPromise(Effect.provide(program, TestClock.layer()));
	});
});
```

- [ ] **Step 2: Run new tests and verify missing module failure**

```bash
pnpm exec vitest run packages/postgres/test/DeduplicationObserver.test.ts
```

Expected: FAIL because `src/internal/DeduplicationObserver.ts` does not exist.

- [ ] **Step 3: Implement finite observer driver**

Create `packages/postgres/src/internal/DeduplicationObserver.ts`:

```ts
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';

import type { ObservedCompletion } from '../../../tfx/src/UpdateDeduplicator.js';

export interface Pending {
	readonly _tag: 'Pending';
}

export const pending: Pending = { _tag: 'Pending' };

type Observation = ObservedCompletion | Pending;

const isPending = (value: Observation): value is Pending =>
	value._tag === 'Pending';

export const observe = <E, R>(options: {
	readonly startedAt: DateTime.Utc;
	readonly waitTimeout: Duration.Duration;
	readonly check: Effect.Effect<Observation, E, R>;
}): Effect.Effect<ObservedCompletion, E, R> => {
	const interval = Duration.min(
		Duration.millis(50),
		options.waitTimeout,
	);
	const pass: Effect.Effect<Observation, E, R> = Effect.gen(function* () {
		const now = yield* DateTime.now;
		if (
			Duration.isGreaterThanOrEqualTo(
				DateTime.distance(options.startedAt, now),
				options.waitTimeout,
			)
		)
			return { _tag: 'TimedOut' } as const;
		return yield* options.check;
	});
	return Effect.repeat(pass, {
		while: isPending,
		schedule: Schedule.spaced(interval).pipe(
			Schedule.setInputType<Observation>(),
		),
	});
};
```

This helper owns only observation cadence and deadline. PostgreSQL row interpretation remains in adapter.

- [ ] **Step 4: Run observer unit tests**

```bash
pnpm exec vitest run packages/postgres/test/DeduplicationObserver.test.ts
```

Expected: PASS; first read occurs at time zero, later reads occur every 50ms, and 75ms timeout returns at next scheduled pass at 100ms without another read.

- [ ] **Step 5: Replace inline PostgreSQL recursion**

Import helper:

```ts
import * as DeduplicationObserver from './internal/DeduplicationObserver.js';
```

Replace `observe` recursive closure with:

```ts
const startedAt = now;
const observe = DeduplicationObserver.observe({
	startedAt,
	waitTimeout: wait,
	check: Effect.flatMap(protect(read(updateId)), (row) => {
		if (row === undefined || row.status === 'released')
			return Effect.succeed({ _tag: 'Released' } as const);
		if (row.status === 'completed') {
			if (row.outcome === undefined)
				return Effect.fail(
					invariant('Completed update has no outcome'),
				);
			return Effect.succeed({
				_tag: 'Completed' as const,
				outcome: row.outcome,
			});
		}
		return Effect.succeed(DeduplicationObserver.pending);
	}),
});
return { _tag: 'InProgress' as const, await: observe };
```

Remove now-unused inline `Effect.sleep` and recursive closure. Keep `protect(read(updateId))` and invariant mapping unchanged.

- [ ] **Step 6: Run unit, integration, and type gates**

```bash
pnpm exec vitest run packages/postgres/test/DeduplicationObserver.test.ts packages/tfx/test/UpdateDeduplicator.test.ts
RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts packages/postgres/test/Deduplicator.integration.test.ts
pnpm exec tsc -b packages/tfx/tsconfig.json packages/postgres/tsconfig.json --pretty false
```

Expected: observer tests, shared memory behavior, PostgreSQL claim coordination, invariant test, and both package builds pass.

- [ ] **Step 7: Commit PostgreSQL observer refactor**

```bash
git add packages/postgres/src/internal/DeduplicationObserver.ts packages/postgres/src/PostgresUpdateDeduplicator.ts packages/postgres/test/DeduplicationObserver.test.ts
git commit -m "refactor(postgres): schedule dedup observation polling"
```

---

### Task 5: Verify no delayed recursion remains and run full gates

**Files:**
- Verify: `packages/tfx/src/JobRuntime.ts`
- Verify: `packages/tfx/src/internal/runtime/DeduplicatedDispatch.ts`
- Verify: `packages/tfx/src/internal/update-source/PollingSource.ts`
- Verify: `packages/postgres/src/PostgresUpdateDeduplicator.ts`
- Verify: `packages/postgres/src/internal/DeduplicationObserver.ts`

- [ ] **Step 1: Search target files for recursive loop residue**

```bash
rg -n 'return yield\* (monitor|poll|observe)|Effect\.andThen\(Effect\.sleep|Effect\.flatMap\(Effect\.sleep' \
  packages/tfx/src/JobRuntime.ts \
  packages/tfx/src/internal/runtime/DeduplicatedDispatch.ts \
  packages/tfx/src/internal/update-source/PollingSource.ts \
  packages/postgres/src/PostgresUpdateDeduplicator.ts
```

Expected: no matches.

- [ ] **Step 2: Confirm explicit scheduling operators exist**

```bash
rg -n 'Effect\.(repeat|retry)|Schedule\.(spaced|forever|modifyDelay)' \
  packages/tfx/src/JobRuntime.ts \
  packages/tfx/src/internal/runtime/DeduplicatedDispatch.ts \
  packages/tfx/src/internal/update-source/PollingSource.ts \
  packages/postgres/src/internal/DeduplicationObserver.ts
```

Expected:

- `JobRuntime.ts`: `repeat` + `spaced`
- `DeduplicatedDispatch.ts`: `repeat` + `spaced`
- `PollingSource.ts`: `retry` + `modifyDelay` + `repeat` + `forever`
- `DeduplicationObserver.ts`: conditional `repeat` + `spaced`

- [ ] **Step 3: Run formatting and static gates**

```bash
pnpm format:fix
pnpm lint
pnpm check
git diff --check
```

Expected: all commands pass; formatter changes only touched scheduling/test files.

- [ ] **Step 4: Run unit and integration suites**

```bash
pnpm test:unit
RUN_TESTCONTAINERS=true pnpm test:integration
```

Expected: all unit and integration tests pass, including deterministic `TestClock` timing and PostgreSQL observer coverage.

- [ ] **Step 5: Run build/package gates**

```bash
pnpm build
pnpm check:tfx:package
pnpm check:packed
pnpm check:packed:consumers
```

Expected: all package and consumer checks pass; no public API or persisted representation changed.

- [ ] **Step 6: Review final history and diff**

```bash
git status --short
git log --oneline -4
git diff HEAD~4..HEAD --stat
```

Expected: four focused commits, clean working tree, no generated Telegram or SQL migration changes.

- [ ] **Step 7: Request code review**

Review specifically:

```text
1. Heartbeat monitors delay first execution and use spaced, not fixed, cadence.
2. Monitor failures and race interruption behavior are unchanged.
3. Polling retries only existing recoverable Telegram failures and uses provider retryAfter.
4. Successful polls have no added delay; first-only allowed_updates and offset progression remain unchanged.
5. PostgreSQL observer checks timeout before read and retains bounded overshoot.
6. No defect/interruption recovery or public temporal conversion was introduced.
7. All schedules consume normalized Duration.Duration values from completed temporal migration.
```

Fix critical or important findings in new follow-up commits; do not amend existing commits.

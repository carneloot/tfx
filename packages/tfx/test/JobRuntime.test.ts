import { Effect, Fiber, Layer, Ref, Schema } from 'effect';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as TestClock from 'effect/testing/TestClock';
import { describe, expect, it } from 'vitest';

import * as Job from '../src/Job.js';
import { JobRuntime } from '../src/JobRuntime.js';
import * as JobRuntimeLive from '../src/JobRuntime.js';
import { JobStore, JobStoreError } from '../src/JobStore.js';
import * as MemoryJobStore from '../src/MemoryJobStore.js';
import * as VersionedSchema from '../src/VersionedSchema.js';
const history = VersionedSchema.history(
	VersionedSchema.version(1, Schema.Struct({ old: Schema.String })),
).pipe(
	VersionedSchema.to(
		VersionedSchema.version(2, Schema.Struct({ value: Schema.String })),
		(v) => ({ value: v.old }),
	),
);
class RetryFailure extends Schema.TaggedErrorClass<RetryFailure>()(
	'RetryFailure',
	{},
) {}
const declaration = Job.make('work', {
	payload: history,
	error: RetryFailure,
	maxAttempts: 3,
	retry: () => Job.retry(100),
});
const provide = <A, E>(
	effect: Effect.Effect<A, E, JobRuntime | JobStore>,
	implementation: Job.Implementation<typeof declaration, never>,
) =>
	Effect.provide(
		Effect.provide(effect, JobRuntimeLive.layer(implementation)),
		MemoryJobStore.layer,
	);
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
describe('JobRuntime', () => {
	it('migrates before promotion, retries, and succeeds', async () => {
		let runs = 0;
		const implementation = Job.implement(declaration, (payload) =>
			Effect.suspend(() => {
				runs++;
				return runs === 1
					? Effect.fail(new RetryFailure())
					: Effect.sync(() => expect(payload.value).toBe('old'));
			}),
		);
		const program = Effect.gen(function* () {
			const runtime = yield* JobRuntime;
			const store = yield* JobStore;
			const raw = yield* store.schedule({
				name: declaration.name,
				payload: { old: 'old' },
				payloadVersion: 1,
				maxAttempts: 3,
				now: DateTime.makeUnsafe(0),
				runAt: DateTime.makeUnsafe(0),
			});
			expect((yield* runtime.runOne())?.status).toBe('scheduled');
			expect(yield* store.get(raw.record.id)).toMatchObject({
				payloadVersion: 2,
				payload: { value: 'old' },
				attempts: 1,
			});
			yield* TestClock.adjust('100 millis');
			expect(yield* runtime.runOne()).toMatchObject({
				status: 'completed',
				attempts: 2,
			});
			expect(runs).toBe(2);
		});
		await Effect.runPromise(
			Effect.provide(provide(program, implementation), TestClock.layer()),
		);
	});
	it('observes running cancellation and interrupts the local handler', async () => {
		const implementation = Job.implement(declaration, () => Effect.never);
		const program = Effect.gen(function* () {
			const runtime = yield* JobRuntime;
			const store = yield* JobStore;
			const scheduled = yield* runtime.schedule(declaration, { value: 'wait' });
			const worker = yield* Effect.forkChild(
				runtime.runOne({ leaseDuration: Duration.millis(30) }),
			);
			const awaitRunning: Effect.Effect<void, JobStoreError> = Effect.suspend(
				() =>
					Effect.flatMap(store.get(scheduled.id), (row) =>
						row?.status === 'running'
							? Effect.void
							: Effect.andThen(Effect.yieldNow, awaitRunning),
					),
			);
			yield* awaitRunning;
			expect(yield* runtime.cancel(scheduled.id)).toBe(true);
			yield* TestClock.adjust('11 millis');
			expect(yield* Fiber.join(worker)).toMatchObject({
				status: 'cancelled',
				outcome: { _tag: 'Cancelled' },
			});
		});
		await Effect.runPromise(
			Effect.provide(provide(program, implementation), TestClock.layer()),
		);
	});

	it('heartbeats at the configured spaced interval', async () => {
		const implementation = Job.implement(declaration, () => Effect.never);
		const program = Effect.gen(function* () {
			const heartbeatCount = yield* Ref.make(0);
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
					expect(yield* Ref.get(heartbeatCount)).toBe(0);
					yield* TestClock.adjust('9 millis');
					expect(yield* Ref.get(heartbeatCount)).toBe(0);
					yield* TestClock.adjust('1 millis');
					expect(yield* Ref.get(heartbeatCount)).toBe(0);
					yield* TestClock.adjust('5 millis');
					expect(yield* Ref.get(heartbeatCount)).toBe(1);
					yield* TestClock.adjust('10 millis');
					expect(yield* Ref.get(heartbeatCount)).toBe(1);
					yield* TestClock.adjust('5 millis');
					expect(yield* Ref.get(heartbeatCount)).toBe(2);
					yield* Fiber.interrupt(worker);
				}),
				implementation,
				Effect.sleep('5 millis').pipe(
					Effect.andThen(Ref.update(heartbeatCount, (count) => count + 1)),
				),
			);
		});
		await Effect.runPromise(Effect.provide(program, TestClock.layer()));
	});

	it('preserves external worker interruption for lease recovery', async () => {
		const implementation = Job.implement(declaration, () => Effect.never);
		const program = Effect.gen(function* () {
			const runtime = yield* JobRuntime;
			const store = yield* JobStore;
			const scheduled = yield* runtime.schedule(declaration, { value: 'wait' });
			const worker = yield* Effect.forkChild(
				runtime.runOne({ leaseDuration: Duration.millis(100) }),
			);
			const awaitRunning: Effect.Effect<void, JobStoreError> = Effect.suspend(
				() =>
					Effect.flatMap(store.get(scheduled.id), (row) =>
						row?.status === 'running'
							? Effect.void
							: Effect.andThen(Effect.yieldNow, awaitRunning),
					),
			);
			yield* awaitRunning;
			yield* Fiber.interrupt(worker);
			return yield* store.get(scheduled.id);
		});
		const row = await Effect.runPromise(
			Effect.provide(provide(program, implementation), TestClock.layer()),
		);
		expect(row).toMatchObject({ status: 'running', attempts: 1 });
	});

	it('rejects promotion after the migration lease expires', async () => {
		const program = Effect.gen(function* () {
			const store = yield* JobStore;
			yield* store.schedule({
				name: declaration.name,
				payload: { value: 'late' },
				payloadVersion: 2,
				maxAttempts: 3,
				now: DateTime.makeUnsafe(0),
				runAt: DateTime.makeUnsafe(0),
			});
			const claim = yield* store.claimForMigration(
				DateTime.makeUnsafe(0),
				Duration.millis(10),
			);
			if (claim === undefined) throw new Error('expected claim');
			yield* TestClock.adjust('11 millis');
			return yield* Effect.flip(
				store.promoteToRunning(
					claim.token,
					{ value: 'late' },
					2,
					DateTime.makeUnsafe(11),
					Duration.millis(10),
				),
			);
		});
		const error = await Effect.runPromise(
			Effect.provide(
				Effect.provide(program, MemoryJobStore.layer),
				TestClock.layer(),
			),
		);
		expect(error).toMatchObject({ reason: 'StaleToken' });
	});

	it('rejects invalid heartbeat intervals', async () => {
		const implementation = Job.implement(declaration, () => Effect.void);
		const exit = await Effect.runPromise(
			Effect.provide(
				provide(
					Effect.gen(function* () {
						const runtime = yield* JobRuntime;
						return yield* Effect.forEach(
							[0, 100, Number.POSITIVE_INFINITY],
							(heartbeatInterval) =>
								Effect.exit(
									runtime.runOne({
										leaseDuration: Duration.millis(100),
										heartbeatInterval,
									}),
								),
						);
					}),
					implementation,
				),
				TestClock.layer(),
			),
		);
		expect(exit.every((value) => value._tag === 'Failure')).toBe(true);
	});

	it('uses duration-native retry instants', async () => {
		const delay = Duration.seconds(2);
		const retrying = Job.make('duration-retry', {
			payload: history,
			error: RetryFailure,
			maxAttempts: 3,
			retry: () => Job.retry(delay),
		});
		const implementation = Job.implement(retrying, () =>
			Effect.fail(new RetryFailure()),
		);
		const program = Effect.gen(function* () {
			const runtime = yield* JobRuntime;
			yield* runtime.schedule(retrying, { value: 'retry' });
			const result = yield* runtime.runOne();
			expect(result?.status).toBe('scheduled');
			if (result?.status === 'scheduled')
				expect(
					DateTime.Equivalence(
						result.runAt,
						DateTime.addDuration(DateTime.makeUnsafe(0), delay),
					),
				).toBe(true);
		});
		await Effect.runPromise(
			Effect.provide(
				Effect.provide(
					Effect.provide(program, JobRuntimeLive.layer(implementation)),
					MemoryJobStore.layer,
				),
				TestClock.layer(),
			),
		);
	});

	it('quarantines thrown and malformed retry policies', async () => {
		const invalidPolicies: ReadonlyArray<() => Job.RetryDecision> = [
			() => {
				throw new Error('policy defect');
			},
			() => ({ _tag: 'Invalid' }) as unknown as Job.RetryDecision,
			() => ({
				_tag: 'Retry' as const,
				retryAfter: Duration.millis(-1) as Duration.Duration,
			}),
			() => ({
				_tag: 'Retry' as const,
				retryAfter: Duration.infinity,
			}),
		];
		for (const [index, retry] of invalidPolicies.entries()) {
			const invalid = Job.make(`invalid-retry-${index}`, {
				payload: history,
				error: RetryFailure,
				maxAttempts: 3,
				retry,
			});
			const implementation = Job.implement(invalid, () =>
				Effect.fail(new RetryFailure()),
			);
			const program = Effect.gen(function* () {
				const runtime = yield* JobRuntime;
				yield* runtime.schedule(invalid, { value: 'bad' });
				expect(yield* runtime.runOne()).toMatchObject({
					status: 'quarantined',
					attempts: 1,
				});
			});
			await Effect.runPromise(
				Effect.provide(
					Effect.provide(
						Effect.provide(program, JobRuntimeLive.layer(implementation)),
						MemoryJobStore.layer,
					),
					TestClock.layer(),
				),
			);
		}
	});

	it('quarantines thrown and forged invalid custom schedules', async () => {
		const invalidSchedules: ReadonlyArray<() => Duration.Duration> = [
			() => {
				throw new Error('schedule defect');
			},
			() => Duration.millis(-1) as Duration.Duration,
			() => Duration.infinity as Duration.Duration,
		];
		for (const [index, schedule] of invalidSchedules.entries()) {
			const invalid = Job.make(`invalid-schedule-${index}`, {
				payload: history,
				error: RetryFailure,
				maxAttempts: 3,
				retry: () => Job.retry(),
				schedule,
			});
			const implementation = Job.implement(invalid, () =>
				Effect.fail(new RetryFailure()),
			);
			const program = Effect.gen(function* () {
				const runtime = yield* JobRuntime;
				yield* runtime.schedule(invalid, { value: 'bad' });
				expect(yield* runtime.runOne()).toMatchObject({
					status: 'quarantined',
					attempts: 1,
				});
			});
			await Effect.runPromise(
				Effect.provide(
					Effect.provide(
						Effect.provide(program, JobRuntimeLive.layer(implementation)),
						MemoryJobStore.layer,
					),
					TestClock.layer(),
				),
			);
		}
	});

	it('rejects duplicate declarations before layer acquisition', () => {
		const implementation = Job.implement(declaration, () => Effect.void);
		expect(() => JobRuntimeLive.layer(implementation, implementation)).toThrow(
			"Duplicate job declaration 'work'",
		);
	});

	it('quarantines unknown, newer, and invalid payload declarations without attempts', async () => {
		const implementation = Job.implement(declaration, () => Effect.void);
		const program = Effect.gen(function* () {
			const runtime = yield* JobRuntime;
			const store = yield* JobStore;
			const unknown = yield* store.schedule({
				name: 'missing',
				payload: {},
				payloadVersion: 1,
				maxAttempts: 2,
				now: DateTime.makeUnsafe(0),
				runAt: DateTime.makeUnsafe(0),
			});
			expect(yield* runtime.runOne()).toMatchObject({
				id: unknown.record.id,
				status: 'quarantined',
				attempts: 0,
			});
			const newer = yield* store.schedule({
				name: declaration.name,
				payload: {},
				payloadVersion: 9,
				maxAttempts: 2,
				now: DateTime.makeUnsafe(0),
				runAt: DateTime.makeUnsafe(0),
			});
			expect(yield* runtime.runOne()).toMatchObject({
				id: newer.record.id,
				status: 'quarantined',
				attempts: 0,
			});
			expect(new Set((yield* runtime.problems).map((job) => job.id))).toEqual(
				new Set([unknown.record.id, newer.record.id]),
			);
		});
		await Effect.runPromise(
			Effect.provide(provide(program, implementation), TestClock.layer()),
		);
	});
});

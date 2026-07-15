import { Effect, Fiber, Schema } from 'effect';
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
const declaration = Job.make('work', {
	payload: history,
	error: undefined as unknown as string,
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
describe('JobRuntime', () => {
	it('migrates before promotion, retries, and succeeds', async () => {
		let runs = 0;
		const implementation = Job.implement(declaration, (payload) =>
			Effect.suspend(() => {
				runs++;
				return runs === 1
					? Effect.fail('retry')
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
				now: 0,
				runAt: 0,
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
				runtime.runOne({ leaseDuration: 30 }),
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

	it('preserves external worker interruption for lease recovery', async () => {
		const implementation = Job.implement(declaration, () => Effect.never);
		const program = Effect.gen(function* () {
			const runtime = yield* JobRuntime;
			const store = yield* JobStore;
			const scheduled = yield* runtime.schedule(declaration, { value: 'wait' });
			const worker = yield* Effect.forkChild(
				runtime.runOne({ leaseDuration: 100 }),
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
				now: 0,
				runAt: 0,
			});
			const claim = yield* store.claimForMigration(0, 10);
			if (claim === undefined) throw new Error('expected claim');
			yield* TestClock.adjust('11 millis');
			return yield* Effect.flip(
				store.promoteToRunning(claim.token, { value: 'late' }, 2, 11, 10),
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

	it('rejects invalid lease durations', async () => {
		const implementation = Job.implement(declaration, () => Effect.void);
		const exit = await Effect.runPromise(
			Effect.provide(
				provide(
					Effect.gen(function* () {
						const runtime = yield* JobRuntime;
						return yield* Effect.exit(
							runtime.runOne({ leaseDuration: Infinity }),
						);
					}),
					implementation,
				),
				TestClock.layer(),
			),
		);
		expect(exit._tag).toBe('Failure');
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
				now: 0,
				runAt: 0,
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
				now: 0,
				runAt: 0,
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

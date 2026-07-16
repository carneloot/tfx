import { Deferred, Duration, Effect, Fiber, Ref } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { describe, expect, it } from 'vitest';

import * as DispatchOutcome from '../src/DispatchOutcome.js';
import * as DeduplicatedDispatch from '../src/internal/runtime/DeduplicatedDispatch.js';
import type { Update } from '../src/internal/telegram/generated/TelegramApi.types.js';
import * as MemoryUpdateDeduplicator from '../src/MemoryUpdateDeduplicator.js';
import { UpdateDeduplicator } from '../src/UpdateDeduplicator.js';
import * as UpdateDeduplicatorModule from '../src/UpdateDeduplicator.js';
const run = <A, E>(effect: Effect.Effect<A, E, UpdateDeduplicator>) =>
	Effect.runPromise(
		Effect.provide(
			Effect.provide(effect, MemoryUpdateDeduplicator.layerMemory),
			TestClock.layer(),
		),
	);
describe('UpdateDeduplicator', () => {
	it('acquires, exposes bounded waiters, and persists completed outcomes', async () => {
		await run(
			Effect.gen(function* () {
				const dedup = yield* UpdateDeduplicator;
				const first = yield* dedup.claim(1, {
					leaseDuration: Duration.millis(1000),
				});
				if (first._tag !== 'Acquired') throw new Error('expected acquired');
				const concurrent = yield* dedup.claim(1);
				if (concurrent._tag !== 'InProgress')
					throw new Error('expected in progress');
				const waiter = yield* Effect.forkChild(concurrent.await);
				expect(
					yield* dedup.complete(
						first.token,
						DispatchOutcome.handled,
						Duration.millis(1000),
					),
				).toBe(true);
				expect(yield* Fiber.join(waiter)).toEqual({
					_tag: 'Completed',
					outcome: { _tag: 'Handled' },
				});
				expect(yield* dedup.claim(1)).toEqual({
					_tag: 'Completed',
					outcome: { _tag: 'Handled' },
				});
			}),
		);
	});
	it('allows exactly one acquired generation under parallel contention', async () => {
		await run(
			Effect.gen(function* () {
				const dedup = yield* UpdateDeduplicator;
				const claims = yield* Effect.all(
					Array.from({ length: 16 }, () => dedup.claim(99)),
					{ concurrency: 'unbounded' },
				);
				expect(
					claims.filter((claim) => claim._tag === 'Acquired'),
				).toHaveLength(1);
				expect(
					claims.filter((claim) => claim._tag === 'InProgress'),
				).toHaveLength(15);
			}),
		);
	});

	it('fences expiry takeover, heartbeat, release, and stale owners', async () => {
		await run(
			Effect.gen(function* () {
				const dedup = yield* UpdateDeduplicator;
				const first = yield* dedup.claim(2, {
					leaseDuration: Duration.millis(100),
				});
				if (first._tag !== 'Acquired') return;
				expect(yield* dedup.heartbeat(first.token, Duration.millis(200))).toBe(
					true,
				);
				yield* TestClock.adjust('201 millis');
				const second = yield* dedup.claim(2);
				if (second._tag !== 'Acquired') return;
				expect(second.token.generation).toBe(first.token.generation + 1);
				expect(
					yield* dedup.complete(first.token, DispatchOutcome.handled),
				).toBe(false);
				expect(yield* dedup.release(second.token)).toBe(true);
				expect(
					yield* dedup.complete(second.token, DispatchOutcome.handled),
				).toBe(false);
				const third = yield* dedup.claim(2);
				expect(third._tag).toBe('Acquired');
				if (third._tag === 'Acquired')
					expect(third.token.generation).toBe(second.token.generation + 1);
			}),
		);
	});
	it('maps deduplication operational failures to retryable outcomes', async () => {
		const service: UpdateDeduplicatorModule.UpdateDeduplicatorService = {
			diagnostics: { mode: 'durable', backend: 'test' },
			claim: () =>
				Effect.fail(
					new UpdateDeduplicatorModule.UpdateDeduplicatorError(
						'PersistenceFailure',
						'unavailable',
					),
				),
			heartbeat: () => Effect.succeed(true),
			complete: () => Effect.succeed(true),
			release: () => Effect.succeed(true),
		};
		await expect(
			Effect.runPromise(
				DeduplicatedDispatch.dispatch(
					service,
					{ update_id: 1 } as Update,
					Effect.succeed(DispatchOutcome.handled),
				),
			),
		).resolves.toMatchObject({ _tag: 'RetryableFailure' });
	});

	it('heartbeats dispatch at the configured spaced interval', async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const claimed = yield* Deferred.make<void>();
				const heartbeatCount = yield* Ref.make(0);
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
						Effect.sleep('5 millis').pipe(
							Effect.andThen(
								Ref.update(heartbeatCount, (count) => count + 1),
							),
							Effect.as(true),
						),
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
				yield* Fiber.interrupt(fiber);
			}).pipe(Effect.provide(TestClock.layer())),
		);
	});

	it('returns retryable when the completion fence is lost', async () => {
		const service: UpdateDeduplicatorModule.UpdateDeduplicatorService = {
			diagnostics: { mode: 'memory', backend: 'test' },
			claim: () =>
				Effect.succeed({
					_tag: 'Acquired',
					token: { updateId: 1, generation: 1 },
				}),
			heartbeat: () => Effect.succeed(true),
			complete: () => Effect.succeed(false),
			release: () => Effect.succeed(true),
		};
		await expect(
			Effect.runPromise(
				DeduplicatedDispatch.dispatch(
					service,
					{ update_id: 1 } as Update,
					Effect.succeed(DispatchOutcome.handled),
				),
			),
		).resolves.toMatchObject({ _tag: 'RetryableFailure' });
	});

	it('settles an acquired claim before preserving interruption', async () => {
		const completeStarted = Deferred.makeUnsafe<void>();
		const allowComplete = Deferred.makeUnsafe<void>();
		let released = 0;
		const service: UpdateDeduplicatorModule.UpdateDeduplicatorService = {
			diagnostics: { mode: 'memory', backend: 'test' },
			claim: () =>
				Effect.succeed({
					_tag: 'Acquired',
					token: { updateId: 1, generation: 1 },
				}),
			heartbeat: () => Effect.succeed(true),
			complete: () =>
				Effect.andThen(
					Deferred.succeed(completeStarted, undefined),
					Effect.as(Deferred.await(allowComplete), true),
				),
			release: () => Effect.sync(() => (++released, true)),
		};
		const fiber = Effect.runFork(
			DeduplicatedDispatch.dispatch(
				service,
				{ update_id: 1 } as Update,
				Effect.succeed(DispatchOutcome.handled),
			),
		);
		await Effect.runPromise(Deferred.await(completeStarted));
		const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
		await Promise.resolve();
		expect(released).toBe(0);
		await Effect.runPromise(Deferred.succeed(allowComplete, undefined));
		await interrupted;
		const exit = await Effect.runPromise(Fiber.await(fiber));
		expect(exit._tag).toBe('Failure');
		expect(released).toBe(1);
	});

	it('releases its fence and preserves external interruption', async () => {
		let released = 0;
		const service: UpdateDeduplicatorModule.UpdateDeduplicatorService = {
			diagnostics: { mode: 'memory', backend: 'test' },
			claim: () =>
				Effect.succeed({
					_tag: 'Acquired',
					token: { updateId: 1, generation: 1 },
				}),
			heartbeat: () => Effect.succeed(true),
			complete: () => Effect.succeed(true),
			release: () => Effect.sync(() => (++released, true)),
		};
		const fiber = Effect.runFork(
			DeduplicatedDispatch.dispatch(
				service,
				{ update_id: 1 } as Update,
				Effect.never,
			),
		);
		await Effect.runPromise(Fiber.interrupt(fiber));
		const exit = await Effect.runPromise(Fiber.await(fiber));
		expect(exit._tag).toBe('Failure');
		expect(released).toBe(1);
	});

	it('validates timing options', async () => {
		await run(
			Effect.gen(function* () {
				const dedup = yield* UpdateDeduplicator;
				const exit = yield* Effect.exit(
					dedup.claim(1, { leaseDuration: Duration.infinity }),
				);
				expect(exit._tag).toBe('Failure');
			}),
		);
	});

	it('provides an explicit noop layer with duplicate-risk diagnostics', async () => {
		const program = Effect.gen(function* () {
			const dedup = yield* UpdateDeduplicator;
			const a = yield* dedup.claim(1);
			const b = yield* dedup.claim(1);
			return { diagnostics: dedup.diagnostics, a, b };
		});
		const result = await Effect.runPromise(
			Effect.provide(program, UpdateDeduplicatorModule.layerNoop),
		);
		expect(result.diagnostics).toEqual({ mode: 'none', backend: 'noop' });
		expect(result.a._tag).toBe('Acquired');
		expect(result.b._tag).toBe('Acquired');
	});
});

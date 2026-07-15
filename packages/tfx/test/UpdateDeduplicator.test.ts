import { Effect, Fiber } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { describe, expect, it } from 'vitest';

import * as DispatchOutcome from '../src/DispatchOutcome.js';
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
				const first = yield* dedup.claim(1, { leaseDuration: 1000 });
				if (first._tag !== 'Acquired') throw new Error('expected acquired');
				const concurrent = yield* dedup.claim(1);
				if (concurrent._tag !== 'InProgress')
					throw new Error('expected in progress');
				const waiter = yield* Effect.forkChild(concurrent.await);
				expect(
					yield* dedup.complete(first.token, DispatchOutcome.handled, 1000),
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
	it('fences expiry takeover, heartbeat, release, and stale owners', async () => {
		await run(
			Effect.gen(function* () {
				const dedup = yield* UpdateDeduplicator;
				const first = yield* dedup.claim(2, { leaseDuration: 100 });
				if (first._tag !== 'Acquired') return;
				expect(yield* dedup.heartbeat(first.token, 200)).toBe(true);
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

import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Ref from 'effect/Ref';
import * as TestClock from 'effect/testing/TestClock';
import { describe, expect, it } from 'vitest';

import * as Observer from '../src/internal/DeduplicationObserver.js';

const run = <A, E>(effect: Effect.Effect<A, E>) =>
	Effect.runPromise(Effect.provide(effect, TestClock.layer()));

describe('DeduplicationObserver', () => {
	it('returns a completed observation unchanged without repeating', async () => {
		await run(
			Effect.gen(function* () {
				const startedAt = yield* DateTime.now;
				const attempts = yield* Ref.make(0);
				const outcome = {
					_tag: 'PermanentInvalid',
					reason: 'invalid',
				} as const;
				const completed = { _tag: 'Completed', outcome } as const;
				const result = yield* Observer.observe({
					startedAt,
					waitTimeout: Duration.seconds(1),
					check: Ref.update(attempts, (count) => count + 1).pipe(
						Effect.as(completed),
					),
				});

				expect(result).toBe(completed);
				expect(result.outcome).toBe(outcome);
				expect(yield* Ref.get(attempts)).toBe(1);
			}),
		);
	});

	it('propagates a typed check failure unchanged', async () => {
		class CheckFailure extends Error {
			readonly _tag = 'CheckFailure';
		}
		const failure = new CheckFailure('check failed');

		await run(
			Effect.gen(function* () {
				const startedAt = yield* DateTime.now;
				const result = yield* Effect.flip(
					Observer.observe({
						startedAt,
						waitTimeout: Duration.seconds(1),
						check: Effect.fail(failure),
					}),
				);

				expect(result).toBe(failure);
			}),
		);
	});

	it('reads immediately and spaces pending observations', async () => {
		await run(
			Effect.gen(function* () {
				const startedAt = yield* DateTime.now;
				const attempts = yield* Ref.make(0);
				const fiber = yield* Effect.forkChild(
					Observer.observe({
						startedAt,
						waitTimeout: Duration.millis(200),
						check: Ref.updateAndGet(attempts, (count) => count + 1).pipe(
							Effect.map((count) =>
								count < 3 ? Observer.pending : ({ _tag: 'Released' } as const),
							),
						),
					}),
				);
				yield* Effect.yieldNow;
				expect(yield* Ref.get(attempts)).toBe(1);
				yield* TestClock.adjust(Duration.millis(49));
				expect(yield* Ref.get(attempts)).toBe(1);
				yield* TestClock.adjust(Duration.millis(1));
				expect(yield* Ref.get(attempts)).toBe(2);
				yield* TestClock.adjust(Duration.millis(50));
				expect(yield* Fiber.join(fiber)).toEqual({ _tag: 'Released' });
				expect(yield* Ref.get(attempts)).toBe(3);
			}),
		);
	});

	it('uses a sub-50ms timeout as interval and times out before rereading', async () => {
		await run(
			Effect.gen(function* () {
				const startedAt = yield* DateTime.now;
				const attempts = yield* Ref.make(0);
				const fiber = yield* Effect.forkChild(
					Observer.observe({
						startedAt,
						waitTimeout: Duration.millis(20),
						check: Ref.update(attempts, (count) => count + 1).pipe(
							Effect.as(Observer.pending),
						),
					}),
				);
				yield* Effect.yieldNow;
				expect(yield* Ref.get(attempts)).toBe(1);
				yield* TestClock.adjust(Duration.millis(19));
				expect(yield* Ref.get(attempts)).toBe(1);
				yield* TestClock.adjust(Duration.millis(1));
				expect(yield* Fiber.join(fiber)).toEqual({ _tag: 'TimedOut' });
				expect(yield* Ref.get(attempts)).toBe(1);
			}),
		);
	});

	it('times out immediately at zero without checking', async () => {
		await run(
			Effect.gen(function* () {
				const startedAt = yield* DateTime.now;
				const attempts = yield* Ref.make(0);
				const result = yield* Observer.observe({
					startedAt,
					waitTimeout: Duration.zero,
					check: Ref.update(attempts, (count) => count + 1).pipe(
						Effect.as(Observer.pending),
					),
				});

				expect(result).toEqual({ _tag: 'TimedOut' });
				expect(yield* Ref.get(attempts)).toBe(0);
			}),
		);
	});

	it('times out before another read with bounded overshoot', async () => {
		await run(
			Effect.gen(function* () {
				const startedAt = yield* DateTime.now;
				const attempts = yield* Ref.make(0);
				const fiber = yield* Effect.forkChild(
					Observer.observe({
						startedAt,
						waitTimeout: Duration.millis(75),
						check: Ref.update(attempts, (count) => count + 1).pipe(
							Effect.as(Observer.pending),
						),
					}),
				);
				yield* Effect.yieldNow;
				yield* TestClock.adjust(Duration.millis(50));
				expect(yield* Ref.get(attempts)).toBe(2);
				yield* TestClock.adjust(Duration.millis(49));
				expect(yield* Ref.get(attempts)).toBe(2);
				yield* TestClock.adjust(Duration.millis(1));
				expect(yield* Fiber.join(fiber)).toEqual({ _tag: 'TimedOut' });
				expect(yield* Ref.get(attempts)).toBe(2);
			}),
		);
	});
});

import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import { describe, expect, it } from 'vitest';

import * as BotRuntime from '../src/BotRuntime.js';
import * as DispatchOutcome from '../src/DispatchOutcome.js';
import * as MemoryUpdateDeduplicator from '../src/MemoryUpdateDeduplicator.js';

describe('one-shot request dispatch', () => {
	it('coalesces concurrent replays and retains committed output failure', async () => {
		let calls = 0;
		const outcomes = await Effect.runPromise(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const router = {
					route: () =>
						Effect.gen(function* () {
							calls++;
							yield* Deferred.succeed(entered, undefined);
							yield* Deferred.await(release);
							return DispatchOutcome.handledWithOutputFailure(
								'telegram-output-failed',
							);
						}),
				};
				const first = yield* Effect.forkChild(
					BotRuntime.dispatch({ update_id: 71 }, router),
				);
				yield* Deferred.await(entered);
				const second = yield* Effect.forkChild(
					BotRuntime.dispatch({ update_id: 71 }, router),
				);
				yield* Deferred.succeed(release, undefined);
				return [
					yield* Fiber.join(first),
					yield* Fiber.join(second),
					yield* BotRuntime.dispatch({ update_id: 71 }, router),
				];
			}).pipe(Effect.provide(MemoryUpdateDeduplicator.layerMemory)),
		);
		expect(calls).toBe(1);
		expect(outcomes).toEqual(
			Array.from({ length: 3 }, () => ({
				_tag: 'HandledWithOutputFailure',
				error: 'telegram-output-failed',
			})),
		);
	});

	it('releases retryable work rather than storing it as a completed update', async () => {
		let calls = 0;
		await Effect.runPromise(
			Effect.gen(function* () {
				const router = {
					route: () =>
						Effect.sync(() => {
							calls++;
							return calls === 1
								? DispatchOutcome.retryableFailure('database-unavailable')
								: DispatchOutcome.handled;
						}),
				};
				expect(
					(yield* BotRuntime.dispatch({ update_id: 72 }, router))._tag,
				).toBe('RetryableFailure');
				expect(
					(yield* BotRuntime.dispatch({ update_id: 72 }, router))._tag,
				).toBe('Handled');
			}).pipe(Effect.provide(MemoryUpdateDeduplicator.layerMemory)),
		);
		expect(calls).toBe(2);
	});

	it('settles interruption and releases the claim before a later request retries', async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				const first = yield* Effect.forkChild(
					BotRuntime.dispatch(
						{ update_id: 73 },
						{
							route: () =>
								Effect.andThen(
									Deferred.succeed(entered, undefined),
									Effect.never,
								),
						},
					),
				);
				yield* Deferred.await(entered);
				yield* Fiber.interrupt(first);
				expect(
					yield* BotRuntime.dispatch(
						{ update_id: 73 },
						{
							route: () => Effect.succeed(DispatchOutcome.handled),
						},
					),
				).toEqual({ _tag: 'Handled' });
			}).pipe(Effect.provide(MemoryUpdateDeduplicator.layerMemory)),
		);
	});
});

import type { DurableObjectState } from '@cloudflare/workers-types';
import { Effect, Layer } from 'effect';
import * as DispatchOutcome from 'tfx/DispatchOutcome';
import { JobRuntime } from 'tfx/JobRuntime';
import { JobWakeup } from 'tfx/JobWakeup';
import * as MemoryUpdateDeduplicator from 'tfx/MemoryUpdateDeduplicator';
import { describe, expect, it, vi } from 'vitest';

import * as Runtime from '../src/Runtime.js';

describe('Cloudflare dispatch budget and cleanup', () => {
	it.each([
		{
			timeout: '20 seconds' as const,
			work: 14_000,
			deadline: 18_000,
			status: 200,
		},
		{
			timeout: '20 seconds' as const,
			work: 60_000,
			deadline: 23_000,
			status: 503,
		},
		{ timeout: undefined, work: 60_000, deadline: 13_000, status: 503 },
	])(
		'settles with $status at $deadline ms for $timeout',
		async ({ timeout, work, deadline, status }) => {
			// Runtime owns a separate runPromise boundary. Fake host timers cover its
			// deadline as well as the supplied graph, unlike a graph-local TestClock.
			vi.useFakeTimers();
			vi.setSystemTime(0);
			try {
				const started = Promise.withResolvers<void>();
				const acquired = Promise.withResolvers<void>();
				const closing = Promise.withResolvers<void>();
				let closed = false;
				let gateHeld = false;
				let response: { readonly status: number } | undefined;
				const hosting = Runtime.make({
					botId: 'test',
					...(timeout === undefined ? {} : { dispatchTimeout: timeout }),
					layer: () =>
						Layer.mergeAll(
							Layer.mock(JobRuntime, {}),
							Layer.mock(JobWakeup, {}),
							MemoryUpdateDeduplicator.layerMemory,
							Layer.effectDiscard(
								Effect.acquireRelease(
									Effect.gen(function* () {
										started.resolve();
										yield* Effect.sleep(1000);
										acquired.resolve();
									}),
									() =>
										Effect.gen(function* () {
											closing.resolve();
											yield* Effect.sleep(3000);
											closed = true;
										}),
								),
							),
						),
					// 14s models the real ping's 10s sleep plus 4s of Telegram output.
					router: () =>
						Effect.succeed({
							route: () =>
								Effect.as(Effect.sleep(work), DispatchOutcome.handled),
						}),
				});
				const state = {
					blockConcurrencyWhile: async <A>(run: () => Promise<A>) => {
						gateHeld = true;
						try {
							return await run();
						} finally {
							gateHeld = false;
						}
					},
				} as unknown as DurableObjectState;
				const object = new hosting.ChatDispatch(state, {} as never);
				const fetch = object.fetch;
				if (fetch === undefined) throw new Error('Missing fetch');
				const pending = Promise.resolve(
					fetch.call(
						object,
						new Request('https://dispatch.test/telegram', {
							method: 'POST',
							body: JSON.stringify({ update_id: 1 }),
						}) as never,
					),
				).then((value) => {
					response = value;
				});
				await started.promise;
				await vi.advanceTimersByTimeAsync(1000);
				await acquired.promise;
				await vi.advanceTimersByTimeAsync(deadline - 4000);
				await closing.promise;
				expect(gateHeld).toBe(true);
				expect(closed).toBe(false);
				expect(response).toBeUndefined();
				await vi.advanceTimersByTimeAsync(2999);
				expect(gateHeld).toBe(true);
				expect(response).toBeUndefined();
				await vi.advanceTimersByTimeAsync(1);
				await pending;
				expect(response?.status).toBe(status);
				expect(closed).toBe(true);
				expect(gateHeld).toBe(false);
				expect(Date.now()).toBe(deadline);
			} finally {
				vi.useRealTimers();
			}
		},
	);
});

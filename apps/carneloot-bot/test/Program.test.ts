import { Effect, Layer } from 'effect';
import { BotRuntime } from 'tfx/BotRuntime';
import * as UpdateDeduplicator from 'tfx/UpdateDeduplicator';
import { describe, expect, it } from 'vitest';

import { JobWorker } from '../src/JobWorker.js';
import * as Program from '../src/Program.js';

const bot = (awaitEffect: Effect.Effect<void, unknown>) =>
	Layer.succeed(BotRuntime, {
		dispatch: () => Effect.die('unused'),
		await: awaitEffect,
	});
const worker = (awaitEffect: Effect.Effect<void, unknown>) =>
	Layer.succeed(JobWorker, {
		await: awaitEffect,
		diagnostics: { recoveredDeliveries: 0, startupProblems: [] },
		problems: Effect.succeed([]),
	});
describe('Program', () => {
	it('refuses non-durable deduplication', async () => {
		const exit = await Effect.runPromiseExit(
			Effect.provide(
				Program.run,
				Layer.mergeAll(
					bot(Effect.never),
					worker(Effect.never),
					UpdateDeduplicator.layerNoop,
				),
			),
		);
		expect(exit._tag).toBe('Failure');
	});
	it('fails fast when either retained lifecycle fails', async () => {
		const durable = Layer.succeed(UpdateDeduplicator.UpdateDeduplicator, {
			diagnostics: { mode: 'durable', backend: 'test' },
		} as never);
		const result = await Effect.runPromise(
			Effect.result(
				Effect.provide(
					Program.run,
					Layer.mergeAll(
						bot(Effect.never),
						worker(Effect.fail('worker failed')),
						durable,
					),
				),
			),
		);
		expect(result).toMatchObject({
			_tag: 'Failure',
			failure: 'worker failed',
		});
	});
});

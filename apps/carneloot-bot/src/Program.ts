import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { BotRuntime } from 'tfx/BotRuntime';
import { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';

import { JobWorker } from './JobWorker.js';

export const run = Effect.gen(function* () {
	const dedup = yield* UpdateDeduplicator;
	if (dedup.diagnostics.mode !== 'durable')
		return yield* Effect.die(
			new Error('Production program requires durable update deduplication'),
		);
	const bot = yield* BotRuntime;
	const worker = yield* JobWorker;
	return yield* Effect.raceFirst(bot.await, worker.await);
});

/** Portable scoped factory; platform-specific entry points provide one graph. */
export const fromLayer = <E, R>(
	layer: Layer.Layer<BotRuntime | JobWorker | UpdateDeduplicator, E, R>,
): Effect.Effect<void, E | unknown, R> =>
	Effect.scoped(
		Effect.flatMap(Layer.build(layer), (context) =>
			Effect.provide(run, context),
		),
	);

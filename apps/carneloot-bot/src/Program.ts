import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { BotRuntime, type BotRuntimeSourceError } from 'tfx/BotRuntime';
import type { TaggedError } from 'tfx/TaggedError';
import { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';

import { JobWorker, type JobWorkerError } from './JobWorker.js';

export class ReleaseSmokeHealthError extends Data.TaggedError(
	'ReleaseSmokeHealthError',
)<{ readonly quarantinedJobIds: ReadonlyArray<string> }> {}
export type ProgramError = BotRuntimeSourceError | JobWorkerError;
export const releaseSmokeHealth = Effect.gen(function* () {
	const worker = yield* JobWorker;
	const quarantined = (yield* worker.problems)
		.filter((job) => job.status === 'quarantined')
		.map((job) => job.id);
	if (quarantined.length > 0)
		return yield* Effect.fail(
			new ReleaseSmokeHealthError({ quarantinedJobIds: quarantined }),
		);
});

export const run = Effect.gen(function* () {
	const dedup = yield* UpdateDeduplicator;
	if (dedup.diagnostics.mode !== 'durable')
		return yield* Effect.die(
			new Error('Production program requires durable update deduplication'),
		);
	const bot = yield* BotRuntime;
	const worker = yield* JobWorker;
	if (worker.diagnostics.startupProblems.length > 0)
		yield* Effect.logWarning('Job worker started with problem jobs', {
			failedJobIds: worker.diagnostics.failedJobIds,
			quarantinedJobIds: worker.diagnostics.quarantinedJobIds,
		});
	return yield* Effect.raceFirst(bot.await, worker.await);
});

/** Portable scoped factory; platform-specific entry points provide one graph. */
export const fromLayer = <E extends TaggedError, R>(
	layer: Layer.Layer<BotRuntime | JobWorker | UpdateDeduplicator, E, R>,
) =>
	Effect.scoped(
		Effect.flatMap(Layer.build(layer), (context) =>
			Effect.provide(run, context),
		),
	);

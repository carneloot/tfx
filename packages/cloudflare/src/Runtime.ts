import * as Effect from 'effect/Effect';
import type * as Layer from 'effect/Layer';
import type { Router } from 'tfx/BotRouter';
import * as BotRuntime from 'tfx/BotRuntime';
import { JobRuntime } from 'tfx/JobRuntime';
import { JobWakeup } from 'tfx/JobWakeup';
import { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';

import * as Worker from './Worker.js';

/** Event hosting without an update source, retained runtime, or background worker. */
export const make = <
	Env extends Worker.Bindings,
	R,
	E,
	RecoveryError = never,
>(options: {
	readonly botId: string;
	readonly layer: (
		env: Env,
	) => Layer.Layer<R | JobRuntime | JobWakeup | UpdateDeduplicator, E>;
	readonly router: (env: Env) => Effect.Effect<Router, never, NoInfer<R>>;
	readonly beforeJobs?: Effect.Effect<unknown, RecoveryError, NoInfer<R>>;
}) =>
	Worker.make<Env>({
		botId: options.botId,
		dispatch: (env, update) =>
			Effect.runPromise(
				Effect.gen(function* () {
					const router = yield* options.router(env);
					return yield* BotRuntime.dispatch(update, router);
				}).pipe(
					Effect.provide(options.layer(env)),
					Effect.timeout('10 seconds'),
					Effect.tap((outcome) =>
						Effect.logInfo('tfx.cloudflare.update').pipe(
							Effect.annotateLogs({
								updateId: update.update_id,
								outcome: outcome._tag,
							}),
						),
					),
				),
			),
		reconcile: (env, arm) =>
			Effect.runPromise(
				Effect.gen(function* () {
					if (options.beforeJobs !== undefined) yield* options.beforeJobs;
					const wakeup = yield* JobWakeup;
					const snapshot = yield* wakeup.snapshot;
					yield* Effect.tryPromise(() => arm(snapshot.deadline));
					yield* wakeup.acknowledge(snapshot);
				}).pipe(
					Effect.provide(options.layer(env)),
					Effect.timeout('10 seconds'),
				),
			),
		runJobs: (env) =>
			Effect.runPromise(
				Effect.gen(function* () {
					if (options.beforeJobs !== undefined) yield* options.beforeJobs;
					const jobs = yield* JobRuntime;
					for (let processed = 0; processed < 50; processed++) {
						if ((yield* jobs.runOne()) === undefined) break;
					}
				}).pipe(
					Effect.provide(options.layer(env)),
					Effect.timeout('10 seconds'),
				),
			),
	});

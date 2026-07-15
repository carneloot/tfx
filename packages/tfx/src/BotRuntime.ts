import * as Context from 'effect/Context';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';

import type * as Bot from './Bot.js';
import type { DispatchOutcome } from './DispatchOutcome.js';
import * as Dispatcher from './internal/runtime/Dispatcher.js';
import * as Router from './internal/runtime/Router.js';
import type { Update } from './internal/telegram/generated/TelegramApi.types.js';
import { UpdateSource } from './internal/update-source/UpdateSource.js';
import * as Partitioning from './Partitioning.js';
import { UpdateDeduplicator } from './UpdateDeduplicator.js';
import type * as UpdateDelivery from './UpdateDelivery.js';
export class BotRuntimeSourceError extends Data.TaggedError(
	'BotRuntimeSourceError',
)<{ readonly cause: unknown }> {}

export interface BotRuntimeService {
	readonly dispatch: (update: Update) => Effect.Effect<DispatchOutcome, never>;
	/** Joins the retained update-source fiber. Source success/failure is observable. */
	readonly await: Effect.Effect<void, BotRuntimeSourceError>;
}
export class BotRuntime extends Context.Service<
	BotRuntime,
	BotRuntimeService
>()('tfx/BotRuntime') {}
export interface Options<
	D extends UpdateDelivery.UpdateDelivery<any, any, any>,
> {
	readonly delivery: D;
	readonly partitioning?: Partitioning.Partitioning;
	readonly concurrency?: number;
	readonly capacity?: number;
	readonly router?: Router.Router;
	readonly leaseDuration?: number;
	readonly waitTimeout?: number;
	readonly retention?: number;
	readonly heartbeatInterval?: number;
}
export const layer = <
	B extends Bot.Bot<any, any>,
	D extends UpdateDelivery.UpdateDelivery<any, any, any>,
>(
	bot: B,
	options: Options<D>,
): Layer.Layer<
	BotRuntime,
	UpdateDelivery.Error<D>,
	UpdateDelivery.Requirements<D> | UpdateDeduplicator
> => {
	const runtime = Layer.effect(
		BotRuntime,
		Effect.gen(function* () {
			for (const [name, value] of [
				['leaseDuration', options.leaseDuration],
				['waitTimeout', options.waitTimeout],
				['retention', options.retention],
				['heartbeatInterval', options.heartbeatInterval],
			] as const)
				if (value !== undefined && (!Number.isFinite(value) || value <= 0))
					return yield* Effect.die(
						new Error(`${name} must be finite and positive`),
					);
			const leaseDuration = options.leaseDuration ?? 30_000;
			if (
				options.heartbeatInterval !== undefined &&
				options.heartbeatInterval >= leaseDuration
			)
				return yield* Effect.die(
					new Error('heartbeatInterval must be less than leaseDuration'),
				);
			const source = yield* UpdateSource;
			const deduplicator = yield* UpdateDeduplicator;
			const dispatcher = yield* Dispatcher.make({
				botId: bot.name,
				partitioning: options.partitioning ?? Partitioning.byChat,
				concurrency: options.concurrency ?? 16,
				capacity: options.capacity ?? 1024,
				deduplicator,
				router: options.router ?? Router.make(),
				...(options.leaseDuration === undefined
					? {}
					: { leaseDuration: options.leaseDuration }),
				...(options.waitTimeout === undefined
					? {}
					: { waitTimeout: options.waitTimeout }),
				...(options.retention === undefined
					? {}
					: { retention: options.retention }),
				...(options.heartbeatInterval === undefined
					? {}
					: { heartbeatInterval: options.heartbeatInterval }),
			});
			const sourceFiber = yield* Effect.forkScoped(
				source.run(dispatcher.dispatch),
			);
			return {
				dispatch: dispatcher.dispatch,
				await: Fiber.join(sourceFiber).pipe(
					Effect.mapError((cause) => new BotRuntimeSourceError({ cause })),
				),
			};
		}),
	);
	return Layer.provide(runtime, options.delivery.layer);
};

import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
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
export interface BotRuntimeService {
	readonly dispatch: (update: Update) => Effect.Effect<DispatchOutcome, never>;
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
			const source = yield* UpdateSource;
			const deduplicator = yield* UpdateDeduplicator;
			const dispatcher = yield* Dispatcher.make({
				botId: bot.name,
				partitioning: options.partitioning ?? Partitioning.byChat,
				concurrency: options.concurrency ?? 16,
				capacity: options.capacity ?? 1024,
				deduplicator,
				router: options.router ?? Router.make(),
			});
			yield* Effect.forkScoped(source.run(dispatcher.dispatch));
			return { dispatch: dispatcher.dispatch };
		}),
	);
	return Layer.provide(runtime, options.delivery.layer) as never;
};

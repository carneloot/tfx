import * as Context from 'effect/Context';
import * as Data from 'effect/Data';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';

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
	readonly leaseDuration?: Duration.Input;
	readonly waitTimeout?: Duration.Input;
	readonly retention?: Duration.Input;
	readonly heartbeatInterval?: Duration.Input;
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
			const normalize = (
				input: Duration.Input | undefined,
				fallback: Duration.Duration,
				name: string,
			) => {
				const value = Option.getOrElse(
					Duration.fromInput(input ?? fallback),
					() => Duration.infinity,
				);
				if (!Duration.isFinite(value) || !Duration.isPositive(value))
					throw new TypeError(`${name} must be finite and positive`);
				return value;
			};
			const leaseDuration = normalize(
				options.leaseDuration,
				Duration.seconds(30),
				'leaseDuration',
			);
			const waitTimeout = normalize(
				options.waitTimeout,
				Duration.seconds(5),
				'waitTimeout',
			);
			const retention = normalize(
				options.retention,
				Duration.days(1),
				'retention',
			);
			const heartbeatInterval = normalize(
				options.heartbeatInterval,
				Duration.millis(
					Math.max(1, Math.floor(Duration.toMillis(leaseDuration) / 3)),
				),
				'heartbeatInterval',
			);
			if (!Duration.isLessThan(heartbeatInterval, leaseDuration))
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
				leaseDuration,
				waitTimeout,
				retention,
				heartbeatInterval,
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

import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import type { DispatchOutcome } from './DispatchOutcome.js';
import type { Update } from './internal/telegram/generated/TelegramApi.types.js';
import {
	UpdateSource,
	type UpdateSourceService,
} from './internal/update-source/UpdateSource.js';
import type { TaggedError } from './TaggedError.js';
const TypeId: unique symbol = Symbol.for('tfx/UpdateDelivery');
export interface UpdateDelivery<
	Id extends string,
	Error extends TaggedError,
	Requirements,
> {
	readonly [TypeId]: typeof TypeId;
	readonly id: Id;
	readonly layer: Layer.Layer<UpdateSource, Error, Requirements>;
}
/** Low-level constructor retained for platform delivery implementations. */
export const make = <
	const Id extends string,
	E extends TaggedError,
	R,
>(options: {
	readonly id: Id;
	readonly layer: Layer.Layer<UpdateSource, E, R>;
}): UpdateDelivery<Id, E, R> =>
	Object.freeze({ [TypeId]: TypeId as typeof TypeId, ...options });

/** Public source constructor; internal UpdateSource service never escapes the API. */
export const fromSource = <
	const Id extends string,
	E extends TaggedError = never,
	R = never,
>(
	id: Id,
	run: (
		deliver: (update: Update) => Effect.Effect<DispatchOutcome, never>,
	) => Effect.Effect<void, E, R>,
): UpdateDelivery<Id, E, R> =>
	make({
		id,
		layer: Layer.effect(
			UpdateSource,
			Effect.map(
				Effect.context<R>(),
				(context) =>
					Object.freeze({
						run: (
							deliver: (
								update: Update,
							) => Effect.Effect<DispatchOutcome, never>,
						) => Effect.provide(run(deliver), context),
					}) satisfies UpdateSourceService,
			),
		),
	});

/** Manual/test delivery keeps source alive while callers invoke BotRuntime.dispatch. */
export const manual = fromSource('manual', () => Effect.never);
export const test = manual;

export type Error<D> = D extends UpdateDelivery<any, infer E, any> ? E : never;
export type Requirements<D> =
	D extends UpdateDelivery<any, any, infer R> ? R : never;

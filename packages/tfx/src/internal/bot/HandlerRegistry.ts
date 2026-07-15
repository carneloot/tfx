import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';

import type * as Middleware from '../../Middleware.js';

export interface HandlerEntry<
	Input = unknown,
	Output = unknown,
	HandlerError = never,
	Requirements = never,
	MiddlewareError = never,
> {
	readonly groupId: string;
	readonly commandId: string;
	readonly middlewareIds: ReadonlyArray<string>;
	readonly handler: (
		input: Input,
	) => Effect.Effect<Output, HandlerError, Requirements>;
	/** Plan06 dispatch bridge: applies registered middleware before invoking raw handler. */
	readonly invoke: (
		registry: Middleware.MiddlewareRegistryService,
		input: Input,
	) => Effect.Effect<Output, HandlerError | MiddlewareError, Requirements>;
}

/** Runtime registry intentionally erases individual entry types after builder validation. */
export type AnyHandlerEntry = HandlerEntry<any, any, any, any, any>;
export class HandlerRegistry extends Context.Service<
	HandlerRegistry,
	ReadonlyArray<AnyHandlerEntry>
>()('tfx/internal/bot/HandlerRegistry') {}

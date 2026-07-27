import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';

import type * as MessageHandlerResult from '../../MessageHandlerResult.js';
import type * as Middleware from '../../Middleware.js';
interface Base<I, O, E, R, ME> {
	readonly groupId: string;
	readonly middlewareIds: ReadonlyArray<string>;
	readonly handler: (input: I) => Effect.Effect<O, E, R>;
	readonly invoke: (
		registry: Middleware.MiddlewareRegistryService,
		input: I,
	) => Effect.Effect<O, E | ME, R>;
}
export interface CommandHandlerEntry<
	I = unknown,
	O = unknown,
	E = never,
	R = never,
	ME = never,
> extends Base<I, O, E, R, ME> {
	readonly _tag: 'Command';
	readonly commandId: string;
}
export interface MessageHandlerEntry<
	I = unknown,
	E = never,
	R = never,
	ME = never,
> extends Base<I, MessageHandlerResult.MessageHandlerResult, E, R, ME> {
	readonly _tag: 'Message';
	readonly messageHandlerId: string;
}
export type AnyHandlerEntry =
	| CommandHandlerEntry<any, any, any, any, any>
	| MessageHandlerEntry<any, any, any, any>;
export class HandlerRegistry extends Context.Service<
	HandlerRegistry,
	ReadonlyArray<AnyHandlerEntry>
>()('tfx/internal/bot/HandlerRegistry') {}

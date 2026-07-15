import type * as Schema from 'effect/Schema';

import type * as ConversationInput from './ConversationInput.js';
import type * as Middleware from './Middleware.js';
import type * as VersionedSchema from './VersionedSchema.js';

export interface Step<
	Id extends string,
	State,
	Input extends ConversationInput.ConversationInput<any, any, any>,
> {
	readonly id: Id;
	readonly state: Schema.Schema<State>;
	readonly input: Input;
}
export const step = <
	const Id extends string,
	State,
	Input extends ConversationInput.ConversationInput<any, any, any>,
>(
	id: Id,
	options: { readonly state: Schema.Schema<State>; readonly input: Input },
): Step<Id, State, Input> => Object.freeze({ id, ...options });
export type AnyStep = Step<string, any, any>;
export type StartupOf<C> =
	C extends Conversation<any, infer A, any, any, any, any> ? A : never;
export type StateOf<S> = S extends Step<any, infer A, any> ? A : never;
export type InputOf<S> =
	S extends Step<any, any, infer I> ? ConversationInput.Decoded<I> : never;
export type Persisted<Steps extends Readonly<Record<string, AnyStep>>> = {
	[K in keyof Steps]: { readonly step: K; readonly state: StateOf<Steps[K]> };
}[keyof Steps];
export interface Conversation<
	Id extends string,
	Startup,
	Steps extends Readonly<Record<string, AnyStep>>,
	Initial extends keyof Steps,
	Error,
	M extends ReadonlyArray<Middleware.AnyMiddleware>,
> {
	readonly _tag: 'Conversation';
	readonly id: Id;
	readonly version: number;
	readonly startup: Schema.Schema<Startup>;
	readonly steps: Steps;
	readonly initialStep: Initial;
	readonly initialize: (input: Startup) => StateOf<Steps[Initial]>;
	readonly error: Error | undefined;
	readonly middleware: M;
	readonly idleTimeout: number | undefined;
	readonly migrations: VersionedSchema.History<any> | undefined;
}
export interface Options<
	Startup,
	Steps extends Readonly<Record<string, AnyStep>>,
	Initial extends keyof Steps,
	Error,
	M extends ReadonlyArray<Middleware.AnyMiddleware>,
> {
	readonly version: number;
	readonly startup: Schema.Schema<Startup>;
	readonly steps: Steps;
	readonly initialStep: Initial;
	readonly initialize: (input: Startup) => StateOf<Steps[Initial]>;
	readonly error?: Error;
	readonly middleware?: M;
	readonly idleTimeout?: number;
	readonly migrations?: VersionedSchema.History<any>;
}
export const make = <
	const Id extends string,
	Startup,
	const Steps extends Readonly<Record<string, AnyStep>>,
	const Initial extends keyof Steps,
	Error = never,
	const M extends ReadonlyArray<Middleware.AnyMiddleware> = readonly [],
>(
	id: Id,
	options: Options<Startup, Steps, Initial, Error, M>,
): Conversation<Id, Startup, Steps, Initial, Error, M> => {
	if (!Number.isInteger(options.version) || options.version <= 0)
		throw new Error('Conversation version must be positive');
	if (!(options.initialStep in options.steps))
		throw new Error(`Unknown initial step '${String(options.initialStep)}'`);
	if (options.idleTimeout !== undefined && options.idleTimeout <= 0)
		throw new Error('idleTimeout must be positive');
	return Object.freeze({
		_tag: 'Conversation',
		id,
		version: options.version,
		startup: options.startup,
		steps: Object.freeze({ ...options.steps }),
		initialStep: options.initialStep,
		initialize: options.initialize,
		error: options.error,
		middleware: Object.freeze([...(options.middleware ?? [])]) as unknown as M,
		idleTimeout: options.idleTimeout,
		migrations: options.migrations,
	});
};

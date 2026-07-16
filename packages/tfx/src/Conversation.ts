import * as Duration from 'effect/Duration';
import * as Option from 'effect/Option';
import type * as Schema from 'effect/Schema';

import type * as ConversationInput from './ConversationInput.js';
import type * as ErrorSchema from './ErrorSchema.js';
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
export type ErrorOf<C> =
	C extends Conversation<any, any, any, any, infer ES, any>
		? ErrorSchema.ErrorOf<ES>
		: never;
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
	ES extends ErrorSchema.ErrorSchema,
	M extends ReadonlyArray<Middleware.AnyMiddleware>,
> {
	readonly _tag: 'Conversation';
	readonly id: Id;
	readonly version: number;
	readonly startup: Schema.Schema<Startup>;
	readonly steps: Steps;
	readonly initialStep: Initial;
	readonly initialize: (input: Startup) => StateOf<Steps[Initial]>;
	readonly error: ES;
	readonly middleware: M;
	readonly idleTimeout: Duration.Duration | undefined;
	readonly migrations: VersionedSchema.AnyHistory | undefined;
}
export interface Options<
	Startup,
	Steps extends Readonly<Record<string, AnyStep>>,
	Initial extends keyof Steps,
	ES extends ErrorSchema.ErrorSchema,
	M extends ReadonlyArray<Middleware.AnyMiddleware>,
> {
	readonly version: number;
	readonly startup: Schema.Schema<Startup>;
	readonly steps: Steps;
	readonly initialStep: Initial;
	readonly initialize: (input: Startup) => StateOf<Steps[Initial]>;
	readonly error: ES;
	readonly middleware?: M;
	readonly idleTimeout?: Duration.Input;
	readonly migrations?: VersionedSchema.AnyHistory;
}
export const make = <
	const Id extends string,
	Startup,
	const Steps extends Readonly<Record<string, AnyStep>>,
	const Initial extends keyof Steps,
	ES extends ErrorSchema.ErrorSchema,
	const M extends ReadonlyArray<Middleware.AnyMiddleware> = readonly [],
>(
	id: Id,
	options: Options<Startup, Steps, Initial, ES, M> & {
		readonly error: ErrorSchema.Valid<ES>;
	},
): Conversation<Id, Startup, Steps, Initial, ES, M> => {
	if (!Number.isInteger(options.version) || options.version <= 0)
		throw new Error('Conversation version must be positive');
	if (!(options.initialStep in options.steps))
		throw new Error(`Unknown initial step '${String(options.initialStep)}'`);
	const idleTimeout =
		options.idleTimeout === undefined
			? undefined
			: Option.getOrThrowWith(
					Duration.fromInput(options.idleTimeout),
					() => new TypeError('idleTimeout is not a valid Duration input'),
				);
	if (
		idleTimeout !== undefined &&
		(!Duration.isFinite(idleTimeout) || !Duration.isPositive(idleTimeout))
	)
		throw new TypeError('idleTimeout must be finite and positive');
	if (
		options.migrations !== undefined &&
		options.migrations.latest.version !== options.version
	)
		throw new Error(
			`Conversation version ${options.version} does not match migration history latest version ${options.migrations.latest.version}`,
		);
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
		idleTimeout,
		migrations: options.migrations,
	});
};

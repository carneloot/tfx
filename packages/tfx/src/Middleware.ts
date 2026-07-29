import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import type * as ErrorSchema from './ErrorSchema.js';
import type { TaggedError } from './ErrorSchema.js';

export type Scope = 'global' | 'group' | 'command' | 'conversation' | 'handler';

type AnyKey = Context.Key<any, any>;
type Identifier<K> = K extends Context.Key<infer I, any> ? I : never;
type Service<K> = K extends Context.Key<any, infer S> ? S : never;

export interface Middleware<
	Id extends string,
	S extends Scope,
	Provides extends AnyKey,
	Requires,
	ES extends ErrorSchema.ErrorSchema,
> {
	readonly _tag: 'Middleware';
	readonly id: Id;
	readonly scope: S;
	readonly provides: Provides;
	/** Request prerequisites, in declaration order. */
	readonly requires: ReadonlyArray<AnyKey>;
	readonly _requires: Requires;
	readonly error: ES;
}

export interface Options<
	S extends Scope,
	Provides extends AnyKey,
	Requires extends ReadonlyArray<AnyKey>,
	ES extends ErrorSchema.ErrorSchema,
> {
	readonly scope: S;
	readonly provides: Provides;
	/** Request service keys which must have been provided earlier. */
	readonly requires?: Requires;
	/** Type witness for failures permitted while processing middleware. */
	readonly error: ES;
}

export const make = <
	const Id extends string,
	const S extends Scope,
	Provides extends AnyKey,
	ES extends ErrorSchema.ErrorSchema,
	const Requires extends ReadonlyArray<AnyKey> = readonly [],
>(
	id: Id,
	options: Options<S, Provides, Requires, ES> & {
		readonly error: ErrorSchema.Valid<ES>;
	},
): Middleware<Id, S, Provides, Identifier<Requires[number]>, ES> =>
	Object.freeze({
		_tag: 'Middleware' as const,
		id,
		scope: options.scope,
		provides: options.provides,
		requires: Object.freeze([...(options.requires ?? [])]),
		error: options.error,
		_requires: undefined as Identifier<Requires[number]>,
	});

export type AnyMiddleware = Middleware<string, Scope, AnyKey, any, any>;
export type Provided<D> =
	D extends Middleware<any, any, infer K, any, any> ? Identifier<K> : never;
export type Required<D> =
	D extends Middleware<any, any, any, infer R, any> ? R : never;
export type ProvidedBy<Items extends ReadonlyArray<AnyMiddleware>> = Provided<
	Items[number]
>;
export type DeclaredErrors<Items extends ReadonlyArray<AnyMiddleware>> =
	Items[number] extends infer D
		? D extends Middleware<any, any, any, any, infer ES>
			? ErrorSchema.ErrorOf<ES>
			: never
		: never;
export type ValidOrder<
	Items extends ReadonlyArray<AnyMiddleware>,
	Available = never,
> = Items extends readonly [
	infer Head extends AnyMiddleware,
	...infer Tail extends readonly AnyMiddleware[],
]
	? [Required<Head>] extends [Available]
		? ValidOrder<Tail, Available | Provided<Head>>
		: false
	: true;

type DeclaredError<D> =
	D extends Middleware<any, any, any, any, infer ES>
		? ErrorSchema.ErrorOf<ES>
		: never;
export interface Application<D extends AnyMiddleware, Infrastructure, Error> {
	readonly declaration: D;
	readonly effect: Effect.Effect<
		Service<D['provides']>,
		Error,
		Required<D> | Infrastructure
	>;
	readonly _infrastructure: Infrastructure;
}

/** Bind pure middleware metadata to request processing. Infrastructure stays in the resulting program environment. */
export const implement = <
	D extends AnyMiddleware,
	E extends DeclaredError<D>,
	R,
>(
	declaration: D,
	effect: Effect.Effect<Service<D['provides']>, E, R>,
): Application<D, Exclude<R, Required<D>>, E> => ({
	declaration,
	effect: effect as Effect.Effect<
		Service<D['provides']>,
		E,
		Required<D> | Exclude<R, Required<D>>
	>,
	_infrastructure: undefined as Exclude<R, Required<D>>,
});

export type AnyApplication = Application<AnyMiddleware, any, any>;
type AppRequired<A> =
	A extends Application<infer D, any, any> ? Required<D> : never;
type AppProvided<A> =
	A extends Application<infer D, any, any> ? Provided<D> : never;
type AppInfrastructure<A> =
	A extends Application<any, infer R, any> ? R : never;
type AppError<A> = A extends Application<any, any, infer E> ? E : never;

const scopeRank: Record<Scope, number> = {
	global: 0,
	group: 1,
	command: 2,
	conversation: 2,
	handler: 3,
};

export interface Pipeline<Available, Infrastructure, Error> {
	readonly _available: Available;
	readonly _infrastructure: Infrastructure;
	readonly applications: ReadonlyArray<AnyApplication>;
	use<A extends AnyApplication>(
		application: A & ([AppRequired<A>] extends [Available] ? unknown : never),
	): Pipeline<
		Available | AppProvided<A>,
		Infrastructure | AppInfrastructure<A>,
		Error | AppError<A>
	>;
	run<A, E, R>(
		effect: Effect.Effect<A, E, R | Available>,
	): Effect.Effect<A, E | Error, Exclude<R, Available> | Infrastructure>;
}

const build = <Available, Infrastructure, Error>(
	applications: ReadonlyArray<AnyApplication>,
): Pipeline<Available, Infrastructure, Error> => ({
	_available: undefined as Available,
	_infrastructure: undefined as Infrastructure,
	applications,
	use(application) {
		const previous = applications.at(-1);
		if (
			previous !== undefined &&
			scopeRank[application.declaration.scope] <
				scopeRank[previous.declaration.scope]
		) {
			throw new Error(
				`Middleware '${application.declaration.id}' (${application.declaration.scope}) cannot follow '${previous.declaration.id}' (${previous.declaration.scope})`,
			);
		}
		return build([...applications, application]);
	},
	run(effect) {
		const execute = (index: number): Effect.Effect<any, any, any> => {
			if (index === applications.length) return effect;
			const application = applications[index]!;
			return Effect.gen(function* () {
				const service = yield* application.effect;
				return yield* Effect.provideService(
					execute(index + 1),
					application.declaration.provides,
					service,
				);
			});
		};
		return execute(0);
	},
});

/** Empty immutable request pipeline. Applications execute in declaration order. */
export const empty: Pipeline<never, never, never> = build([]);

type ApplicationsInfrastructure<A extends ReadonlyArray<AnyApplication>> =
	AppInfrastructure<A[number]>;
export type ApplicationsError<A extends ReadonlyArray<AnyApplication>> =
	AppError<A[number]>;

export class MiddlewareRegistryError extends Error {
	readonly _tag = 'MiddlewareRegistryError';
	constructor(readonly middlewareId: string) {
		super(`Missing middleware implementation '${middlewareId}'`);
	}
}

export interface MiddlewareRegistryService {
	readonly applications: Readonly<Record<string, AnyApplication>>;
	/** Execute selected applications in declaration order around a request effect. */
	readonly run: <A, E extends TaggedError, R>(
		ids: ReadonlyArray<string>,
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | TaggedError | MiddlewareRegistryError, R>;
}

export class MiddlewareRegistry extends Context.Service<
	MiddlewareRegistry,
	MiddlewareRegistryService
>()('tfx/MiddlewareRegistry') {}

const registry = (
	applications: ReadonlyArray<AnyApplication>,
	infrastructure: Context.Context<never>,
): MiddlewareRegistryService => {
	const byId: Record<string, AnyApplication> = Object.create(null);
	for (const application of applications) {
		const id = application.declaration.id;
		if (byId[id] !== undefined)
			throw new Error(`Duplicate middleware implementation '${id}'`);
		byId[id] = application;
	}
	const run: MiddlewareRegistryService['run'] = (ids, effect) =>
		Effect.suspend(() => {
			const selected: Array<AnyApplication> = [];
			for (const id of ids) {
				const application = byId[id];
				if (application === undefined)
					return Effect.fail(new MiddlewareRegistryError(id));
				selected.push(application);
			}
			const execute = (index: number): Effect.Effect<any, any, any> => {
				if (index === selected.length) return effect;
				const application = selected[index]!;
				return Effect.gen(function* () {
					const current = yield* Effect.context<any>();
					const service = yield* Effect.provide(
						application.effect,
						Context.merge(infrastructure, current),
					);
					return yield* Effect.provideService(
						execute(index + 1),
						application.declaration.provides,
						service,
					);
				});
			};
			return execute(0);
		});
	return Object.freeze({ applications: Object.freeze(byId), run });
};

/** Capture implementation infrastructure once; middleware effects still execute once per request. */
export const layer = <const A extends ReadonlyArray<AnyApplication>>(
	...applications: A
): Layer.Layer<MiddlewareRegistry, never, ApplicationsInfrastructure<A>> =>
	Layer.effect(
		MiddlewareRegistry,
		Effect.map(Effect.context<ApplicationsInfrastructure<A>>(), (context) =>
			registry(applications, context as Context.Context<never>),
		),
	);

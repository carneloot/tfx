import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"

export type Scope = "global" | "group" | "command" | "conversation" | "handler"

type AnyKey = Context.Key<any, any>
type Identifier<K> = K extends Context.Key<infer I, any> ? I : never
type Service<K> = K extends Context.Key<any, infer S> ? S : never

export interface Middleware<
  Id extends string,
  S extends Scope,
  Provides extends AnyKey,
  Requires,
  Error
> {
  readonly _tag: "Middleware"
  readonly id: Id
  readonly scope: S
  readonly provides: Provides
  /** Request prerequisites, in declaration order. */
  readonly requires: ReadonlyArray<AnyKey>
  readonly _requires: Requires
  readonly _error: Error
}

export interface Options<S extends Scope, Provides extends AnyKey, Requires extends ReadonlyArray<AnyKey>, Error> {
  readonly scope: S
  readonly provides: Provides
  /** Request service keys which must have been provided earlier. */
  readonly requires?: Requires
  /** Type witness for failures permitted while processing middleware. */
  readonly error?: Error
}

export const make = <
  const Id extends string,
  const S extends Scope,
  Provides extends AnyKey,
  const Requires extends ReadonlyArray<AnyKey> = readonly [],
  Error = never
>(id: Id, options: Options<S, Provides, Requires, Error>): Middleware<Id, S, Provides, Identifier<Requires[number]>, Error> => Object.freeze({
  _tag: "Middleware" as const,
  id,
  scope: options.scope,
  provides: options.provides,
  requires: Object.freeze([...(options.requires ?? [])]),
  _requires: undefined as Identifier<Requires[number]>,
  _error: undefined as Error
})

export type AnyMiddleware = Middleware<string, Scope, AnyKey, any, any>
export type Provided<D> = D extends Middleware<any, any, infer K, any, any> ? Identifier<K> : never
export type Required<D> = D extends Middleware<any, any, any, infer R, any> ? R : never
export type ProvidedBy<Items extends ReadonlyArray<AnyMiddleware>> = Provided<Items[number]>
export type ValidOrder<Items extends ReadonlyArray<AnyMiddleware>, Available = never> =
  Items extends readonly [infer Head extends AnyMiddleware, ...infer Tail extends readonly AnyMiddleware[]]
    ? [Required<Head>] extends [Available] ? ValidOrder<Tail, Available | Provided<Head>> : false
    : true

type DeclaredError<D> = D extends Middleware<any, any, any, any, infer E> ? E : never
export interface Application<D extends AnyMiddleware, Infrastructure, Error> {
  readonly declaration: D
  readonly effect: Effect.Effect<Service<D["provides"]>, Error, Required<D> | Infrastructure>
  readonly _infrastructure: Infrastructure
}

/** Bind pure middleware metadata to request processing. Infrastructure stays in the resulting program environment. */
export const implement = <D extends AnyMiddleware, E extends DeclaredError<D>, R>(
  declaration: D,
  effect: Effect.Effect<Service<D["provides"]>, E, R>
): Application<D, Exclude<R, Required<D>>, E> => ({
  declaration,
  effect: effect as Effect.Effect<Service<D["provides"]>, E, Required<D> | Exclude<R, Required<D>>>,
  _infrastructure: undefined as Exclude<R, Required<D>>
})

type AnyApplication = Application<AnyMiddleware, any, any>
type AppRequired<A> = A extends Application<infer D, any, any> ? Required<D> : never
type AppProvided<A> = A extends Application<infer D, any, any> ? Provided<D> : never
type AppInfrastructure<A> = A extends Application<any, infer R, any> ? R : never
type AppError<A> = A extends Application<any, any, infer E> ? E : never

const scopeRank: Record<Scope, number> = { global: 0, group: 1, command: 2, conversation: 2, handler: 3 }

export interface Pipeline<Available, Infrastructure, Error> {
  readonly _available: Available
  readonly _infrastructure: Infrastructure
  readonly _error: Error
  readonly applications: ReadonlyArray<AnyApplication>
  use<A extends AnyApplication>(
    application: A & ([AppRequired<A>] extends [Available] ? unknown : never)
  ): Pipeline<Available | AppProvided<A>, Infrastructure | AppInfrastructure<A>, Error | AppError<A>>
  run<A, E, R>(effect: Effect.Effect<A, E, R | Available>): Effect.Effect<A, E | Error, Exclude<R, Available> | Infrastructure>
}

const build = <Available, Infrastructure, Error>(applications: ReadonlyArray<AnyApplication>): Pipeline<Available, Infrastructure, Error> => ({
  _available: undefined as Available,
  _infrastructure: undefined as Infrastructure,
  _error: undefined as Error,
  applications,
  use(application) {
    const previous = applications.at(-1)
    if (previous !== undefined && scopeRank[application.declaration.scope] < scopeRank[previous.declaration.scope]) {
      throw new Error(`Middleware '${application.declaration.id}' (${application.declaration.scope}) cannot follow '${previous.declaration.id}' (${previous.declaration.scope})`)
    }
    return build([...applications, application])
  },
  run(effect) {
    const execute = (index: number): Effect.Effect<any, any, any> => {
      if (index === applications.length) return effect
      const application = applications[index]!
      return Effect.flatMap(application.effect, (service) =>
        Effect.provideService(execute(index + 1), application.declaration.provides, service))
    }
    return execute(0)
  }
})

/** Empty immutable request pipeline. Applications execute in declaration order. */
export const empty: Pipeline<never, never, never> = build([])

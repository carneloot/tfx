import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export const TypeId: unique symbol = Symbol.for("tfx/CommandInput")

type Kind = "None" | "Argument" | "Rest" | "Optional" | "Repeated" | "Sequence" | "Map"

export interface CommandInput<out A, out R = never, out Names extends string = never, out Optional extends boolean = false, out Rest extends boolean = false> {
  readonly [TypeId]: {
    readonly decoded: A
    readonly requirements: R
    readonly names: Names
    readonly optional: Optional
    readonly rest: Rest
  }
  readonly _tag: Kind
}

export type Decoded<T> = T extends CommandInput<infer A, any, any, any, any> ? A : never
export type Requirements<T> = T extends CommandInput<any, infer R, any, any, any> ? R : never
export type Names<T> = T extends CommandInput<any, any, infer N, any, any> ? N : never

type AnyInput = CommandInput<any, any, any, any, any>
type Simplify<T> = { readonly [K in keyof T]: T[K] }
type MergeDecoded<T extends readonly AnyInput[], A = {}> = T extends readonly [infer H extends AnyInput, ...infer Tail extends readonly AnyInput[]]
  ? MergeDecoded<Tail, A & Decoded<H>> : Simplify<A>
type AllRequirements<T extends readonly AnyInput[]> = Requirements<T[number]>
type AllNames<T extends readonly AnyInput[]> = Names<T[number]>
type IsOptional<T> = T extends CommandInput<any, any, any, infer O, any> ? O : false
type HasRest<T> = T extends CommandInput<any, any, any, any, infer R> ? R : false

type ValidSequence<T extends readonly AnyInput[], Seen extends string = never, OptionalSeen extends boolean = false, RestSeen extends boolean = false> =
  T extends readonly [infer H extends AnyInput, ...infer Tail extends readonly AnyInput[]]
    ? Names<H> & Seen extends never
      ? RestSeen extends true ? false
        : OptionalSeen extends true
          ? IsOptional<H> extends true ? ValidSequence<Tail, Seen | Names<H>, true, HasRest<H>> : false
          : ValidSequence<Tail, Seen | Names<H>, IsOptional<H>, HasRest<H>>
      : false
    : true

type Node<A, R, N extends string, O extends boolean, RestFlag extends boolean> = CommandInput<A, R, N, O, RestFlag> & Readonly<Record<string, unknown>>
const freeze = <A extends object>(value: A): A => Object.freeze(value)

export const none: CommandInput<{}, never, never, false, false> = freeze({
  [TypeId]: undefined as never,
  _tag: "None"
})

type StringSchema = Schema.ConstraintCodec<any, string, any, any>

export const argument = <const Name extends string, S extends StringSchema>(name: Name, schema: S): Node<
  { readonly [K in Name]: S["Type"] }, S["DecodingServices"], Name, false, false
> => freeze({ [TypeId]: undefined as never, _tag: "Argument", name, schema }) as never

export const rest = <const Name extends string, S extends StringSchema>(name: Name, schema: S): Node<
  { readonly [K in Name]: S["Type"] }, S["DecodingServices"], Name, false, true
> => freeze({ [TypeId]: undefined as never, _tag: "Rest", name, schema }) as never

export const optional = <I extends AnyInput>(input: I): Node<
  { readonly [K in keyof Decoded<I>]?: Decoded<I>[K] }, Requirements<I>, Names<I>, true, HasRest<I>
> => freeze({ [TypeId]: undefined as never, _tag: "Optional", input }) as never

export const repeated = <const Name extends string, S extends StringSchema>(name: Name, schema: S): Node<
  { readonly [K in Name]: ReadonlyArray<S["Type"]> }, S["DecodingServices"], Name, false, true
> => freeze({ [TypeId]: undefined as never, _tag: "Repeated", name, schema }) as never

export const sequence = <const Inputs extends readonly AnyInput[]>(...inputs: Inputs & (ValidSequence<Inputs> extends true ? unknown : ["Invalid CommandInput sequence"])): CommandInput<
  MergeDecoded<Inputs>, AllRequirements<Inputs>, AllNames<Inputs>, false, HasRest<Inputs[number]>
> => freeze({ [TypeId]: undefined as never, _tag: "Sequence", inputs: freeze([...inputs]) }) as never

export const map = <I extends AnyInput, B>(input: I, f: (value: Decoded<I>) => B): CommandInput<B, Requirements<I>, Names<I>, IsOptional<I>, HasRest<I>> =>
  freeze({ [TypeId]: undefined as never, _tag: "Map", input, map: f }) as never

/** @internal */
export type RuntimeInput = AnyInput & {
  readonly name?: string
  readonly schema?: Schema.Constraint
  readonly input?: RuntimeInput
  readonly inputs?: ReadonlyArray<RuntimeInput>
  readonly map?: (value: any) => any
}

/** @internal */
export const decode = (schema: Schema.Constraint, value: string): Effect.Effect<unknown, Schema.SchemaError, unknown> =>
  Schema.decodeEffect(schema)(value)

const TypeId: unique symbol = Symbol.for("tfx/CommandInput")

/** Immutable description of command input. Parsing combinators are added in a later slice. */
export interface CommandInput<out A, out R = never> {
  readonly [TypeId]: {
    readonly decoded: A
    readonly requirements: R
  }
  readonly _tag: "None"
}

export type Decoded<T> = T extends CommandInput<infer A, any> ? A : never
export type Requirements<T> = T extends CommandInput<any, infer R> ? R : never

export const none: CommandInput<{}, never> = Object.freeze({
  [TypeId]: undefined as never,
  _tag: "None"
})

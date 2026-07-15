import type * as CommandInput from "./CommandInput.js"
import { none } from "./CommandInput.js"
import type * as Middleware from "./Middleware.js"
import { MessageContext } from "./MessageContext.js"
import { UpdateContext } from "./UpdateContext.js"

export type UpdateKind = "message" | "callback_query" | "inline_query"
type BuiltIn = UpdateContext | MessageContext

export interface Command<Id extends string, Input extends CommandInput.CommandInput<any, any>, Error, Middlewares extends ReadonlyArray<Middleware.AnyMiddleware> = readonly []> {
  readonly _tag: "Command"
  readonly id: Id
  readonly name: string
  readonly input: Input
  readonly error: Error | undefined
  readonly description: string | undefined
  readonly language: string | undefined
  readonly updateKinds: ReadonlyArray<UpdateKind>
  /** Ordered request middleware metadata. Implementations live in a separate Pipeline/Layer. */
  readonly middleware: Middlewares
}

export interface Options<Input extends CommandInput.CommandInput<any, any>, Error, Middlewares extends ReadonlyArray<Middleware.AnyMiddleware>> {
  readonly name: string
  readonly input?: Input
  readonly error?: Error
  readonly description?: string
  readonly language?: string
  readonly updateKinds?: ReadonlyArray<UpdateKind>
  readonly middleware?: Middlewares
}

const scopeRank: Record<Middleware.Scope, number> = { global: 0, group: 1, command: 2, conversation: 2, handler: 3 }
export const make = <
  const Id extends string,
  Input extends CommandInput.CommandInput<any, any> = typeof none,
  Error = never,
  const Middlewares extends ReadonlyArray<Middleware.AnyMiddleware> = readonly []
>(id: Id, options: Options<Input, Error, Middlewares> & (Middleware.ValidOrder<Middlewares, BuiltIn> extends true ? unknown : { readonly middleware: never })): Command<Id, Input, Error, Middlewares> => {
  const middleware = [...(options.middleware ?? [])] as Middlewares[number][]
  const available = new Set<unknown>([UpdateContext, MessageContext])
  let rank = -1
  for (const item of middleware) {
    if (scopeRank[item.scope] < rank) throw new Error(`Middleware '${item.id}' is out of scope order`)
    for (const required of item.requires) if (!available.has(required)) throw new Error(`Middleware '${item.id}' requires an unavailable request service`)
    rank = scopeRank[item.scope]; available.add(item.provides)
  }
  return Object.freeze({
    _tag: "Command" as const, id, name: options.name, input: options.input ?? none as unknown as Input,
    error: options.error, description: options.description, language: options.language,
    updateKinds: Object.freeze([...(options.updateKinds ?? ["message"])]), middleware: Object.freeze(middleware) as unknown as Middlewares
  })
}

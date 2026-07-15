import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Bot from "./Bot.js"
import type * as BotGroup from "./BotGroup.js"
import type * as Command from "./Command.js"
import type * as CommandInput from "./CommandInput.js"
import { HandlerRegistry, type HandlerEntry } from "./internal/bot/HandlerRegistry.js"

type GroupsOf<B> = B extends Bot.Bot<any, infer Groups> ? Groups : never
type GroupAt<B, Id extends keyof GroupsOf<B>> = GroupsOf<B>[Id] extends BotGroup.BotGroup<any, any> ? GroupsOf<B>[Id] : never
type CommandsOf<G> = G extends BotGroup.BotGroup<any, infer Commands> ? Commands : never
type CommandAt<G, Id extends keyof CommandsOf<G>> = CommandsOf<G>[Id] extends Command.Command<any, any, any>
  ? CommandsOf<G>[Id]
  : never
type Decoded<C> = C extends Command.Command<any, infer Input, any> ? CommandInput.Decoded<Input> : never
type InputRequirements<C> = C extends Command.Command<any, infer Input, any> ? CommandInput.Requirements<Input> : never
type DeclaredError<C> = C extends Command.Command<any, any, infer Error> ? Error : never

export interface Handlers<G extends BotGroup.BotGroup<any, any>, Remaining extends keyof CommandsOf<G>, Requirements> {
  /** Phantom state tracks implementations still required. */
  readonly _remaining: Remaining
  readonly _requirements: Requirements
  /** @internal */
  readonly _entries: ReadonlyArray<HandlerEntry>
  handle<const Id extends Remaining, A, E extends DeclaredError<CommandAt<G, Id>>, R>(
    id: Id,
    handler: (input: Decoded<CommandAt<G, Id>>) => Effect.Effect<A, E, R>
  ): Handlers<G, Exclude<Remaining, Id>, Requirements | R | InputRequirements<CommandAt<G, Id>>>
}

const handlers = <G extends BotGroup.BotGroup<any, any>, Remaining extends keyof CommandsOf<G>, R>(
  groupId: string,
  entries: ReadonlyArray<HandlerEntry>
): Handlers<G, Remaining, R> => ({
  _remaining: undefined as never,
  _requirements: undefined as never,
  _entries: entries,
  handle(id, handler) {
    if (entries.some((entry) => entry.commandId === id)) throw new Error(`Duplicate implementation '${String(id)}' in group '${groupId}'`)
    return handlers(groupId, [...entries, { groupId, commandId: String(id), handler }])
  }
})

export const group = <
  B extends Bot.Bot<any, any>,
  Id extends keyof GroupsOf<B> & string,
  R
>(
  bot: B,
  id: Id,
  implement: (
    handlers: Handlers<GroupAt<B, Id>, keyof CommandsOf<GroupAt<B, Id>>, never>
  ) => Handlers<GroupAt<B, Id>, never, R>
): Layer.Layer<HandlerRegistry, never, R> => {
  const declaration = bot.groups[id] as GroupAt<B, Id>
  const completed = implement(handlers(String(declaration.id), []))
  return Layer.succeed(HandlerRegistry, Object.freeze([...completed._entries])) as Layer.Layer<HandlerRegistry, never, R>
}

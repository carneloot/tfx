import type * as Command from "./Command.js"

export interface BotGroup<Id extends string, Commands extends Readonly<Record<string, Command.Command<any, any, any>>>> {
  readonly _tag: "BotGroup"
  readonly id: Id
  readonly commands: Commands
  add<C extends Command.Command<any, any, any>>(
    command: C & (C["id"] extends keyof Commands ? never : unknown)
  ): BotGroup<Id, Commands & { readonly [K in C["id"]]: C }>
}

const build = <Id extends string, Commands extends Readonly<Record<string, Command.Command<any, any, any>>>>(
  id: Id,
  commands: Commands
): BotGroup<Id, Commands> => Object.freeze({
  _tag: "BotGroup" as const,
  id,
  commands: Object.freeze(commands),
  add<C extends Command.Command<any, any, any>>(command: C) {
    if (Object.hasOwn(commands, command.id)) throw new Error(`Duplicate command id '${command.id}' in group '${id}'`)
    return build(id, { ...commands, [command.id]: command } as Commands & { readonly [K in C["id"]]: C })
  }
})

export const make = <const Id extends string>(id: Id): BotGroup<Id, {}> => build(id, {})

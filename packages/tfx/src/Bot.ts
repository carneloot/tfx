import type * as BotGroup from "./BotGroup.js"

export interface Bot<Name extends string, Groups extends Readonly<Record<string, BotGroup.BotGroup<any, any>>>> {
  readonly _tag: "Bot"
  readonly name: Name
  readonly groups: Groups
  add<G extends BotGroup.BotGroup<any, any>>(
    group: G & (G["id"] extends keyof Groups ? never : unknown)
  ): Bot<Name, Groups & { readonly [K in G["id"]]: G }>
}

const commandNamePattern = /^[a-z0-9_]{1,32}$/

const build = <Name extends string, Groups extends Readonly<Record<string, BotGroup.BotGroup<any, any>>>>(
  name: Name,
  groups: Groups
): Bot<Name, Groups> => Object.freeze({
  _tag: "Bot" as const,
  name,
  groups: Object.freeze(groups),
  add<G extends BotGroup.BotGroup<any, any>>(group: G) {
    if (Object.hasOwn(groups, group.id)) throw new Error(`Duplicate group id '${group.id}' while adding fragment '${group.id}' to bot '${name}'`)
    const names = new Map<string, string>()
    for (const current of [...Object.values(groups), group] as ReadonlyArray<BotGroup.BotGroup<string, any>>) {
      for (const command of Object.values(current.commands) as ReadonlyArray<import("./Command.js").Command<string, any, any>>) {
        if (!commandNamePattern.test(command.name)) {
          throw new Error(`Invalid Telegram command name '${command.name}' in fragment '${current.id}' (command '${command.id}')`)
        }
        const previous = names.get(command.name)
        if (previous !== undefined) {
          throw new Error(`Duplicate Telegram command name '${command.name}' in fragments '${previous}' and '${current.id}'`)
        }
        names.set(command.name, current.id)
      }
    }
    return build(name, { ...groups, [group.id]: group } as Groups & { readonly [K in G["id"]]: G })
  }
})

export const make = <const Name extends string>(name: Name): Bot<Name, {}> => build(name, {})

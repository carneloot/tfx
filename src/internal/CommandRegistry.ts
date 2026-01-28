import { Context, Effect, Layer, Ref } from "effect"
import type { CommandDefinition } from "../Command.js"

/**
 * Registry service that tracks command handlers
 * This is populated by command layers during composition
 */
export class CommandRegistry extends Context.Tag("tfx/CommandRegistry")<
  CommandRegistry,
  {
    readonly registerCommand: (definition: CommandDefinition) => Effect.Effect<void>
    readonly getCommand: (keyword: string) => Effect.Effect<CommandDefinition | undefined>
    readonly getAllCommands: () => Effect.Effect<Map<string, CommandDefinition>>
  }
>() {
  /**
   * Create an empty registry layer
   */
  static live(): Layer.Layer<CommandRegistry> {
    return Layer.effect(
      CommandRegistry,
      Effect.gen(function*() {
        const commandsRef = yield* Ref.make(new Map<string, CommandDefinition>())

        return {
          registerCommand: (definition) =>
            Effect.gen(function*() {
              yield* Ref.update(commandsRef, (map) => {
                const newMap = new Map(map)
                for (const keyword of definition.keywords) {
                  newMap.set(keyword, definition)
                }
                return newMap
              })
            }),

          getCommand: (keyword) => Ref.get(commandsRef).pipe(Effect.map((map) => map.get(keyword))),

          getAllCommands: () => Ref.get(commandsRef)
        }
      })
    )
  }
}

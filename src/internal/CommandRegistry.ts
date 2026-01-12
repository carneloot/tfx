import { Context, Effect, Layer, Ref } from "effect"
import type { CommandConfig, CommandHandler } from "../Command.js"

/**
 * Registry service that tracks command handlers
 * This is populated by command layers during composition
 */
export class CommandRegistry extends Context.Tag("tfx/CommandRegistry")<
  CommandRegistry,
  {
    readonly registerCommand: (
      config: CommandConfig,
      handler: CommandHandler
    ) => Effect.Effect<void>
    readonly getHandler: (name: string) => Effect.Effect<CommandHandler | undefined>
    readonly getAllHandlers: () => Effect.Effect<Map<string, CommandHandler>>
  }
>() {
  /**
   * Create an empty registry layer
   */
  static live(): Layer.Layer<CommandRegistry> {
    return Layer.effect(
      CommandRegistry,
      Effect.gen(function*() {
        const handlersRef = yield* Ref.make(new Map<string, CommandHandler>())
        const configsRef = yield* Ref.make(new Map<string, CommandConfig>())

        return {
          registerCommand: (config, handler) =>
            Effect.gen(function*() {
              yield* Ref.update(handlersRef, (map) => {
                const newMap = new Map(map)
                newMap.set(config.name, handler)
                return newMap
              })
              yield* Ref.update(configsRef, (map) => {
                const newMap = new Map(map)
                newMap.set(config.name, config)
                return newMap
              })
            }),

          getHandler: (name) => Ref.get(handlersRef).pipe(Effect.map((map) => map.get(name))),

          getAllHandlers: () => Ref.get(handlersRef)
        }
      })
    )
  }
}

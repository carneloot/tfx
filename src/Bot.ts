import type { Update } from "@effect-ak/tg-bot-api"
import type { Config } from "effect"
import { Context, Effect, Layer } from "effect"
import type { CommandBuilder } from "./Command.js"
import type { CommandRegistry } from "./internal/CommandRegistry.js"
import type { TgBotClient } from "./internal/TgClient.js"

/**
 * Configuration for the bot
 */
export interface BotDefinitionConfig {
  /**
   * Bot name (used for identification)
   */
  name: string
  /**
   * Commands registered with this bot
   */
  commands: ReadonlyArray<CommandBuilder>
  /**
   * Handler for defects (unexpected errors at runtime)
   * Note: Command handler errors should be handled in the commands themselves
   */
  onDefect?: (
    defect: unknown,
    context: { command?: string; update: Update }
  ) => Effect.Effect<void>
}

/**
 * Polling configuration
 */
export interface PollingOptions {
  timeout?: number
  limit?: number
  allowed_updates?: Array<string>
  on_error?: "stop" | "continue"
  log_level?: "debug" | "info"
}

/**
 * Configuration for creating a polling bot
 */
export interface PollingBotConfig {
  token: Config.Config<string>
  polling?: PollingOptions
}

/**
 * The Bot service tag - provides bot token and polling configuration
 */
export class Bot extends Context.Tag("tfx/Bot")<
  Bot,
  {
    readonly token: string
    readonly polling: PollingOptions
  }
>() {
  /**
   * Create a bot definition with a name
   */
  static make(name: string): BotBuilder {
    return new BotBuilder({
      name,
      commands: []
    })
  }

  /**
   * Create a polling bot layer that provides the Bot service and TgBotClient
   */
  static makePolling(config: PollingBotConfig): Layer.Layer<Bot | TgBotClient> {
    return Layer.unwrapEffect(
      Effect.gen(function*() {
        // Get the bot token from the Config
        const tokenString = yield* config.token

        // Create the Bot service layer
        const botLayer = Layer.succeed(Bot, {
          token: tokenString,
          polling: config.polling ?? {}
        })

        // Import TgBotClient to create the client layer
        const { TgBotClient } = yield* Effect.promise(() => import("./internal/TgClient.js"))

        // Merge Bot layer with TgBotClient layer
        return Layer.merge(botLayer, TgBotClient.fromToken(tokenString))
      }).pipe(Effect.orDie)
    )
  }
}

/**
 * Builder for creating bot definitions
 */
export class BotBuilder {
  constructor(readonly config: BotDefinitionConfig) {}

  /**
   * Add a command to the bot
   */
  add(command: CommandBuilder): BotBuilder {
    return new BotBuilder({
      ...this.config,
      commands: [...this.config.commands, command]
    })
  }

  /**
   * Get the configuration
   */
  getConfig(): BotDefinitionConfig {
    return this.config
  }

  /**
   * Create a layer that launches the bot with all its commands
   * This should be provided with command implementation layers and CommandRegistry
   */
  static launch(
    bot: BotBuilder
  ): Layer.Layer<never, never, Bot | TgBotClient | CommandRegistry> {
    // This will be implemented to wire polling + routing + handlers
    return Layer.effectDiscard(
      Effect.gen(function*() {
        // Import internal modules to avoid circular dependencies
        const { longPollingLoop } = yield* Effect.promise(() => import("./internal/Polling.js"))
        const { matchCommand } = yield* Effect.promise(() => import("./internal/Routing.js"))
        const { executeHandler } = yield* Effect.promise(() => import("./internal/Handler.js"))
        const { CommandRegistry } = yield* Effect.promise(() => import("./internal/CommandRegistry.js"))

        const botService = yield* Bot
        const registry = yield* CommandRegistry

        // Build command map from bot definition
        const commandMap = new Map<string, Array<any>>()
        for (const cmd of bot.config.commands) {
          const config = cmd.getConfig()
          const existing = commandMap.get(config.name) ?? []
          commandMap.set(config.name, [...existing, config])
        }

        // Start polling loop - this runs forever
        return yield* longPollingLoop(
          (update: Update) =>
            Effect.gen(function*() {
              const matched = matchCommand(update, commandMap)
              if (!matched) return

              const handler = yield* registry.getHandler(matched.config.name)
              if (!handler) {
                yield* Effect.logWarning(
                  `No handler found for command: ${matched.config.name}`
                )
                return
              }

              yield* executeHandler(handler, update)
            }),
          botService.polling.timeout ?? 30,
          botService.polling.limit ?? 100
        )
      })
    )
  }
}

/**
 * Bot definition holds global configuration
 */
export class BotDefinition {
  constructor(readonly config: BotDefinitionConfig) {}
}

/**
 * Live implementation builder for Bot
 */
export const BotLive = {
  /**
   * Create a polling bot layer with full configuration
   */
  makePolling: (config: PollingBotConfig): Layer.Layer<Bot> => Bot.makePolling(config)
}

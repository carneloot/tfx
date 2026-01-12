import type { Update } from "@effect-ak/tg-bot-api"
import { Context, Effect, Layer } from "effect"
import type { BotContext } from "./BotContext.js"
import type { CommandRegistry } from "./internal/CommandRegistry.js"

/**
 * Represents a command trigger (e.g., /echo)
 */
export interface CommandConfig {
  readonly name: string
  readonly description: string
  readonly aliases: ReadonlyArray<string>
}

/**
 * A Command represents a Telegram bot command handler
 */
export class Command extends Context.Tag("tfx/Command")<
  Command,
  CommandConfig
>() {
  /**
   * Create a new command
   * @param name The command name (without /)
   * @param description Description of what the command does
   */
  static make(name: string, description: string): CommandBuilder {
    return new CommandBuilder({
      name,
      description,
      aliases: []
    })
  }

  /**
   * Create a layer that provides this command
   */
  static makeLayer(
    command: CommandBuilder
  ): CommandLayerBuilder {
    return new CommandLayerBuilder(command.config)
  }
}

/**
 * Builder for creating commands with fluent API
 */
export class CommandBuilder {
  constructor(readonly config: CommandConfig) {}

  /**
   * Add an alias for this command
   * @param alias Alternative trigger for this command
   */
  withAlias(alias: string): CommandBuilder {
    return new CommandBuilder({
      ...this.config,
      aliases: [...this.config.aliases, alias]
    })
  }

  /**
   * Get the configuration
   */
  getConfig(): CommandConfig {
    return this.config
  }
}

/**
 * Handler function signature for commands
 */
export type CommandHandler = (input: {
  ctx: BotContext
  update: Update
}) => Effect.Effect<void, never, any>

/**
 * Builder for creating command layers
 */
export class CommandLayerBuilder {
  private _handler?: CommandHandler

  constructor(readonly config: CommandConfig) {}

  /**
   * Set the handler for this command
   * Returns a layer that registers the command when provided with CommandRegistry
   */
  handler(fn: CommandHandler): Layer.Layer<never, never, CommandRegistry> {
    this._handler = fn
    return this.buildLayer()
  }

  /**
   * Build the layer (internal use)
   */
  private buildLayer(): Layer.Layer<never, never, CommandRegistry> {
    if (!this._handler) {
      throw new Error(`No handler set for command: ${this.config.name}`)
    }

    const config = this.config
    const handler = this._handler

    // Import CommandRegistry dynamically to avoid circular dependency
    return Layer.effectDiscard(
      Effect.gen(function*() {
        const { CommandRegistry } = yield* Effect.promise(() => import("./internal/CommandRegistry.js"))
        const registry = yield* CommandRegistry
        yield* registry.registerCommand(config, handler)
      })
    ) as Layer.Layer<never, never, CommandRegistry>
  }
}

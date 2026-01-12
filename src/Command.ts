import { Context, Effect, Layer } from "effect"
import type { Update } from "@effect-ak/tg-bot-api"
import type { BotContext } from "./BotContext"

/**
 * Represents a command trigger (e.g., /echo)
 */
export interface CommandConfig {
  readonly name: string
  readonly description: string
  readonly aliases: readonly string[]
}

/**
 * A Command represents a Telegram bot command handler
 */
export class Command extends Context.Tag<Command>()(
  "Command",
  {
    name: "",
    description: "",
    aliases: [],
  }
) {
  /**
   * Create a new command
   * @param name The command name (without /)
   * @param description Description of what the command does
   */
  static make(name: string, description: string): CommandBuilder {
    return new CommandBuilder({
      name,
      description,
      aliases: [],
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
      aliases: [...this.config.aliases, alias],
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
   */
  handler(fn: CommandHandler): this {
    this._handler = fn
    return this
  }

  /**
   * Create the layer
   */
  pipe<R, E, A>(
    fn: (layer: Layer.Layer<any>) => Effect.Effect<A, E, R> | Layer.Layer<A>
  ): any {
    const layer = this.buildLayer()
    return fn(layer)
  }

  /**
   * Build the layer (internal use)
   */
  buildLayer(): Layer.Layer<any> {
    // This will be properly implemented when we have context tags
    return Layer.succeed({} as any, {} as any)
  }
}

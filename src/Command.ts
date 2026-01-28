import type { Update } from "@effect-ak/tg-bot-api"
import { Context, Layer } from "effect"
import type { Effect } from "effect"
import type { BotContext } from "./BotContext.js"
import type { Middleware } from "./Middleware.js"

/**
 * Defines the handler signature for a command.
 */
export type CommandHandler = (input: {
  ctx: BotContext
  update: Update
}) => Effect.Effect<void, never, any>

/**
 * Non-empty list of keywords used for command matching.
 */
export type CommandKeywords = readonly [string, ...Array<string>]

/**
 * Full command definition with a handler.
 */
export interface CommandDefinition {
  readonly keywords: CommandKeywords
  readonly description?: string
  readonly handler: CommandHandler
  readonly middlewares?: ReadonlyArray<Middleware<any, any>>
}

/**
 * Command definition without a handler (used by builders).
 */
export interface CommandDefinitionBase {
  readonly keywords: CommandKeywords
  readonly description?: string
  readonly middlewares?: ReadonlyArray<Middleware<any, any>>
}

/**
 * A Command represents a Telegram bot command handler
 */
export class Command extends Context.Tag("tfx/Command")<
  Command,
  CommandDefinition
>() {
  /**
   * Create a builder for a command definition.
   * @param keywords One or more keywords used to match this command
   */
  static make(...keywords: CommandKeywords): CommandBuilder {
    return new CommandBuilder({
      keywords,
      middlewares: []
    })
  }

  /**
   * Create a command definition with a handler.
   * @param definition Command definition (must include a handler)
   */
  static define(definition: CommandDefinition): CommandDefinition {
    return definition
  }
}

/**
 * Create a command definition with a handler.
 * @param definition Command definition (must include a handler)
 */
export const defineCommand = (definition: CommandDefinition): CommandDefinition => definition

/**
 * Builder for creating commands with fluent API
 */
export class CommandBuilder {
  constructor(readonly config: CommandDefinitionBase) {}

  /**
   * Add a description for this command.
   * @param description Short description shown in help output
   */
  withDescription(description: string): CommandBuilder {
    return new CommandBuilder({
      ...this.config,
      description
    })
  }

  /**
   * Add an additional keyword for this command.
   * @param keyword Additional keyword used for matching
   */
  withKeyword(keyword: string): CommandBuilder {
    return new CommandBuilder({
      ...this.config,
      keywords: [...this.config.keywords, keyword] as CommandKeywords
    })
  }

  /**
   * Add middleware to this command (not executed in v1).
   * @param middlewares Middleware list
   */
  withMiddlewares(
    middlewares: ReadonlyArray<Middleware<any, any>>
  ): CommandBuilder {
    return new CommandBuilder({
      ...this.config,
      middlewares: [...(this.config.middlewares ?? []), ...middlewares]
    })
  }

  /**
   * Set the handler for this command and finalize the definition.
   */
  handler(handler: CommandHandler): CommandDefinition {
    return {
      ...this.config,
      handler
    }
  }

  /**
   * Get the configuration without a handler.
   */
  getConfig(): CommandDefinitionBase {
    return this.config
  }
}

/**
 * Build a command definition with a fluent API or define it directly.
 * @param definition Full command definition (including handler)
 * @param keywords One or more keywords used to match this command
 */
export function command(definition: CommandDefinition): CommandDefinition
export function command(...keywords: CommandKeywords): CommandBuilder
export function command(
  ...args: [CommandDefinition] | CommandKeywords
): CommandDefinition | CommandBuilder {
  const [first] = args
  return typeof first === "string"
    ? Command.make(...(args as CommandKeywords))
    : Command.define(first)
}

/**
 * Create a layer that provides a command definition.
 * @param definition Full command definition (including handler)
 */
export const makeCommandLayer = (definition: CommandDefinition): Layer.Layer<never, never, Command> =>
  Layer.succeed(Command, definition)

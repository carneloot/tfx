import { Context, Effect, Layer } from "effect"
import type { Update } from "@effect-ak/tg-bot-api"
import type { BotContext } from "./BotContext"

/**
 * Configuration for the bot
 */
export interface BotDefinitionConfig {
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
  allowed_updates?: string[]
  on_error?: "stop" | "continue"
  log_level?: "debug" | "info"
}

/**
 * Configuration for creating a polling bot
 */
export interface PollingBotConfig {
  token: string
  polling?: PollingOptions
}

/**
 * The Bot service tag
 */
export class Bot extends Context.Tag<Bot>()(
  "Bot",
  {
    token: "",
    polling: {} as PollingOptions,
  }
) {
  /**
   * Define a bot with global configuration
   */
  static define(config: BotDefinitionConfig): BotDefinition {
    return new BotDefinition(config)
  }

  /**
   * Create a polling bot layer
   */
  static makePolling(config: PollingBotConfig): Layer.Layer<Bot> {
    return Layer.succeed(Bot, {
      token: config.token,
      polling: config.polling ?? {},
    })
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
  makePolling: (config: PollingBotConfig): Layer.Layer<Bot> =>
    Bot.makePolling(config),
}

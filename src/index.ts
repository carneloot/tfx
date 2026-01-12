// Core exports
export { Bot, BotLive, BotDefinition } from "./Bot"
export type { BotDefinitionConfig, PollingOptions, PollingBotConfig } from "./Bot"

export { Command } from "./Command"
export type { CommandConfig, CommandHandler } from "./Command"
export { CommandBuilder, CommandLayerBuilder } from "./Command"

export { CommandGroup } from "./CommandGroup"
export type { CommandGroupConfig } from "./CommandGroup"
export { CommandGroupBuilder, CommandGroupLayerBuilder } from "./CommandGroup"

export { Middleware, makeMiddlewareLayer } from "./Middleware"
export type { MiddlewareResult } from "./Middleware"

export { makeBotContext } from "./BotContext"
export type { BotContext, ReplyOptions } from "./BotContext"

// Error exports
export {
  BotError,
  CommandConflictError,
  MissingMiddlewareError,
  MissingCommandError,
} from "./errors/BotError"

// Internal exports for advanced usage
export { TgBotClient, makeTgBotClientLayer } from "./internal/TgClient"
export { extractCommand, matchCommand } from "./internal/Routing"
export type { MatchedCommand } from "./internal/Routing"
export { pollUpdates, longPollingLoop } from "./internal/Polling"
export { executeHandler } from "./internal/Handler"

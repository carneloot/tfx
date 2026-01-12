// Core exports
export { Bot, BotDefinition, BotLive } from "./Bot"
export type { BotDefinitionConfig, PollingBotConfig, PollingOptions } from "./Bot"

export { Command } from "./Command"
export type { CommandConfig, CommandHandler } from "./Command"
export { CommandBuilder, CommandLayerBuilder } from "./Command"

export { CommandGroup } from "./CommandGroup"
export type { CommandGroupConfig } from "./CommandGroup"
export { CommandGroupBuilder, CommandGroupLayerBuilder } from "./CommandGroup"

export { makeMiddlewareLayer, Middleware } from "./Middleware"
export type { MiddlewareResult } from "./Middleware"

export { makeBotContext } from "./BotContext"
export type { BotContext, ReplyOptions } from "./BotContext"

// Error exports
export { BotError, CommandConflictError, MissingCommandError, MissingMiddlewareError } from "./errors/BotError"

// Internal exports for advanced usage
export { executeHandler } from "./internal/Handler"
export { longPollingLoop, pollUpdates } from "./internal/Polling"
export { extractCommand, matchCommand } from "./internal/Routing"
export type { MatchedCommand } from "./internal/Routing"
export { makeTgBotClientLayer, TgBotClient } from "./internal/TgClient"

// Core exports
export { Bot, BotBuilder, BotDefinition, BotLive } from "./Bot.js"
export type { BotDefinitionConfig, PollingBotConfig, PollingOptions } from "./Bot.js"

export { Command, command, CommandBuilder, defineCommand, makeCommandLayer } from "./Command.js"
export type { CommandDefinition, CommandDefinitionBase, CommandHandler } from "./Command.js"

export { CommandGroup } from "./CommandGroup.js"
export type { CommandGroupConfig } from "./CommandGroup.js"
export { CommandGroupBuilder, CommandGroupLayerBuilder } from "./CommandGroup.js"

export { makeMiddlewareLayer } from "./Middleware.js"
export type { Middleware, MiddlewareResult } from "./Middleware.js"

export { makeBotContext } from "./BotContext.js"
export type { BotContext, ReplyOptions } from "./BotContext.js"

// Error exports
export { BotError, CommandConflictError, MissingCommandError, MissingMiddlewareError } from "./errors/BotError.js"

// Internal exports for advanced usage
export { CommandRegistry } from "./internal/CommandRegistry.js"
export { executeHandler } from "./internal/Handler.js"
export { longPollingLoop, pollUpdates } from "./internal/Polling.js"
export { extractCommand, matchCommand } from "./internal/Routing.js"
export type { MatchedCommand } from "./internal/Routing.js"
export { makeTgBotClientLayer, TgBotClient } from "./internal/TgClient.js"

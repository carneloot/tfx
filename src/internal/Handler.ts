import type { Update } from "@effect-ak/tg-bot-api"
import { Effect } from "effect"
import { makeBotContext } from "../BotContext.js"
import type { CommandHandler } from "../Command.js"
import type { TgBotClient } from "./TgClient.js"

/**
 * Execute a command handler
 * The handler receives a BotContext that can access TgBotClient from the Effect context
 */
export const executeHandler = (
  handler: CommandHandler,
  update: Update
): Effect.Effect<void, never, TgBotClient> => {
  return Effect.gen(function*() {
    const ctx = makeBotContext(update)
    yield* handler({ ctx, update })
  })
}

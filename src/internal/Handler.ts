import type { Update } from "@effect-ak/tg-bot-api"
import { Effect } from "effect"
import { makeBotContext } from "../BotContext"
import type { CommandHandler } from "../Command"
import type { TgBotClient } from "./TgClient"

/**
 * Execute a command handler
 */
export const executeHandler = (
  handler: CommandHandler,
  update: Update
): Effect.Effect<void, never, TgBotClient> => {
  return Effect.gen(function*() {
    const client = yield* TgBotClient
    const ctx = makeBotContext(update, client)
    yield* handler({ ctx, update })
  })
}

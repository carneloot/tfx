import type { Update } from "@effect-ak/tg-bot-api"
import { Effect } from "effect"
import type { TgBotClient } from "./TgClient"

/**
 * Poll for updates from Telegram using long polling
 */
export const pollUpdates = (
  offset: number,
  timeout: number,
  limit: number
): Effect.Effect<Update[], never, TgBotClient> => {
  return Effect.gen(function* () {
    const client = yield* TgBotClient
    const updates = yield* Effect.tryPromise({
      try: () =>
        (client.execute as any)("get_updates", {
          offset,
          timeout,
          limit,
        }),
      catch: () => new Error("Failed to poll updates"),
    })
    return (updates as any) || []
  })
}

/**
 * Long polling loop that continuously fetches updates
 */
export const longPollingLoop = (
  onUpdate: (update: Update) => Effect.Effect<void>,
  timeout: number = 30,
  limit: number = 100
): Effect.Effect<never> => {
  return Effect.gen(function* () {
    let offset = 0

    while (true) {
      const updates = yield* pollUpdates(offset, timeout, limit)

      for (const update of updates) {
        yield* onUpdate(update)
        offset = update.update_id + 1
      }
    }
  })
}

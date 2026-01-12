import type { Update } from "@effect-ak/tg-bot-api"
import { Effect } from "effect"
import { TgBotClient } from "./TgClient.js"

/**
 * Poll for updates from Telegram using long polling
 */
export const pollUpdates = (
  offset: number,
  timeout: number,
  limit: number
): Effect.Effect<Array<Update>, never, TgBotClient> => {
  return Effect.gen(function*() {
    const client = yield* TgBotClient
    const updates = yield* Effect.promise(() =>
      client.client.execute("get_updates", {
        offset,
        timeout,
        limit
      })
    ).pipe(
      Effect.catchAll((error: unknown) =>
        Effect.gen(function*() {
          yield* Effect.logError(
            `Failed to poll updates: ${error instanceof Error ? error.message : String(error)}`
          )
          return []
        })
      )
    )
    return updates ?? []
  })
}

/**
 * Long polling loop that continuously fetches updates
 */
export const longPollingLoop = <R>(
  onUpdate: (update: Update) => Effect.Effect<void, never, R>,
  timeout: number = 30,
  limit: number = 100
): Effect.Effect<never, never, TgBotClient | R> => {
  return Effect.gen(function*() {
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

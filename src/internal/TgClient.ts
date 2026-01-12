import type { Api } from "@effect-ak/tg-bot-api"
import { Context, Effect, Layer } from "effect"

/**
 * Wrapper around @effect-ak/tg-bot-client for use with Effect
 */
export class TgBotClient extends Context.Tag<TgBotClient>()(
  "TgBotClient",
  {
    execute: Effect.succeed(null) as any,
    sendMessage: Effect.succeed(null) as any,
  }
) {
  static readonly sendMessage = (
    params: Parameters<Api["send_message"]>[0]
  ): Effect.Effect<void, never, TgBotClient> =>
    Effect.gen(function* () {
      const client = yield* TgBotClient
      yield* Effect.tryPromise({
        try: () =>
          (client.execute as any)(
            "send_message" as const,
            params
          ),
        catch: () => new Error("Failed to send message"),
      })
    })
}

/**
 * Create a layer providing the TgBotClient
 */
export const makeTgBotClientLayer = (botToken: string): Layer.Layer<TgBotClient> => {
  return Layer.effect(
    TgBotClient,
    Effect.gen(function* () {
      // Import the tg-bot-client here to avoid top-level imports
      const { makeTgBotClient } = await import("@effect-ak/tg-bot-client")

      const client = makeTgBotClient({
        bot_token: botToken,
      })

      return {
        execute: client.execute,
        sendMessage: (params: Parameters<Api["send_message"]>[0]) =>
          Effect.tryPromise({
            try: () => client.execute("send_message", params),
            catch: () => new Error("Failed to send message"),
          }),
      }
    })
  )
}

import type { Api } from "@effect-ak/tg-bot-api"
import type { TgBotClient as RawTgBotClient } from "@effect-ak/tg-bot-client"
import { Context, Effect, Layer } from "effect"

/**
 * Wrapper around @effect-ak/tg-bot-client for use with Effect
 */
export class TgBotClient extends Context.Tag("tfx/TgBotClient")<
  TgBotClient,
  {
    readonly client: RawTgBotClient
    readonly sendMessage: (
      params: Parameters<Api["send_message"]>[0]
    ) => Effect.Effect<void, never>
  }
>() {
  /**
   * Create a layer providing the TgBotClient from a bot token
   */
  static fromToken(botToken: string): Layer.Layer<TgBotClient> {
    return Layer.effect(
      TgBotClient,
      Effect.gen(function*() {
        // Import the tg-bot-client
        const { makeTgBotClient } = yield* Effect.promise(() => import("@effect-ak/tg-bot-client"))

        const client = makeTgBotClient({
          bot_token: botToken
        })

        return {
          client,
          sendMessage: (params: Parameters<Api["send_message"]>[0]) =>
            Effect.promise(() => client.execute("send_message", params)).pipe(
              Effect.catchAll((error: unknown) =>
                Effect.logError(
                  `Failed to send message: ${error instanceof Error ? error.message : String(error)}`
                )
              ),
              Effect.asVoid
            )
        }
      })
    )
  }
}

/**
 * Create a layer providing the TgBotClient
 * @deprecated Use TgBotClient.fromToken instead
 */
export const makeTgBotClientLayer = (botToken: string): Layer.Layer<TgBotClient> => TgBotClient.fromToken(botToken)

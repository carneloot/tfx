import type { Update } from "@effect-ak/tg-bot-api"
import { Effect } from "effect"
import type { TgBotClient } from "./internal/TgClient"

/**
 * Options for replying to a message
 */
export interface ReplyOptions {
  parse_mode?: "HTML" | "Markdown" | "MarkdownV2"
  disable_web_page_preview?: boolean
  disable_notification?: boolean
  protect_content?: boolean
  reply_to_message_id?: number
}

/**
 * Context passed to command handlers
 * Provides convenient methods for responding to Telegram updates
 */
export interface BotContext {
  /**
   * Reply to the current update with a text message
   * @param text The message text to send
   * @param options Formatting and delivery options
   */
  readonly reply: (
    text: string,
    options?: ReplyOptions
  ) => Effect.Effect<void, never, TgBotClient>
}

/**
 * Create a BotContext for a given update and Telegram client
 */
export const makeBotContext = (
  update: Update,
  client: TgBotClient
): BotContext => {
  const chatId = update.message?.chat.id ?? update.callback_query?.from.id ?? 0

  return {
    reply: (text: string, options?: ReplyOptions) =>
      Effect.gen(function* () {
        yield* client.sendMessage({
          chat_id: chatId,
          text,
          parse_mode: options?.parse_mode,
          disable_web_page_preview: options?.disable_web_page_preview,
          disable_notification: options?.disable_notification,
          protect_content: options?.protect_content,
          reply_to_message_id: options?.reply_to_message_id,
        })
      }),
  }
}

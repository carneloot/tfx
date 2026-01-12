import type { Update } from "@effect-ak/tg-bot-api"
import { Effect } from "effect"
import { TgBotClient } from "./internal/TgClient.js"

/**
 * Options for replying to a message
 */
export interface ReplyOptions {
  parse_mode?: "HTML" | "MarkdownV2"
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
 * Create a BotContext for a given update
 * The TgBotClient will be accessed from the Effect context
 */
export const makeBotContext = (update: Update): BotContext => {
  const chatId = update.message?.chat.id ?? update.callback_query?.from.id ?? 0

  return {
    reply: (text: string, options?: ReplyOptions) =>
      Effect.gen(function*() {
        const client = yield* TgBotClient
        yield* client.sendMessage({
          chat_id: chatId,
          text,
          ...(options?.parse_mode && { parse_mode: options.parse_mode }),
          ...(options?.disable_web_page_preview !== undefined && {
            disable_web_page_preview: options.disable_web_page_preview
          }),
          ...(options?.disable_notification !== undefined && {
            disable_notification: options.disable_notification
          }),
          ...(options?.protect_content !== undefined && {
            protect_content: options.protect_content
          }),
          ...(options?.reply_to_message_id !== undefined && {
            reply_to_message_id: options.reply_to_message_id
          })
        })
      })
  }
}

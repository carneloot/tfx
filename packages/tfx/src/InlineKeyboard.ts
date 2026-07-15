import type { InlineKeyboardButton, InlineKeyboardMarkup } from "./internal/telegram/generated/TelegramApi.types.js"

export const callback = (text: string, callbackData: string): InlineKeyboardButton =>
  Object.freeze({ text, callback_data: callbackData })

export const url = (text: string, value: string): InlineKeyboardButton =>
  Object.freeze({ text, url: value })

export const webApp = (text: string, value: string): InlineKeyboardButton =>
  Object.freeze({ text, web_app: Object.freeze({ url: value }) })

export const rows = (value: ReadonlyArray<ReadonlyArray<InlineKeyboardButton>>): InlineKeyboardMarkup =>
  Object.freeze({
    inline_keyboard: Object.freeze(value.map((row) => Object.freeze(row.map((button) =>
      Object.freeze({ ...button })
    ))))
  })

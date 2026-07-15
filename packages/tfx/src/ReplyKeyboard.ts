import type { KeyboardButton, ReplyKeyboardMarkup } from "./internal/telegram/generated/TelegramApi.types.js"

export interface Options {
  readonly isPersistent?: boolean
  readonly resize?: boolean
  readonly oneTime?: boolean
  readonly placeholder?: string
  readonly selective?: boolean
}

export const text = (value: string): KeyboardButton => Object.freeze({ text: value })

export const webApp = (label: string, url: string): KeyboardButton =>
  Object.freeze({ text: label, web_app: Object.freeze({ url }) })

export const rows = (
  value: ReadonlyArray<ReadonlyArray<string | KeyboardButton>>,
  options: Options = {}
): ReplyKeyboardMarkup => Object.freeze({
  keyboard: Object.freeze(value.map((row) => Object.freeze(row.map((button) =>
    typeof button === "string" ? text(button) : Object.freeze({ ...button })
  )))),
  ...(options.isPersistent === undefined ? {} : { is_persistent: options.isPersistent }),
  ...(options.resize === undefined ? {} : { resize_keyboard: options.resize }),
  ...(options.oneTime === undefined ? {} : { one_time_keyboard: options.oneTime }),
  ...(options.placeholder === undefined ? {} : { input_field_placeholder: options.placeholder }),
  ...(options.selective === undefined ? {} : { selective: options.selective })
})

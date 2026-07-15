import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type { BotCommand, Message, Update, User } from "./TelegramSchemas.js"
import { decodeEnvelope } from "./internal/telegram/Envelope.js"
import { request } from "./internal/telegram/RawClient.js"
import { safeMessage } from "./internal/telegram/Sanitize.js"
import { NetworkError, TelegramError } from "./TelegramError.js"

export interface TelegramService {
  readonly call: <A = unknown>(method: string, payload?: Readonly<Record<string, unknown>>) => Effect.Effect<A, TelegramError>
  readonly getMe: () => Effect.Effect<User, TelegramError>
  readonly deleteWebhook: (payload?: Readonly<Record<string, unknown>>) => Effect.Effect<boolean, TelegramError>
  readonly setMyCommands: (payload: { readonly commands: ReadonlyArray<BotCommand> } & Readonly<Record<string, unknown>>) => Effect.Effect<boolean, TelegramError>
  readonly getUpdates: (payload?: Readonly<Record<string, unknown>>) => Effect.Effect<ReadonlyArray<Update>, TelegramError>
  readonly sendMessage: (payload: { readonly chat_id: number | string; readonly text: string } & Readonly<Record<string, unknown>>) => Effect.Effect<Message, TelegramError>
  readonly sendDocument: (payload: { readonly chat_id: number | string; readonly document: string | Blob } & Readonly<Record<string, unknown>>) => Effect.Effect<Message, TelegramError>
}

export class Telegram extends Context.Service<Telegram, TelegramService>()("tfx/Telegram") {}

export const make = (token: Redacted.Redacted<string>): Effect.Effect<TelegramService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (client) => {
    const call: TelegramService["call"] = <A>(method: string, payload: Readonly<Record<string, unknown>> = {}) =>
      request(client, `https://api.telegram.org/bot${Redacted.value(token)}/${method}`, payload).pipe(
        Effect.flatMap((body) => decodeEnvelope(method, body)),
        Effect.map((value) => value as A),
        Effect.mapError((cause) => cause instanceof TelegramError
          ? cause
          : new TelegramError({ module: "Telegram", method, reason: new NetworkError({ message: safeMessage(cause) }) }))
      )
    return {
      call,
      getMe: () => call("getMe"),
      deleteWebhook: (payload = {}) => call("deleteWebhook", payload),
      setMyCommands: (payload) => call("setMyCommands", payload),
      getUpdates: (payload = {}) => call("getUpdates", payload),
      sendMessage: (payload) => call("sendMessage", payload),
      sendDocument: (payload) => call("sendDocument", payload)
    }
  })

export const layer = (token: Redacted.Redacted<string>): Layer.Layer<Telegram, never, HttpClient.HttpClient> =>
  Layer.effect(Telegram, make(token))

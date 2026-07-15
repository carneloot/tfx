import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { make as makeGenerated } from "./internal/telegram/generated/TelegramApi.runtime.js"
import type { TelegramApi } from "./internal/telegram/generated/TelegramApi.types.js"
import { safeMessage } from "./internal/telegram/Sanitize.js"
import { fromEnvelope, InvalidResponseError, NetworkError, TelegramError, UnknownError, type TelegramFailureEnvelope } from "./TelegramError.js"

type UnwrapEnvelope<A> = A extends { readonly ok: true; readonly result: infer Result } ? Result : A
type DirectOperation<F> = F extends (options: { readonly payload: infer Payload; readonly config?: unknown }) => Effect.Effect<infer Success, unknown, infer Requirements>
  ? {} extends Payload
    ? (payload?: Payload) => Effect.Effect<UnwrapEnvelope<Success>, TelegramError, Requirements>
    : (payload: Payload) => Effect.Effect<UnwrapEnvelope<Success>, TelegramError, Requirements>
  : F extends (options?: { readonly payload?: infer Payload }) => Effect.Effect<infer Success, unknown, infer Requirements>
  ? (payload?: Payload) => Effect.Effect<UnwrapEnvelope<Success>, TelegramError, Requirements>
  : never
export type TelegramService = { readonly [Method in keyof TelegramApi]: DirectOperation<TelegramApi[Method]> }

export class Telegram extends Context.Service<Telegram, TelegramService>()("tfx/Telegram") {}

const findFailureEnvelope = (value: unknown, seen = new Set<unknown>()): TelegramFailureEnvelope | undefined => {
  if (typeof value === "string") {
    const start = value.indexOf('{"ok":false')
    if (start >= 0) try { return findFailureEnvelope(JSON.parse(value.slice(start))) } catch { return undefined }
    return undefined
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return undefined
  seen.add(value)
  const record = value as Record<string, unknown>
  if (record.ok === false && typeof record.error_code === "number") return record as unknown as TelegramFailureEnvelope
  for (const nested of Object.values(record)) {
    const found = findFailureEnvelope(nested, seen)
    if (found) return found
  }
  return undefined
}

const mapGeneratedError = (method: string, cause: unknown): TelegramError => {
  const failure = findFailureEnvelope(cause)
  if (failure) return fromEnvelope(method, failure)
  const tag = typeof cause === "object" && cause !== null ? (cause as { _tag?: unknown })._tag : undefined
  const message = safeMessage(cause)
  const reason = tag === "RequestError" || tag === "TransportError" || message.toLowerCase().includes("network")
    ? new NetworkError({ message })
    : tag === "SchemaError" || message.toLowerCase().includes("decode") || message.toLowerCase().includes("parse")
    ? new InvalidResponseError({ message })
    : new UnknownError({ message })
  return new TelegramError({ module: "Telegram", method, reason })
}

export const make = (token: Redacted.Redacted<string>): Effect.Effect<TelegramService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (client) => {
    const baseUrl = `https://api.telegram.org/bot${Redacted.value(token)}`
    const generated = makeGenerated(HttpClient.mapRequest(client, HttpClientRequest.prependUrl(baseUrl)))
    return new Proxy({} as TelegramService, {
      get: (_target, property) => {
        if (typeof property !== "string") return undefined
        const operation = generated[property as keyof TelegramApi] as unknown as (options: { payload: unknown }) => Effect.Effect<unknown, unknown>
        return (payload: unknown = {}) => operation({ payload }).pipe(
          Effect.map((envelope) => (envelope as { result: unknown }).result),
          Effect.mapError((cause) => mapGeneratedError(property, cause))
        )
      }
    })
  })

export const layer = (token: Redacted.Redacted<string>): Layer.Layer<Telegram, never, HttpClient.HttpClient> =>
  Layer.effect(Telegram, make(token))

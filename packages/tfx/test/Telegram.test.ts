import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { make } from "../src/Telegram.js"

const run = (body: unknown, inspect?: (url: string) => void) => {
  const client = HttpClient.make((request) => {
    inspect?.(request.url)
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })))
  })
  return <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) => Effect.runPromise(Effect.provideService(effect, HttpClient.HttpClient, client))
}

describe("Telegram", () => {
  it("injects redacted token and strips successful envelope", async () => {
    let url = ""
    const execute = run({ ok: true, result: { message_id: 7 } }, (value) => { url = value })
    const result = await execute(Effect.flatMap(make(Redacted.make("123456:secret")), (telegram) => telegram.sendMessage({ chat_id: 42, text: "oi" })))
    expect(result).toMatchObject({ message_id: 7 })
    expect(url).toBe("https://api.telegram.org/bot123456:secret/sendMessage")
  })
  it("supports file IDs and uploaded blobs", async () => {
    for (const document of ["file-id", new Blob(["data"])]) {
      const execute = run({ ok: true, result: { message_id: 8 } })
      const result = await execute(Effect.flatMap(make(Redacted.make("1:x")), (telegram) => telegram.sendDocument({ chat_id: 1, document })))
      expect(result).toMatchObject({ message_id: 8 })
    }
  })
  it("maps Telegram failure envelopes", async () => {
    const execute = run({ ok: false, error_code: 429, description: "slow", parameters: { retry_after: 2 } })
    await expect(execute(Effect.flatMap(make(Redacted.make("1:x")), (telegram) => telegram.getUpdates()))).rejects.toMatchObject({ _tag: "TelegramError", reason: { _tag: "RateLimitError" } })
  })
})

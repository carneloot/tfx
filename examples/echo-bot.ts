import { Command, Bot } from "tfx"
import { Effect, Layer, Config } from "effect"
import { BunRuntime } from "@effect/platform-bun"

const EchoCommand = Command.make("echo", "Repeats everything that you send")
  .withAlias("e")

const EchoCommandLive = Command.makeLayer(EchoCommand).handler(
  ({ ctx, update }) =>
    Effect.gen(function* () {
      const text = update.message?.text ?? ""
      // Extract args (everything after /echo)
      const args = text.replace(/^\/\w+\s*/, "")
      yield* ctx.reply(args)
    })
)

const BotLive = Bot.makePolling({
  token: Config.redacted("BOT_TOKEN"),
  polling: { timeout: 30 },
}).pipe(
  Layer.provide(EchoCommandLive)
)

Layer.launch(BotLive).pipe(BunRuntime.runMain)

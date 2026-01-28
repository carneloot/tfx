import { BunRuntime } from "@effect/platform-bun"

import { Config, Effect, Layer } from "effect"

import { Bot, BotBuilder, command } from "../src"

// Define the echo command
const EchoCommand = command("echo", "e")
  .withDescription("Repeats everything that you send")
  .handler(
  ({ ctx, update }) =>
    Effect.gen(function*() {
      const text = update.message?.text ?? ""
      const args = text.replace(/^\/\w+\s*/, "")
      yield* ctx.reply(args)
    })
  )

// Implement the echo command with its handler
// Define the bot with global configuration (no error handler here)
const MyBot = Bot.make("Echo Bot!").add(EchoCommand)

// Create the polling bot layer - this provides the Bot service
const PollingBotLayer = Bot.makePolling({
  token: Config.string("BOT_TOKEN"),
  polling: { timeout: 30 }
})

// Implement the bot with commands and error handling
const MyBotLive = BotBuilder.launch(MyBot)

// Combine everything together
const AppLive = MyBotLive.pipe(Layer.provide(PollingBotLayer))

Layer.launch(AppLive).pipe(BunRuntime.runMain)

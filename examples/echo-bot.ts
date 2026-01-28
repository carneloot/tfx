import { BunRuntime } from "@effect/platform-bun"

import { Config, Effect, Layer } from "effect"

import { Bot, BotBuilder, Command, CommandRegistry } from "../src"

// Define the echo command
const EchoCommand = Command.make(
  "echo",
  "Repeats everything that you send"
).withAlias("e")

// Implement the echo command with its handler
const EchoCommandLive = Command.makeLayer(EchoCommand).handler(
  ({ ctx, update }) =>
    Effect.gen(function*() {
      const text = update.message?.text ?? ""
      // Extract args (everything after /echo)
      const args = text.replace(/^\/\w+\s*/, "")
      yield* ctx.reply(args)
    })
)

// Define the bot with global configuration (no error handler here)
const MyBot = Bot.make("Echo Bot!").add(EchoCommand)

// Create the polling bot layer - this provides the Bot service
const PollingBotLayer = Bot.makePolling({
  token: Config.string("BOT_TOKEN"),
  polling: { timeout: 30 }
})

// Implement the bot with commands and error handling
const MyBotLive = BotBuilder.launch(MyBot).pipe(
  Layer.provide(EchoCommandLive),
  Layer.provide(CommandRegistry.live())
)

// Combine everything together
const AppLive = MyBotLive.pipe(Layer.provide(PollingBotLayer))

Layer.launch(AppLive).pipe(BunRuntime.runMain)

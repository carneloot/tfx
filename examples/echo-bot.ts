import { Command, Bot } from "tfx";
import { Effect, Layer, Config } from "Effect";
import { BunRuntime } from "@effect/platform-bun";

const EchoCommand = Command.make(
  "echo",
  "Repeats every thing that you throw at it",
);

const EchoCommandLive = Command.makeLayer(EchoCommand).handler(
  ({ ctx, update }) =>
    Effect.gen(function* () {
      yield* ctx.reply(update);
    }),
);

const MyBotLive = Bot.makePolling({
  token: Config.redacted("BOT_TOKEN"),
});

Layer.launch(MyBotLive.pipe(Layer.provide(EchoCommandLive))).pipe(
  BunRuntime.runMain,
);

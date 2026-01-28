# TFX Telegram Commands Specification

## Overview
Define a command-first Telegram bot SDK inspired by the `@effect/cli` command model. The SDK allows developers to declare commands with keywords, descriptions, and handlers that run in Effect, then run a bot via long polling that dispatches incoming Telegram updates to those handlers. A built-in help command is generated from the command registry and may include a developer-supplied intro string.

## Goals
- Provide a declarative command definition API aligned with Effect patterns.
- Ensure handlers are required and type-safe (missing handler is a type error).
- Run a bot via long polling and dispatch to matching commands.
- Auto-generate a help command that lists commands and descriptions.
- Keep code self-documenting via JSDoc (no tests in v1).

## Non-Goals (v1)
- Webhook support.
- Middleware execution (middleware API can exist but is not executed).
- Advanced routing (regex/argument parsing), permissions, or conversation flows.
- Comprehensive test suite.

## Users & Primary Workflows
- Effect ecosystem users building Telegram bots.
- Common workflow: define commands, register them, run the bot using long polling.

## Functional Requirements
### Command Definition
- A command has:
  - `keywords`: one or more strings used for command matching.
  - `description`: optional short description (used in help output).
  - `handler`: mandatory function that receives Telegram context and returns an Effect.
  - `middlewares`: optional list for future use; not executed in v1.
- Missing `handler` must be a TypeScript type error.
- Command definitions should follow `@effect/cli`-like patterns (builder or constructor with strong typing and fluent composition).

### Command Registry
- Provide a way to register a list of commands as the bot program input.
- Expose a `help` or `helpCommand` function that produces a help command from the registry.
- Allow a developer-supplied optional help intro string included in the help output.

### Runtime (Long Polling)
- Provide a `run` or `start` function that:
  - Accepts the Telegram bot token and the command registry.
  - Uses long polling to receive updates.
  - Parses Telegram command entities to extract the command keyword (e.g., `/start` -> `start`).
  - Dispatches to the matching command handler based on keywords.
- If no command matches, do nothing by default (no automatic error replies).

### Help Command Behavior
- The help command lists each command keyword and description.
- Uses the optional help intro string if provided.
- The help command is registered by default unless explicitly disabled in the registry options.

## API Sketch (Illustrative)
```ts
import * as Tg from "tfx/telegram"

const ping = Tg.command({
  keywords: ["ping"],
  description: "Check bot health",
  handler: ({ ctx }) => ctx.reply("pong")
})

const commands = Tg.commands([ping], { helpIntro: "My bot commands:" })

Tg.run({ token: process.env.BOT_TOKEN, commands })
```

## Documentation
- Add JSDoc to all public APIs.
- Provide a short README or example snippet showing command definition and `run`.

## Dependencies & Constraints
- Language: TypeScript with Effect.
- Use existing Telegram Effect libraries in this repo (`@effect-ak/tg-bot-api`, `@effect-ak/tg-bot-client`).

## Future Considerations
- Middleware execution pipeline.
- Webhook transport.
- Argument parsing and richer command routing.

# TFX Implementation Status

## Project Setup Complete ✅

The foundation for TFX (Telegram Framework on Effect.ts) has been set up with:

### Files Created

#### Core API Files
- **`src/Bot.ts`** - Bot definition and factory
- **`src/Command.ts`** - Command definition and builder pattern
- **`src/CommandGroup.ts`** - Command grouping with nesting support
- **`src/Middleware.ts`** - Middleware base class
- **`src/BotContext.ts`** - Handler context with reply methods

#### Internal Infrastructure
- **`src/internal/TgClient.ts`** - Wrapper around @effect-ak/tg-bot-client
- **`src/internal/Routing.ts`** - Command matching and routing logic
- **`src/internal/Polling.ts`** - Long polling loop implementation
- **`src/internal/Handler.ts`** - Handler execution pipeline

#### Error Handling
- **`src/errors/BotError.ts`** - Custom error types

#### Exports & Documentation
- **`src/index.ts`** - Main package exports
- **`plan.md`** - Comprehensive architecture and design documentation
- **`examples/echo-bot.ts`** - Updated example with correct API

### Architecture Implemented

The codebase follows effect.ts patterns:
1. ✅ **Declarative API** - Command.make(), CommandGroup.make(), etc
2. ✅ **Layer-based composition** - Bot.makePolling() creates layers
3. ✅ **Type-safe Context.Tag system** - For dependency injection
4. ✅ **Fluent builder patterns** - .withAlias(), .add(), .addSubGroup()
5. ✅ **Separation of concerns** - Definition, implementation, and runtime layers

### Current State

The files are **skeleton implementations** with:
- ✅ Proper type signatures matching the design doc
- ✅ JSDoc comments for all public APIs
- ✅ Stub implementations ready for full development
- ❌ NOT YET functional - need to complete the implementation

## Next Steps

### Phase 1: Core Infrastructure (HIGH PRIORITY)
These need to be implemented for any working bot:

1. **Fix TgClient** (`src/internal/TgClient.ts`)
   - Properly wrap @effect-ak/tg-bot-client
   - Implement Effect-based sendMessage and execute methods
   - Handle polling with get_updates

2. **Complete Command Context Tags** (`src/Command.ts`)
   - Create proper Context.Tag for each command
   - Ensure CommandLayerBuilder properly creates layers
   - Support handler attachment and execution

3. **Implement Handler Pipeline** (`src/internal/Handler.ts`)
   - Execute handlers with proper BotContext injection
   - Connect to command routing
   - Ensure errors are captured (handlers must have error: never)

4. **Add Command Routing** (`src/internal/Routing.ts`)
   - Implement most-specific-match precedence
   - Support aliases
   - Detect duplicate triggers at layer creation time

### Phase 2: Bot Runner Integration
1. **Connect Polling Loop** (`src/Bot.ts`)
   - Wire up longPollingLoop with command matching
   - Route matched commands to handlers
   - Handle global onDefect errors

2. **BotContext Implementation** (`src/BotContext.ts`)
   - makeBotContext() should create proper context
   - reply() method should use TgBotClient

### Phase 3: CommandGroup System
1. **CommandGroup Nesting** (`src/CommandGroup.ts`)
   - Support nested groups with /prefix subgroup command format
   - Aggregate commands from all nested levels
   - Create proper layers for groups

2. **Group Layer Creation**
   - CommandGroupLayerBuilder.buildLayer() should provide all contained commands

### Phase 4: Middleware System
1. **Middleware Tag System** (`src/Middleware.ts`)
   - Create proper Context.Tag pattern for middleware
   - Support dependency injection via Effect

2. **Middleware Execution**
   - Run global middleware on all updates
   - Run per-command middleware
   - Short-circuit on failure
   - Enhance context for handlers

### Phase 5: Polish & Testing
1. Type safety verification
2. Error message improvements
3. Documentation and examples
4. Test suite

## Key Design Constraints

- ✅ **Commands are global** - No scoping by chat
- ✅ **Handler error channel is never** - Errors must be handled inside handlers
- ✅ **Defects vs Errors** - System errors go to onDefect, command errors are in handlers
- ✅ **Most-specific-match routing** - /admin ban before /admin before /
- ✅ **Middleware like @effect/platform** - Global + per-command with context enhancement
- ✅ **Layer-based composition** - Everything uses Layer for dependency management

## How to Build

1. Start with Phase 1 (TgClient, Command Tags, Handler Pipeline)
2. Test with the echo-bot example early
3. Implement each phase before moving to the next
4. Run `pnpm check` to verify types
5. Run `pnpm test` to run tests (will create test files)

## API Preview

The target API once complete:

```typescript
import { Command, CommandGroup, Bot } from "tfx"
import { Effect, Layer, Config } from "effect"
import { BunRuntime } from "@effect/platform-bun"

// Define commands
const EchoCommand = Command.make("echo", "Echo messages")
  .withAlias("e")

const EchoCommandLive = Command.makeLayer(EchoCommand).handler(
  ({ ctx, update }) =>
    Effect.gen(function* () {
      const text = update.message?.text ?? ""
      const args = text.replace(/^\/\w+\s*/, "")
      yield* ctx.reply(args, { parse_mode: "HTML" })
    })
)

// Define command groups
const AdminGroup = CommandGroup.make("admin", "Admin commands")
  .add(BanCommand)

const AdminGroupLive = CommandGroup.makeLayer(AdminGroup)

// Create bot
const BotLive = Bot.makePolling({
  token: Config.redacted("BOT_TOKEN"),
  polling: { timeout: 30 },
}).pipe(
  Layer.provide([EchoCommandLive, AdminGroupLive])
)

// Run
Layer.launch(BotLive).pipe(BunRuntime.runMain)
```

This will be fully type-safe with:
- ✅ Type checking that all commands are provided
- ✅ Type checking that all middleware is provided
- ✅ Handler type safety (no throws, error handling required)
- ✅ Context tag system for dependency tracking

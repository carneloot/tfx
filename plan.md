# TFX - Telegram Bot Framework on Effect.ts

A type-safe Telegram bot framework built on effect.ts, providing an API similar to `@effect/platform` HTTP servers.

## Architecture Overview

### Core Philosophy

TFX follows effect.ts patterns:
- **Declarative first**: Separate definitions from implementations
- **Type-safe dependency injection**: Context.Tag system for services and middleware
- **Composable layers**: Build complex bots from simple, testable components
- **Effects-based**: All operations are Effects, errors flow through types, never thrown

### Three-Layer Pattern (Like @effect/platform)

1. **Definition Layer** (`Bot.define`, `Command.make`, `Middleware.make`)
   - Pure data structures describing the bot API
   - No side effects or resource allocation
   - Can be introspected and validated

2. **Implementation Layer** (`BotLive`, `makeLayer`)
   - Concrete implementations using `Layer.succeed` and `Layer.effect`
   - Providers for services and middleware
   - Dependency injection setup

3. **Runtime Layer** (`Layer.launch`)
   - Actual effect execution with resource management
   - Polling loop and update processing
   - Error handling and cleanup

## API Design

### Commands

Commands represent `/command` triggers in Telegram.

```typescript
// Define a command with description
const EchoCommand = Command.make("echo", "Repeats everything you send")
  .withAlias("e")           // Supports multiple aliases
  .withAlias("repeat")

// Declare what services/middleware this command needs
interface EchoCommandDeps {
  // Services the handler might need
}

// Create a layer that implements the command
const EchoCommandLive = Command.makeLayer(EchoCommand).handler(
  ({ ctx, update }) =>
    Effect.gen(function* () {
      // update is the full Telegram Update object
      // Extract args from the message (everything after /echo)
      const text = update.message?.text ?? ""
      const args = text.replace(/^\/\w+\s*/, "")
      
      // Reply with formatted text
      yield* ctx.reply(args, { parse_mode: "HTML" })
    })
)

// Commands are global - they work in any chat
// Handlers must have error channel be 'never' (no throws)
```

**Handler Signature:**
```typescript
type CommandHandler = (input: {
  ctx: BotContext
  update: Update
}) => Effect<void, never, Requirements>
```

**BotContext Methods:**
```typescript
interface BotContext {
  reply(text: string, options?: ReplyOptions): Effect<void, never, BotTgClient>
}

type ReplyOptions = {
  parse_mode?: "HTML" | "Markdown" | "MarkdownV2"
  disable_web_page_preview?: boolean
  disable_notification?: boolean
  protect_content?: boolean
  reply_to_message_id?: number
}
```

### Command Groups

Group related commands under a common prefix. Groups can be nested.

```typescript
// Simple group
const AdminGroup = CommandGroup.make("admin", "Admin commands")
  .add(BanCommand)
  .add(KickCommand)
  .add(WarnCommand)

// Group creates triggers like /admin ban, /admin kick, /admin warn

// Nested groups
const ModGroup = CommandGroup.make("mod", "Moderation commands")
  .addSubGroup(AdminGroup)  // Contains /mod admin ban, /mod admin kick, etc

// Layer for group (no handler, just composition)
const AdminGroupLive = CommandGroup.makeLayer(AdminGroup)
```

**Trigger Matching Priority:**
- Most specific match wins
- `/admin ban` before `/admin` before `/`
- If multiple commands match equally, layer creation fails with error

### Middleware

Middleware process updates before command matching. Similar to `HttpApiMiddleware` in @effect/platform.

```typescript
// Define middleware with what it provides/expects
class AuthMiddleware extends Context.Tag<AuthMiddleware>()(
  "AuthMiddleware",
  {
    success: authenticateUser,  // What it provides (a tag)
    provides: AuthenticatedUser, // Service it makes available to handlers
  }
) {}

class AuthenticatedUser extends Context.Tag<AuthenticatedUser>()(
  "AuthenticatedUser",
  {
    userId: Schema.Number,
    username: Schema.String,
  }
) {}

// Implement the middleware
const AuthMiddlewareLive = Layer.succeed(
  AuthMiddleware,
  {
    failure: UnauthorizedError,
    provides: AuthenticatedUser,
    handler: ({ update }) =>
      Effect.gen(function* () {
        // Extract user from update, validate, etc
        return {
          userId: update.from?.id ?? 0,
          username: update.from?.username ?? "anonymous",
        }
      })
  }
)

// Commands can declare middleware dependencies
const AdminCommand = Command.make("admin", "Admin only")
  .requiresMiddleware(AuthMiddleware)
```

**Middleware Execution:**
- Global middleware runs on every update
- Per-command middleware runs before that command's handler
- Middleware can short-circuit (return failure) to prevent handler execution
- Middleware can enhance BotContext with additional data via Context.Tag

### Bot Definition & Implementation

Define the bot once, implement it multiple times (testing, multiple environments, etc).

```typescript
// BotDefinition - declarative
const BotDefinition = Bot.define({
  // Global error handler for defects (not command errors)
  onDefect: (defect, context: { command?: string; update: Update }) =>
    Effect.logError(defect)
})

// BotLive - concrete implementation
const BotLive = BotLive.makePolling({
  token: Config.redacted("BOT_TOKEN"),
  polling: {
    timeout: 30,
    limit: 100,
    allowed_updates: ["message"],
  },
}).pipe(
  Layer.provide([
    EchoCommandLive,
    AdminGroupLive,
    AuthMiddlewareLive,
  ]),
  Layer.provide(/* other services */)
)

// Run the bot
Layer.launch(BotLive).pipe(BunRuntime.runMain)
```

**Polling Options:**
```typescript
type PollingOptions = {
  timeout?: number              // Long polling timeout (5-120 seconds)
  limit?: number                // Updates per poll (1-100)
  allowed_updates?: string[]    // Filter update types
  on_error?: "stop" | "continue" // What to do on poll errors
  log_level?: "debug" | "info"
}
```

## Type-Safe Command Tags

Each command has a context tag that marks it as "available". This ensures all commands are provided when launching.

```typescript
// After Command.makeLayer(), the tag is available in the requirements
const EchoCommandLive: Layer<never, never, EchoCommand>

// If you forget to provide a command, TypeScript error:
const BotLive = BotLive.makePolling(...).pipe(
  Layer.provide([/* missing EchoCommandLive */])
  // TS Error: Type 'EchoCommand' is not assignable to type 'never'
)
```

**Similar for CommandGroups:**
```typescript
const AdminGroupLive: Layer<never, never, AdminGroup>
```

## Error Handling Strategy

### Command Handler Errors

Command handlers have error channel `never`, meaning they must handle all errors internally:

```typescript
const MyCommand = Command.make("test")

const MyCommandLive = Command.makeLayer(MyCommand).handler(
  ({ ctx, update }) =>
    Effect.gen(function* () {
      try {
        // Operations that might fail
        const result = yield* someEffect
      } catch (e) {
        // Handle or reply with error message
        yield* ctx.reply("An error occurred")
      }
      // OR use Effect.catchAll
      return yield* someEffect.pipe(
        Effect.catchAll(err => 
          ctx.reply("An error occurred")
        )
      )
    })
)
```

### Global Defect Handling

Defects (unexpected errors at runtime, not in handlers) go to `onDefect`:

```typescript
const BotDefinition = Bot.define({
  onDefect: (defect, { command, update }) =>
    Effect.gen(function* () {
      yield* Effect.logError(defect)
      // Could send to error tracking service, notify admins, etc
    })
})
```

## File Structure

```
src/
├── Bot.ts                 # Bot.define, BotLive.makePolling
├── Command.ts             # Command.make, Command.makeLayer
├── CommandGroup.ts        # CommandGroup.make, nesting, grouping
├── Middleware.ts          # Middleware base class, patterns
├── BotContext.ts          # BotContext type and methods (reply, etc)
├── index.ts               # Main exports
├── internal/
│   ├── Routing.ts         # Update → Command matching and routing
│   ├── Polling.ts         # Long polling loop implementation
│   ├── Handler.ts         # Handler execution pipeline
│   ├── TgClient.ts        # Wrapper around @effect-ak/tg-bot-client
│   └── types.ts           # Internal shared types
└── errors/
    ├── BotError.ts        # Base error types
    └── CommandConflict.ts  # Duplicate command trigger error
```

## Implementation Phases

### Phase 1: Core Types & Infrastructure
- [ ] BotContext type with reply methods
- [ ] Command.make() and Command.makeLayer()
- [ ] Context.Tag system for commands
- [ ] TgClient wrapper around @effect-ak/tg-bot-client
- [ ] Error types

### Phase 2: Bot Runner
- [ ] Bot.define() for configuration
- [ ] BotLive.makePolling() layer creator
- [ ] Polling loop with long polling
- [ ] Update dispatch to handlers

### Phase 3: Command Routing
- [ ] Extract command trigger from message
- [ ] Match against defined commands and aliases
- [ ] Conflict detection (duplicate triggers at layer creation)
- [ ] Most-specific-match precedence

### Phase 4: CommandGroup System
- [ ] CommandGroup.make() and composition
- [ ] Nested groups with proper prefix handling
- [ ] CommandGroup layers and tags
- [ ] Group handler aggregation

### Phase 5: Middleware System
- [ ] Middleware.make() base pattern
- [ ] Per-command middleware attachment
- [ ] Global middleware execution
- [ ] Context enhancement by middleware
- [ ] Middleware tags and dependency tracking

### Phase 6: Integration & Polish
- [ ] Integration testing
- [ ] Example bot fully working
- [ ] Documentation and JSDoc comments
- [ ] Error messages and debugging info
- [ ] Type safety verification

## API Examples

### Simple Echo Bot

```typescript
import { Command, Bot } from "tfx"
import { Effect, Layer, Config } from "effect"
import { BunRuntime } from "@effect/platform-bun"

const EchoCommand = Command.make("echo", "Repeats what you send")
  .withAlias("e")

const EchoCommandLive = Command.makeLayer(EchoCommand).handler(
  ({ ctx, update }) =>
    Effect.gen(function* () {
      const text = update.message?.text ?? ""
      const args = text.replace(/^\/\w+\s*/, "")
      yield* ctx.reply(args, { parse_mode: "HTML" })
    })
)

const BotLive = Bot.makePolling({
  token: Config.redacted("BOT_TOKEN"),
  polling: { timeout: 30 },
}).pipe(
  Layer.provide(EchoCommandLive)
)

Layer.launch(BotLive).pipe(BunRuntime.runMain)
```

### Bot with Groups and Middleware

```typescript
// Auth middleware
class RequireAdmin extends Context.Tag<RequireAdmin>()(
  "RequireAdmin",
  {
    provides: AdminUser,
  }
) {}

class AdminUser extends Context.Tag<AdminUser>()(
  "AdminUser",
  { userId: Schema.Number }
) {}

const RequireAdminLive = Layer.succeed(
  RequireAdmin,
  {
    handler: ({ update }) =>
      update.message?.from?.id === ADMIN_ID
        ? Effect.succeed({ userId: ADMIN_ID })
        : Effect.fail(new UnauthorizedError())
  }
)

// Admin commands
const BanCommand = Command.make("ban", "Ban a user")
  .requiresMiddleware(RequireAdmin)

const BanCommandLive = Command.makeLayer(BanCommand).handler(
  ({ ctx, update }) =>
    Effect.gen(function* () {
      const admin = yield* AdminUser
      yield* ctx.reply(`Admin ${admin.userId} banned a user`)
    })
)

const AdminGroup = CommandGroup.make("admin")
  .add(BanCommand)

const AdminGroupLive = CommandGroup.makeLayer(AdminGroup)

const BotLive = Bot.makePolling({
  token: Config.redacted("BOT_TOKEN"),
}).pipe(
  Layer.provide(RequireAdminLive),
  Layer.provide(AdminGroupLive),
  Layer.provide(BanCommandLive),
)

Layer.launch(BotLive).pipe(BunRuntime.runMain)
```

## Design Decisions

1. **Commands are global**: No scope/chat-specific commands initially
2. **Handler = Effect with never error channel**: Forces error handling in handlers
3. **Defects separate from errors**: Command errors are handled in commands, system errors go to onDefect
4. **Layer-based composition**: Like @effect/platform, enables testing and flexibility
5. **Most-specific-match routing**: `/admin ban` before `/admin`
6. **Middleware like HttpApiMiddleware**: Global + per-command, can enhance context
7. **Command/Group tags**: Type-safe dependency injection, catch missing implementations at compile time

## Future Enhancements

- [ ] Support for callback queries and buttons
- [ ] Inline query handlers
- [ ] File uploads/downloads
- [ ] Conversation state management
- [ ] Rate limiting middleware
- [ ] Command metadata (usage, help)
- [ ] Other response types (photo, video, document, etc)
- [ ] Webhook support alongside polling
- [ ] Multi-bot management

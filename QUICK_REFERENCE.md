# TFX Quick Reference

## File Locations

| Document | Purpose | When to Read |
|----------|---------|--------------|
| `plan.md` | Full architecture & design (300+ lines) | For complete understanding |
| `IMPLEMENTATION_STATUS.md` | Status & phase roadmap | For what to build next |
| `FILE_STRUCTURE.md` | Module organization | For file navigation |
| `QUICK_REFERENCE.md` | This file | For quick lookup |

## Main API Classes

### Command
```typescript
import { Command } from "tfx"

// Define
const MyCmd = Command.make("name", "description")
  .withAlias("alias1")
  .withAlias("alias2")

// Implement
const MyCommandLive = Command.makeLayer(MyCmd).handler(
  ({ ctx, update }) => Effect.gen(...)
)
```

### CommandGroup
```typescript
import { CommandGroup } from "tfx"

// Define
const AdminGroup = CommandGroup.make("admin", "Admin commands")
  .add(Command1)
  .add(Command2)
  .addSubGroup(NestedGroup)  // Nesting supported

// Implement
const AdminGroupLive = CommandGroup.makeLayer(AdminGroup)
```

### Bot
```typescript
import { Bot } from "tfx"
import { Layer, Config } from "effect"

// Define configuration
const BotDef = Bot.define({
  onDefect: (error, ctx) => Effect.logError(error)
})

// Create layer
const BotLive = Bot.makePolling({
  token: Config.redacted("BOT_TOKEN"),
  polling: { timeout: 30, limit: 100 }
}).pipe(
  Layer.provide([CommandLive, GroupLive])
)

// Run
Layer.launch(BotLive).pipe(BunRuntime.runMain)
```

### BotContext (in handlers)
```typescript
handler: ({ ctx, update }) => Effect.gen(function* () {
  // Reply with text
  yield* ctx.reply("Hello!")
  
  // Reply with formatting
  yield* ctx.reply("Hello!", {
    parse_mode: "HTML",
    disable_notification: true
  })
})
```

## Handler Signature

```typescript
type CommandHandler = (input: {
  ctx: BotContext
  update: Update              // Full Telegram Update
}) => Effect<void, never, Requirements>
                ↑                 ↑
           No output         No errors allowed
           (void)         (must handle internally)
```

## Middleware (Pattern)
```typescript
class MyMiddleware extends Context.Tag<MyMiddleware>()(...) {}

const MyMiddlewareLive = makeMiddlewareLayer(MyMiddleware, ({ ctx, update }) =>
  Effect.gen(...)
)

// Use in commands
const MyCommand = Command.make(...).requiresMiddleware(MyMiddleware)
```

## Most-Specific-Match Routing

Priority order:
1. Exact command match (`/admin ban`)
2. Alias match
3. Duplicate triggers → **Error at layer creation**

Example:
```
/admin ban      ← Matches /admin ban command first
/admin          ← Would match only if /admin ban not defined
```

## Error Handling

**In Handlers** (must handle):
```typescript
handler: ({ ctx, update }) =>
  Effect.gen(function* () {
    try {
      yield* someEffect
    } catch (e) {
      yield* ctx.reply("Error: " + e.message)
    }
  })
```

**Globally** (defects):
```typescript
Bot.define({
  onDefect: (defect, { command, update }) =>
    Effect.logError(defect)
})
```

## File Organization Quick Map

```
src/
├── Bot.ts              → Bot service, makePolling()
├── Command.ts          → Command definition, builders
├── CommandGroup.ts     → Group definition, nesting
├── Middleware.ts       → Middleware patterns
├── BotContext.ts       → Handler context (reply, etc)
├── index.ts            → Main exports
└── internal/
    ├── TgClient.ts     → Telegram client wrapper
    ├── Routing.ts      → Command matching logic
    ├── Polling.ts      → Update polling loop
    └── Handler.ts      → Handler execution
```

## Implementation Phases Checklist

- [ ] Phase 1: TgClient + Command tags + Handler pipeline
- [ ] Phase 2: Bot runner + polling loop
- [ ] Phase 3: Routing + CommandGroups
- [ ] Phase 4: Middleware system
- [ ] Phase 5: Testing + Polish

## Key Constraints

✓ Commands are **global** (not chat-specific)
✓ Handlers **cannot throw** (error channel = never)
✓ Middleware **can enhance context**
✓ Most **specific match wins**
✓ **Type-safe** dependency injection via Context.Tag

## Common Patterns

### Simple Echo Bot
```typescript
const Echo = Command.make("echo", "Echo").withAlias("e")
const EchoLive = Command.makeLayer(Echo).handler(
  ({ ctx, update }) =>
    Effect.gen(function* () {
      const args = update.message?.text?.replace(/^\/\w+\s*/, "") ?? ""
      yield* ctx.reply(args)
    })
)
const BotLive = Bot.makePolling({ token: "..." }).pipe(Layer.provide(EchoLive))
Layer.launch(BotLive).pipe(BunRuntime.runMain)
```

### Command with Alias
```typescript
Command.make("start", "Start bot")
  .withAlias("begin")
  .withAlias("hello")
```

### Nested Groups
```typescript
const Mod = CommandGroup.make("mod", "Moderation")
  .add(BanCmd)

const Admin = CommandGroup.make("admin", "Admin")
  .addSubGroup(Mod)  // Creates /admin mod [commands]
```

### With Formatting
```typescript
ctx.reply("**Bold** text", { 
  parse_mode: "Markdown" 
})
```

## To Get Started

1. Read `plan.md` (sections: Architecture Overview → API Design)
2. Check `IMPLEMENTATION_STATUS.md` (Phase 1 section)
3. Review `examples/echo-bot.ts` for API usage
4. Start implementing Phase 1 components

## Questions?

- **API Design**: See `plan.md` sections 3-5
- **Architecture**: See `plan.md` section 1-2
- **Implementation Path**: See `IMPLEMENTATION_STATUS.md` "Next Steps"
- **File Purpose**: See `FILE_STRUCTURE.md`

# TFX File Structure

## Overview

```
tfx/
├── plan.md                          # Comprehensive architecture and design doc
├── IMPLEMENTATION_STATUS.md         # Current status and next steps
├── FILE_STRUCTURE.md               # This file
├── examples/
│   └── echo-bot.ts                 # Example echo bot using TFX API
├── src/
│   ├── index.ts                    # Main package exports
│   ├── Bot.ts                      # Bot definition, BotLive, makePolling()
│   ├── Command.ts                  # Command.make(), builder pattern
│   ├── CommandGroup.ts             # CommandGroup, nesting, composition
│   ├── Middleware.ts               # Middleware base class and factory
│   ├── BotContext.ts               # BotContext interface, reply() method
│   ├── errors/
│   │   └── BotError.ts             # Custom error types
│   └── internal/
│       ├── TgClient.ts             # @effect-ak/tg-bot-client wrapper
│       ├── Routing.ts              # Command matching, trigger extraction
│       ├── Polling.ts              # Long polling loop
│       └── Handler.ts              # Handler execution pipeline
├── test/
│   └── (test files to be created)
└── (config files: tsconfig, package.json, etc)
```

## File Responsibilities

### Top-Level Documents

| File | Purpose |
|------|---------|
| `plan.md` | Complete architecture, API design, examples, and design decisions |
| `IMPLEMENTATION_STATUS.md` | Current implementation status and phase-by-phase roadmap |
| `FILE_STRUCTURE.md` | This file - overview of module organization |

### Core API (`src/`)

| File | Exports | Purpose |
|------|---------|---------|
| `index.ts` | All public APIs | Main entry point, re-exports all public types and functions |
| `Bot.ts` | Bot, BotLive, BotDefinition | Bot service definition and factory methods |
| `Command.ts` | Command, CommandBuilder, CommandLayerBuilder | Command definition with fluent builder API |
| `CommandGroup.ts` | CommandGroup, CommandGroupBuilder | Grouping related commands with nesting |
| `Middleware.ts` | Middleware, makeMiddlewareLayer | Middleware base class and helpers |
| `BotContext.ts` | BotContext, makeBotContext, ReplyOptions | Handler context with reply helpers |

### Internal Infrastructure (`src/internal/`)

| File | Purpose |
|------|---------|
| `TgClient.ts` | Wraps @effect-ak/tg-bot-client in Effect pattern |
| `Routing.ts` | Extracts commands from messages, matches to handlers |
| `Polling.ts` | Long polling loop implementation |
| `Handler.ts` | Handler execution with context injection |

### Error Handling (`src/errors/`)

| File | Exports | Purpose |
|------|---------|---------|
| `BotError.ts` | BotError, CommandConflictError, MissingMiddlewareError, MissingCommandError | Custom error types |

## Dependencies

```
Effect.ts (peer dependency)
@effect-ak/tg-bot-client
@effect-ak/tg-bot-api
@effect/platform-bun (for examples)
```

## Implementation Phases

### Phase 1: Core Infrastructure
Implement the skeleton code in:
- `TgClient.ts` - Telegram client wrapper
- `Command.ts` - Context tags for commands
- `Handler.ts` - Handler execution pipeline

### Phase 2: Bot Runner
Implement in:
- `Bot.ts` - Connect polling to handlers
- `BotContext.ts` - Message sending

### Phase 3: Routing & Groups
Implement in:
- `Routing.ts` - Command matching algorithm
- `CommandGroup.ts` - Group composition and nesting

### Phase 4: Middleware
Implement in:
- `Middleware.ts` - Middleware tag system and execution
- Update `Handler.ts` to run middleware before handlers

### Phase 5: Polish & Testing
- Add tests in `test/` directory
- Verify type safety
- Update examples

## API Surface

### Public Exports from `src/index.ts`

```typescript
// Bot API
export { Bot, BotLive, BotDefinition }
export type { BotDefinitionConfig, PollingOptions, PollingBotConfig }

// Command API
export { Command }
export type { CommandConfig, CommandHandler }
export { CommandBuilder, CommandLayerBuilder }

// CommandGroup API
export { CommandGroup }
export type { CommandGroupConfig }
export { CommandGroupBuilder, CommandGroupLayerBuilder }

// Middleware API
export { Middleware, makeMiddlewareLayer }
export type { MiddlewareResult }

// BotContext API
export { makeBotContext }
export type { BotContext, ReplyOptions }

// Errors
export {
  BotError,
  CommandConflictError,
  MissingMiddlewareError,
  MissingCommandError,
}
```

## Type Hierarchy

```
Effect.Context.Tag
├── Bot (service)
├── Command (per-command tag)
├── CommandGroup (per-group tag)
├── Middleware (per-middleware tag)
└── TgBotClient (internal service)

Builders
├── CommandBuilder → CommandLayerBuilder
├── CommandGroupBuilder → CommandGroupLayerBuilder
└── BotDefinition (for configuration)

Types
├── BotContext
├── BotDefinitionConfig
├── CommandConfig
├── CommandHandler
├── CommandGroupConfig
├── PollingOptions
├── ReplyOptions
└── Update (from @effect-ak/tg-bot-api)
```

## Next Actions

1. **Review `plan.md`** for complete design details
2. **Check `IMPLEMENTATION_STATUS.md`** for phase-by-phase roadmap
3. **Start Phase 1** with TgClient wrapper implementation
4. **Test with echo-bot example** early and often
5. **Iterate** using this file structure as reference

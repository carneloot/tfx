# AGENTS.md - Coding Guidelines for AI Agents

This document provides essential information for AI coding agents operating in this repository.

## Project Overview

- **Project**: TFX - Effect.js-based Telegram Bot Framework
- **Language**: TypeScript
- **Package Manager**: bun
- **Runtime**: Node.js with tsx support
- **Testing**: Vitest with @effect/vitest
- **Code Quality**: ESLint + TypeScript

## Build, Lint, and Test Commands

### Build
```bash
bun run build              # Full build (ESM + CJS + annotations)
bun run build-esm          # Build only ESM
bun run build-cjs          # Build only CommonJS
bun run build-annotate     # Add pure call annotations
```

### Type Checking
```bash
bun run check              # TypeScript type checking
```

### Linting
```bash
bun run lint               # Run ESLint on all source files
bun run lint-fix           # Auto-fix linting issues
```

### Testing
```bash
bun run test               # Run all tests with Vitest
bun run test <file>        # Run specific test file
bun test --run             # Run tests once (no watch mode)
bun run coverage           # Generate coverage report
```

### Other Commands
```bash
bun run codegen            # Prepare package (Effect codegen)
bunx tsx ./path/file.ts    # Execute TypeScript file directly
```

## Code Style Guidelines

### Formatting
- **Indent**: 2 spaces
- **Line Width**: 120 characters
- **Semi-colons**: ASI (automatic semicolon insertion)
- **Quotes**: Always double quotes
- **Trailing Commas**: Never
- **Arrow Functions**: Always use parentheses (force)
- Tool: dprint via @effect/dprint ESLint plugin (enforced)

### Imports
- **Type Imports**: Use `import type { ... }` for type-only imports (rule: consistent-type-imports)
- **Import Organization**: Enforce with simple-import-sort
  - Group by: stdlib → packages → local imports
  - Alphabetically sorted within groups
- **No Duplicate Imports**: Each module imported only once
- **Newline After Imports**: Required between imports and code
- No spread syntax in Array.push()

### Naming Conventions
- **Files**: PascalCase for classes/components (e.g., `Bot.ts`, `Command.ts`)
- **Variables/Functions**: camelCase
- **Constants**: camelCase (uppercase reserved for special cases)
- **Unused Parameters**: Prefix with `_` to suppress warnings (e.g., `_unused`)
- **Interfaces/Types**: No "I" prefix (not Hungarian notation)

### Types and Type Safety
- **Array Type**: Use generic syntax `Array<T>` instead of `T[]`
- **Non-null Assertions**: Allowed (rule off)
- **Explicit Any**: Allowed (rule off)
- **Destructuring**: Must be alphabetically sorted (sort-destructure-keys)
- No shorthand object notation for methods
- Spread syntax discouraged in function parameters

### Error Handling
- Use Effect's Result/Try types where applicable
- Custom errors: Extend from base error classes
- Error classes in `src/errors/` directory
- Implement proper error context and messages
- Error types should be exported in main index for public API

### Function Declarations
- **Return Types**: Optional (no explicit-function-return-type rule)
- **Prefer**: Named exports over default exports
- **Async**: Use Effect's async primitives when possible
- Arrow functions preferred for consistency

### Module Exports
- **Main Export**: `src/index.ts` (barrel file pattern)
- **Organization**: Group related exports by feature
- **Comments**: Use `// Feature Name` comments to organize export sections
- **Internal Exports**: Mark clearly with `// Internal exports` comment
- **Type vs Value**: Separate `export type` from `export`

### Comments and Documentation
- Use `//` for single-line comments (not block comments for code)
- Document public API functions with JSDoc where helpful
- Keep comments minimal—code should be self-documenting

### Object and Destructuring
- Use object shorthand when properties match variable names
- Sort destructured keys alphabetically
- Prefer destructuring in function parameters

## TypeScript Configuration

- **Target**: ES2018+
- **Module**: ESNext (compiled to CommonJS during build)
- **Declaration**: Generated for .d.ts files
- **Strict Mode**: Enabled (implicitly in tsconfig.json)
- **Source Maps**: Enabled in build output

## Project Structure

```
src/
  ├── index.ts                 # Main barrel export
  ├── Bot.ts                   # Core Bot class
  ├── Command.ts               # Command system
  ├── CommandGroup.ts          # Command grouping
  ├── Middleware.ts            # Middleware layer
  ├── BotContext.ts            # Bot context type
  ├── errors/                  # Error classes
  │   └── BotError.ts
  └── internal/                # Internal implementation
      ├── TgClient.ts          # Telegram client
      ├── Routing.ts           # Command routing
      ├── Polling.ts           # Update polling
      └── Handler.ts           # Command execution

test/
  └── *.test.ts               # Test files (Vitest)
```

## Testing Guidelines

- **Framework**: Vitest with @effect/vitest helpers
- **Imports**: Use `import { describe, expect, it } from "@effect/vitest"`
- **File Pattern**: `*.test.ts` in `test/` directory
- **Setup**: See `setupTests.ts` for global test configuration
- **Running Single Test**: `bun run test path/to/test.test.ts`

## Pre-commit and CI

- All code must pass TypeScript type checking (`bun run check`)
- All code must pass ESLint (`bun run lint`)
- All tests must pass (`bun test --run`)
- Fix issues with `bun run lint-fix` before committing

## Key Dependencies

- **effect**: ^3.17.7 - Core Effect library
- **@effect/eslint-plugin**: Code quality
- **@effect/vitest**: Testing utilities
- **@effect/build-utils**: Build automation
- TypeScript 5.6.2
- Babel for CommonJS transformation

## Notes for Agents

1. Always run `bun run check` before committing to catch type errors
2. Always run `bun run lint-fix` to auto-fix formatting issues
3. Prefer Effect patterns (Effect.sync, Effect.promise) over raw promises
4. Follow the barrel export pattern in index.ts
5. Test files should be co-located with `test/` directory, not inline
6. Use camelCase for variable names, PascalCase for file names (when they're classes)

## Example Pattern: Echo Bot

The `examples/echo-bot.ts` file demonstrates the recommended pattern for TFX applications. When making changes to the core Bot or Command API, **always update this example** to keep it in sync. The pattern follows Effect's HttpApi design:

1. **Define**: Create command/bot definitions (no implementation details)
   ```ts
   const MyBot = Bot.define({ /* config */ })
   const MyCommand = Command.make("name", "description")
   ```

2. **Implement**: Create implementation layers with handlers and error handling
   ```ts
   const MyCommandLive = Command.makeLayer(MyCommand).handler(...)
   const MyBotLive = Layer.succeed(MyBot)
     .pipe(Layer.provide(MyCommandLive))
     .pipe(Layer.catchAllDefect(...)) // Error handling on implementation only
   ```

3. **Wire**: Provide the polling/transport layer to the implementation
   ```ts
   const PollingBotLayer = BotLive.makePolling({ token, polling })
   const AppLive = MyBotLive.pipe(Layer.provide(PollingBotLayer))
   ```

**Key principle**: The bot definition and bot implementation are **separate variables**. Error handlers belong only on the implementation layer, not the definition.

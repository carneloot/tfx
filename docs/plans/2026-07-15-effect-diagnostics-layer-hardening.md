# Effect Diagnostics and Application Layer Hardening Implementation Plan

**Goal:** Remove every Effect Language Service warning by replacing native error-channel failures with tagged errors and composing one fully provided production `appLayer`.

**Architecture:** Error-producing boundaries expose tagged errors with stable `_tag` discriminants; demo/test-only failures use tagged fixture errors too. Runtime layers are built in dependency order with `Layer.provide`/`Layer.provideMerge`, while `Layer.mergeAll` combines only independent layers. `Production.appLayer` includes configuration, PostgreSQL, Telegram, repositories, runtimes, and workers with no remaining service requirements.

**Tech Stack:** Effect v4, Effect Language Service, TypeScript 7, Vitest, Bun, PostgreSQL Layers.

---

### Task 1: Tagged error channels

**Files:**
- Modify: `packages/tfx/src/{BotRouter.ts,ConversationInput.ts,ConversationChoice.ts,CallbackData.ts}`
- Modify: `packages/tfx/src/internal/update-source/PollingSource.ts`
- Modify: `packages/postgres/src/internal/Migrator.ts`
- Modify: `apps/carneloot-bot/src/bot/conversations/ConfigureReminderDelayConversation.ts`
- Modify: warning-producing demo/tests

- [x] Add focused tests asserting new error tags and preserved routing/decoding behavior.
- [x] Replace every native `Error`/`TypeError` placed in an Effect error channel with a tagged error.
- [x] Narrow affected public error signatures from `unknown` where concrete tagged unions are available.
- [x] Run focused tfx, postgres, and Carneloot tests.

### Task 2: Fully provided application layer

**Files:**
- Modify: `apps/carneloot-bot/src/Layers.ts`
- Modify: `apps/carneloot-bot/src/Production.ts`
- Modify: `apps/carneloot-bot/src/bin.ts`
- Modify: `apps/carneloot-bot/test/{NodeSmoke.test.ts,Program.test.ts}`

- [x] Add type/runtime tests proving production `appLayer` has `never` requirements and exposes `BotRuntime`, `JobWorker`, and durable `UpdateDeduplicator`.
- [x] Build named dependency layers in topological order; use `provideMerge` only when dependency outputs intentionally remain in the application graph.
- [x] Export `Production.appLayer` with `AppConfig.layer` and all platform dependencies already supplied.
- [x] Make Bun entry provide only `appLayer` to `Program.run`.

### Task 3: Test provider cleanup and diagnostic gate

**Files:**
- Modify: `apps/carneloot-bot/test/pet-food/PetFoodCommands.test.ts`
- Modify: `tsconfig.base.json`

- [x] Replace chained test `Effect.provide` calls with one composed Context/Layer provision.
- [x] Run a clean patched TypeScript build and require zero `TS377` diagnostics.
- [x] Remove warning-exit suppression once diagnostics are clean.
- [x] Run format, lint, check, unit tests, app tests, build, and integration discovery.

### Task 4: Review and commit

- [x] Confirm no `Effect.fail(new Error|TypeError)` remains in handwritten production code.
- [x] Confirm `Production.appLayer` has no environment requirements.
- [x] Commit tagged-error changes and Layer composition changes separately when practical; never amend or push.

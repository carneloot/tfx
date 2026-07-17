# Carneloot and TFX Operational Logging Implementation Plan

**Goal:** Add safe, structured Effect logs across TFX runtime boundaries and Carneloot production workflows.

**Architecture:** Emit named events with `Effect.log*` and attach searchable metadata through `Effect.annotateLogs`. TFX owns generic source, dispatch, polling, and job lifecycle logs; Carneloot owns process, migration, worker recovery, and reminder-delivery logs. Payloads, Telegram tokens, message text, chat/user IDs, raw errors, and claim tokens stay excluded.

**Tech Stack:** TypeScript, Effect 4, Bun, Vitest

---

### Task 1: Log TFX bot and polling lifecycle

**Files:**
- Modify: `packages/tfx/src/BotRuntime.ts`
- Modify: `packages/tfx/src/Telegram.ts`
- Modify: `packages/tfx/src/internal/runtime/Dispatcher.ts`
- Modify: `packages/tfx/src/internal/update-source/PollingSource.ts`
- Test: `packages/tfx/test/BotRuntime.test.ts`
- Test: `packages/tfx/test/Polling.test.ts`

- [ ] Add source startup/completion/failure logs carrying only bot, capacity, concurrency, and safe error tags.
- [ ] Add payload-free Telegram request completion/failure logs carrying method and sanitized reason.
- [ ] Add one dispatch-completion log carrying bot ID, update ID, and outcome tag.
- [ ] Add polling-ready, retry, received-batch, acknowledged-batch, and fatal-dispatch logs without Telegram payloads.
- [ ] Run focused tests:

```bash
pnpm vitest run packages/tfx/test/BotRuntime.test.ts packages/tfx/test/Polling.test.ts
```

Expected: all focused tests pass.

### Task 2: Log TFX job lifecycle

**Files:**
- Modify: `packages/tfx/src/JobRuntime.ts`
- Test: `packages/tfx/test/JobRuntime.test.ts`

- [ ] Log scheduling with job ID/name and replacement boolean, excluding payload and conflict key.
- [ ] Log claimed/running jobs with ID/name/attempt.
- [ ] Log returned status at correct severity: completed/cancelled info, scheduled retry warning, failed/quarantined error, running lease-loss warning.
- [ ] Run focused tests:

```bash
pnpm vitest run packages/tfx/test/JobRuntime.test.ts
```

Expected: all job runtime tests pass.

### Task 3: Log Carneloot process and infrastructure lifecycle

**Files:**
- Modify: `apps/carneloot-bot/src/Program.ts`
- Modify: `apps/carneloot-bot/src/JobWorker.ts`
- Modify: `apps/carneloot-bot/src/postgres/AppMigrator.ts`
- Test: `apps/carneloot-bot/test/Program.test.ts`
- Test: `apps/carneloot-bot/test/JobWorker.test.ts`

- [ ] Log application startup/shutdown and retained bot/worker completion/failure.
- [ ] Log worker recovery/problem counts, preserving existing problem IDs warning.
- [ ] Log migration start, each applied migration identity, and completion counts; exclude SQL and connection details.
- [ ] Run focused tests:

```bash
pnpm vitest run apps/carneloot-bot/test/Program.test.ts apps/carneloot-bot/test/JobWorker.test.ts
```

Expected: all focused tests pass.

### Task 4: Log Carneloot reminder delivery outcomes

**Files:**
- Modify: `apps/carneloot-bot/src/application/DispatchNotificationDelivery.ts`
- Test: `apps/carneloot-bot/test/notifications/DispatchNotificationDelivery.test.ts`

- [ ] Log ignored/cancelled delivery reasons with event and pet identity.
- [ ] Log each claimed delivery attempt without chat ID or rendered message.
- [ ] Log sent, retryable, permanent, and unknown Telegram outcomes using sanitized reason tags/codes.
- [ ] Log event completion or remaining-active retry state.
- [ ] Run focused test:

```bash
pnpm vitest run apps/carneloot-bot/test/notifications/DispatchNotificationDelivery.test.ts
```

Expected: all delivery tests pass.

### Task 5: Verify repository

**Files:**
- Verify all modified files.

- [ ] Format and lint:

```bash
pnpm format && pnpm lint
```

Expected: both commands exit 0.

- [ ] Typecheck and unit test:

```bash
pnpm check && pnpm test:unit
```

Expected: both commands exit 0.

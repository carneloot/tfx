# Slice 1 Private Testing Infrastructure Implementation Plan

**Goal:** Establish one non-exported test harness for Telegram/update scenarios and reusable conversation, job, and deduplicator conformance contracts.

**Architecture:** Core-private fixtures depend only on public tfx contracts and drive memory/third-party implementations. PostgreSQL-private utilities provide disposable real database Layers and run same conformance functions without entering production package dependencies or exports.

**Tech Stack:** Vitest, Effect TestClock/Layer/Queue/Deferred, Testcontainers PostgreSQL.

---

## File map

- Create: `packages/tfx/test/internal/{FakeTelegram.ts,RecordedRequests.ts,UpdateFixtures.ts,InMemoryDelivery.ts,TestBot.ts}`
- Create: `packages/tfx/test/internal/{ConversationScenario.ts,ConversationStorageConformance.ts,JobStoreConformance.ts,DeduplicatorConformance.ts}`
- Create: `packages/tfx/test/internal/internal.test.ts`
- Create: `packages/postgres/test/internal/{PostgresTestLayer.ts,MigrateTestDatabase.ts,ResetTestDatabase.ts}`
- Create: `packages/postgres/test/internal/internal.test.ts`
- Create: `packages/tfx/test/package-exports.test.ts`, `packages/postgres/test/package-exports.test.ts`
- Modify: root/package test configuration and package dev dependencies only

### Task 1: Fake Telegram and request recorder

- [ ] **Step 1: Write failing recorder tests**

Assert FIFO requests, method-specific lookup, request count, redacted token absence, scripted success/error/malformed responses, and unconsumed-script failure.

- [ ] **Step 2: Implement private fake Layer**

`FakeTelegram.layer(script)` provides public `Telegram.Telegram`; each call records `{method,input}` and consumes one matching scripted result. Helpers expose Effects, not mutable globals.

```ts
const layer = FakeTelegram.layer([
  FakeTelegram.succeed("sendMessage", messageFixture({ message_id: 10 }))
])
const requests = yield* RecordedRequests.RecordedRequests
```

- [ ] **Step 3: Run and commit**

Run: `pnpm --filter tfx test -- test/internal/internal.test.ts`
Expected: PASS.

```bash
git add packages/tfx/test/internal/FakeTelegram.ts packages/tfx/test/internal/RecordedRequests.ts packages/tfx/test/internal/internal.test.ts
git commit -m "test(tfx): add private Telegram recorder"
```

### Task 2: Update fixtures, in-memory delivery, and TestBot

- [ ] **Step 1: Write fixture decoding tests**

Builders create schema-valid message command/text, callback, reaction, inline, channel, and business updates with deterministic IDs/timestamps. Commands include correct `bot_command` entity.

- [ ] **Step 2: Implement controlled delivery**

`InMemoryDelivery.make()` returns one `UpdateDelivery` plus `offer`, `awaitOutcome`, `close`. Capacity/backpressure and completion signals mirror runtime source boundary.

- [ ] **Step 3: Implement private TestBot runner**

Compose declaration, implementation Layers, fake Telegram, in-memory delivery, explicit memory storage/dedup Layers, and TestClock. API: `send(update)`, `requests`, `advance(duration)`, `shutdown`.

- [ ] **Step 4: Verify ordering scenario**

Offer two same-chat and two other-chat updates; assert same-chat FIFO and unrelated overlap using latches.

- [ ] **Step 5: Commit**

```bash
git add packages/tfx/test/internal/UpdateFixtures.ts packages/tfx/test/internal/InMemoryDelivery.ts packages/tfx/test/internal/TestBot.ts packages/tfx/test/internal/internal.test.ts
git commit -m "test(tfx): add private update harness"
```

### Task 3: Conversation scenario runner

- [ ] **Step 1: Write scenario DSL test**

```ts
await ConversationScenario.run(AddPet, {
  start: command("adicionar_pet"),
  steps: [text("Rex")],
  expectRequests: [sendMessage("Qual o nome do seu pet?"), sendMessage("Pet cadastrado com sucesso!")]
})
```

Support restart between inputs, invalid input, duplicate update, interrupt, cancellation, TestClock timeout, and post-commit output failure.

- [ ] **Step 2: Implement using TestBot only**

No direct engine internals. Persistence assertions query `ConversationStorage` public contract.

- [ ] **Step 3: Run and commit**

Run: `pnpm --filter tfx test -- test/internal/internal.test.ts`
Expected: all scenario modes PASS.

```bash
git add packages/tfx/test/internal/ConversationScenario.ts packages/tfx/test/internal/internal.test.ts
git commit -m "test(tfx): add conversation scenarios"
```

### Task 4: Storage conformance suites

- [ ] **Step 1: Define implementation factories**

Each suite accepts scoped Layer factory and optional capabilities (`durableRestart`, `multiProcess`). Cases carry unique namespace and clean state.

- [ ] **Step 2: Implement conversation conformance**

Cover create/load, conflict replace/fail, CAS, same-update replay, expiration, migration, complete/cancel, serialized different updates, rollback-capable adapter hook, and scope identity.

- [ ] **Step 3: Implement job conformance**

Cover schedule/conflict replacement, due claim, two-phase migration claim attempt accounting, migration reclaim, promotion, heartbeat/takeover, stale fences, outcomes/retry/exhaustion, cancel, quarantine/release.

- [ ] **Step 4: Implement dedup conformance**

Cover acquired/completed/in-progress, bounded wait, heartbeat, expiry takeover, stale complete/release, retention, diagnostics.

- [ ] **Step 5: Run suites against memory Layers**

Run: `pnpm --filter tfx test -- test/internal/internal.test.ts`
Expected: every required core conformance case PASS; SQL-only capability cases skip with explicit capability reason.

- [ ] **Step 6: Commit**

```bash
git add packages/tfx/test/internal/*Conformance.ts packages/tfx/test/internal/internal.test.ts
git commit -m "test(tfx): define storage conformance suites"
```

### Task 5: PostgreSQL test Layer and export guard

- [ ] **Step 1: Add scoped container/client fixture**

Use `PostgreSqlContainer("postgres:17-alpine")`, `PgClient.layer({url:Redacted.make(uri)})`, migration setup, and per-test schema reset. Allow `TEST_DATABASE_URL` to bypass Docker in CI.

- [ ] **Step 2: Add export-negative tests**

Pack each package and inspect tarball/exports. Assert `test/internal` absent and imports `tfx/test/internal/*`, `@tfx/postgres/test/internal/*` fail.

- [ ] **Step 3: Validate both runtimes**

Run: `pnpm --filter tfx test && pnpm --filter @tfx/postgres test -- test/internal/internal.test.ts`
Expected: PASS with one disposable PostgreSQL.

Run: `bun x vitest run packages/tfx/test/internal/internal.test.ts packages/postgres/test/internal/internal.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/postgres/test/internal packages/*/test/package-exports.test.ts package.json pnpm-lock.yaml
git commit -m "test: add private PostgreSQL harness"
```

## Acceptance criteria

- One private harness serves Slices 1–3; no parallel public testing package exists.
- Harness drives public APIs rather than source internals except internal delivery fixture boundary inside same package.
- Conformance suites pass memory implementations before PostgreSQL adapters use them.
- Test helpers and Testcontainers never appear in production exports/dependencies.
- Node and Bun execute core harness; real PostgreSQL fixture is reusable.

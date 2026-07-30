# Slice 3 Operations, UUID Crypto, and Tracing Implementation Plan

**Goal:** Remove handwritten production UUID globals, supply runtime Crypto layers, establish named Effect workflow boundaries, and run traced scoped production deployment on Bun and Node test edges.

**Architecture:** Domain/application code depends only on `effect/Crypto.Crypto`; runtime composition provides `BunCrypto.layer` in Bun production and `NodeCrypto.layer` in Node smoke/test composition. Tests inject counter-based deterministic Crypto. Keep one scoped `Program.fromLayer` lifetime for server, source, pool, jobs, and telemetry; add spans without secrets or raw message bodies.

**Tech Stack:** Effect v4 Crypto/Tracing/OTLP, `@effect/platform-bun`, `@effect/platform-node`, Vitest.

---

## File map

- Modify: every handwritten production TypeScript UUID caller under `apps/carneloot-bot/src`, including `application/AddFood.ts`, `application/DispatchNotificationDelivery.ts`, new external-notification/API-key workflows, `postgres/FoodNotificationSchedulerLive.ts`, `postgres/ReminderSchedulerLive.ts`, and `postgres/UserRepositoryLive.ts` — injected UUIDv4 use.
- Create: `test/internal/DeterministicCrypto.ts` — counter-based Crypto fake used by tests.
- Modify: affected unit/integration tests and app test layers — provide fake Crypto deliberately.
- Modify: `Production.ts`, Bun entrypoint, Node smoke composition — runtime-edge Bun/Node Crypto layers.
- Create: `src/Observability.ts` — Carneloot production OTLP layer; retain importer-specific resource module.
- Modify: `Program.ts`, router/application public workflows, `packages/tfx/src/Telegram.ts`, and generated Telegram client request boundary under `packages/tfx/src/internal/telegram/generated/` — `Effect.fn` boundaries and spans.
- Create: `test/Observability.test.ts`; modify `test/Program.test.ts`, `type-test/Production.tst.ts`, `test/NodeSmoke.test.ts`.

### Task 1: Make direct UUID usage mechanically impossible in production modules

**Files:**
- Modify: `apps/carneloot-bot/src/application/AddFood.ts`
- Modify: `apps/carneloot-bot/src/application/DispatchNotificationDelivery.ts`
- Modify: `apps/carneloot-bot/src/postgres/FoodNotificationSchedulerLive.ts`
- Modify: `apps/carneloot-bot/src/postgres/ReminderSchedulerLive.ts`
- Modify: `apps/carneloot-bot/src/postgres/UserRepositoryLive.ts`
- Create: `apps/carneloot-bot/test/internal/DeterministicCrypto.ts`
- Test: focused existing tests listed below

- [ ] **Step 1: Add failing deterministic-ID tests**

Provide test Crypto that returns valid UUIDv4 strings in counter order and assert created food, events, deliveries, jobs, reminders, and registered user rows use expected IDs. Cover `FoodMutations.integration.test.ts`, `FoodAddedNotification.test.ts`, `DispatchNotificationDelivery.test.ts`, `FeedingReminderScheduling.integration.test.ts`, and `IdentityPets.integration.test.ts`.

- [ ] **Step 2: Run focused tests**

Run: `pnpm exec vitest run apps/carneloot-bot/test/pet-food/FoodMutations.integration.test.ts apps/carneloot-bot/test/notifications/DispatchNotificationDelivery.test.ts apps/carneloot-bot/test/IdentityPets.integration.test.ts`

Expected: FAIL after test asserts injected IDs because code reads global `crypto.randomUUID()`.

- [ ] **Step 3: Implement counter fake and replace all calls**

Test helper supplies `Crypto.Crypto` with counter UUIDs whose version nibble is `4` and variant nibble is `8`. Apply it to new external event, payload, delivery, and API-key ID tests as well as existing flows:

```ts
export const layer = (start = 1) => {
  let counter = start;
  return Layer.succeed(Crypto.Crypto, {
    randomUUIDv4: Effect.sync(() => `00000000-0000-4000-8000-${counter++.toString(16).padStart(12, '0')}`),
  });
};
```

At each production call site, bind service then effect:

```ts
const crypto = yield* Crypto.Crypto;
const id = Schema.decodeUnknownSync(DeliveryId)(yield* crypto.randomUUIDv4);
```

Preserve each existing branded-schema decode. Do not call `globalThis.crypto`, Node `crypto`, or Bun crypto in handwritten production source.

- [ ] **Step 4: Enforce no direct UUID globals**

Run:

```bash
! rg -i --glob '*.ts' '(globalThis\.)?crypto\.randomUUID\(|\brandomUUID\(' apps/carneloot-bot/src
pnpm exec vitest run apps/carneloot-bot/test/pet-food/FoodMutations.integration.test.ts apps/carneloot-bot/test/notifications/DispatchNotificationDelivery.test.ts apps/carneloot-bot/test/notifications/SendExternalNotification.test.ts apps/carneloot-bot/test/ApiKeyHandlers.test.ts apps/carneloot-bot/test/IdentityPets.integration.test.ts
```

Expected: exit 0; tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/carneloot-bot/src/application apps/carneloot-bot/src/postgres apps/carneloot-bot/test
git commit -m "refactor(carneloot): inject uuid crypto"
```

### Task 2: Provide Crypto only at runtime edges

**Files:**
- Modify: `apps/carneloot-bot/src/Production.ts`, `src/bin.ts`
- Modify: Node smoke/test layer fixture files identified by `test/NodeSmoke.test.ts`
- Test: `apps/carneloot-bot/type-test/Production.tst.ts`, `test/NodeSmoke.test.ts`

- [ ] **Step 1: Write failing composition tests**

Assert Bun `appLayer` type closes Crypto requirement through `BunCrypto.layer`; Node smoke composition closes it through `NodeCrypto.layer`; portable application/domain layers still expose Crypto requirement until a runtime/test provider supplies it.

- [ ] **Step 2: Run tests**

Run: `pnpm exec vitest run apps/carneloot-bot/test/NodeSmoke.test.ts && pnpm --filter carneloot-bot check`

Expected: FAIL due to unresolved `Crypto.Crypto` after Task 1.

- [ ] **Step 3: Supply platform layers at edges**

Add `BunCrypto.layer` to Bun production infrastructure next to `BunHttpClient.layer`. Add `NodeCrypto.layer` only to Node runtime smoke/test graph. Keep deterministic fake in tests that assert values. Do not supply Crypto inside a domain repository/application Layer.

- [ ] **Step 4: Run checks under both runtimes**

Run:

```bash
pnpm exec vitest run apps/carneloot-bot/test/NodeSmoke.test.ts
bun x vitest run apps/carneloot-bot/test/NodeSmoke.test.ts
pnpm --filter carneloot-bot check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/carneloot-bot/src/Production.ts apps/carneloot-bot/src/bin.ts apps/carneloot-bot/test apps/carneloot-bot/type-test
git commit -m "feat(carneloot): provide runtime crypto layers"
```

### Task 3: Name workflow boundaries and add safe spans

**Files:**
- Modify: `apps/carneloot-bot/src/Program.ts`, `src/Router.ts`, new Slice 3 application modules
- Test: `apps/carneloot-bot/test/Program.test.ts`, relevant handler/application tests

- [ ] **Step 1: Write failing span/boundary tests**

Use tracer/test span collector to assert spans for update dispatch, command handler, notification send, SQL transaction, job execution, and generated Telegram client calls (`sendMessage`, `setWebhook`, `deleteWebhook`, `getWebhookInfo`, `setMyCommands`). Assert annotations exclude bot token, API key, webhook secret, raw message text, rendered notification body, authorization header, and token-bearing URL.

- [ ] **Step 2: Run tests**

Run: `pnpm exec vitest run apps/carneloot-bot/test/Program.test.ts apps/carneloot-bot/test/Observability.test.ts`

Expected: FAIL because production observability and complete boundary naming are absent.

- [ ] **Step 3: Inventory and name every public/non-trivial workflow**

First add a test-maintained inventory covering exported application functions, bot handlers/conversations, schedulers, import workflows, repositories with ordered transaction logic, TFX webhook/polling dispatch boundaries, and generated Telegram API operations. Wrap every public or non-trivial workflow found by inventory with `Effect.fn('Module.operation')`; retain existing `DispatchNotificationDelivery.execute` name. At single generated-client request boundary, add `Effect.withSpan('Telegram.<method>')` for every generated operation, rather than duplicating spans in each handler/proxy. Add spans around update receipt/dedup, middleware/command dispatch, SQL transaction boundaries, and job execution. Telegram span annotations contain only method name plus safe IDs (bot/chat/message/update when present); never raw request/response payload, token, authorization header, API key, secret, or URL.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run apps/carneloot-bot/test/Program.test.ts apps/carneloot-bot/test/Observability.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/carneloot-bot/src apps/carneloot-bot/test/Program.test.ts apps/carneloot-bot/test/Observability.test.ts
git commit -m "feat(carneloot): trace application workflows"
```

### Task 4: Compose production telemetry and validate lifecycle

**Files:**
- Create: `apps/carneloot-bot/src/Observability.ts`
- Modify: `apps/carneloot-bot/src/Production.ts`, `src/Program.ts`, `src/bin.ts`
- Test: `apps/carneloot-bot/test/Observability.test.ts`, `test/Program.test.ts`, `test/NodeSmoke.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Assert default OTLP trace/log endpoint config follows importer pattern but resource service is `carneloot-bot`, not importer resource. Assert scoped program acquires/release server, update source, PostgreSQL pool, job worker, telemetry reverse-order on interruption. Assert `Program.run` logs sanitized start/stop and preserves durable-dedup guard.

- [ ] **Step 2: Run tests**

Run: `pnpm exec vitest run apps/carneloot-bot/test/Observability.test.ts apps/carneloot-bot/test/Program.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `Observability.layer` and composition**

Adapt importer `Observability.ts`: read OTLP URLs with safe defaults, merge `OtlpTracer.layer` and `OtlpLogger.layer`, provide JSON serialization and fetch HTTP client, use resource `{ serviceName: 'carneloot-bot' }`. Add layer at production edge only. Keep `Program.fromLayer` as one `Effect.scoped` owner; do not create detached server/job fibers or eager setup effects.

- [ ] **Step 4: Run release validations**

Run:

```bash
pnpm exec vitest run apps/carneloot-bot/test/Observability.test.ts apps/carneloot-bot/test/Program.test.ts apps/carneloot-bot/test/NodeSmoke.test.ts
pnpm --filter carneloot-bot check
pnpm check
pnpm test:unit
RUN_TESTCONTAINERS=true pnpm test:integration
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/carneloot-bot/src/{Observability.ts,Production.ts,Program.ts,bin.ts} apps/carneloot-bot/test apps/carneloot-bot/type-test
git commit -m "feat(carneloot): add production telemetry lifecycle"
```

## Final verification

```bash
! rg -i --glob '*.ts' '(globalThis\.)?crypto\.randomUUID\(|\brandomUUID\(' apps/carneloot-bot/src
pnpm check
pnpm test:unit
RUN_TESTCONTAINERS=true pnpm test:integration
```

# RequestResolver Settings Batching Implementation Plan

**Goal:** Batch concurrent per-pet settings reads into one PostgreSQL query while preserving `PetFoodRepository.getSettings` semantics.

**Architecture:** Add a request type and `RequestResolver` inside `PetFoodRepositoryLive` so all `getSettings(petId)` calls use Effect request batching. In `GetFoodStatus`, authorize first and issue settings reads concurrently; resolver executes one `IN` query and completes missing rows as `undefined`.

**Tech Stack:** TypeScript, Effect v4 `Request`, `RequestResolver`, PostgreSQL via `@effect/sql-pg`, Vitest.

---

### Task 1: Define and test request-batched settings lookup

**Files:**
- Modify: `apps/carneloot-bot/src/postgres/PetFoodRepositoryLive.ts`
- Modify: `apps/carneloot-bot/test/pet-food/PetFood.integration.test.ts`

- [ ] **Step 1: Add a focused integration case**

Exercise `GetFoodStatus` with multiple accessible configured pets and assert configured results. Retain transaction, decoding, missing-settings behavior, and existing settings mutation behavior.

- [ ] **Step 2: Implement resolver-backed `getSettings`**

Define request identity by `PetId`; create resolver once in `PetFoodRepositoryLive.layer`; use one `pet_id IN (...)` SQL read per collected batch; complete every request with decoded setting or `undefined`; propagate database and decode errors to every affected request.

- [ ] **Step 3: Run focused test**

Run: `RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts apps/carneloot-bot/test/pet-food/PetFood.integration.test.ts`

Expected: PASS.

### Task 2: Expose concurrent lookup opportunity in status workflow

**Files:**
- Modify: `apps/carneloot-bot/src/application/GetFoodStatus.ts`
- Modify: `apps/carneloot-bot/test/pet-food/PetFoodCommands.test.ts`

- [ ] **Step 1: Keep authorization ordered, batch reads concurrently**

Authorize each accessible pet before lookup. Then use `Effect.forEach(..., { concurrency: 'unbounded' })` for settings reads so resolver can collect requests. Preserve result order and status output.

- [ ] **Step 2: Run focused unit and integration tests**

Run: `pnpm exec vitest run apps/carneloot-bot/test/pet-food/PetFoodCommands.test.ts`

Run: `RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts apps/carneloot-bot/test/pet-food/PetFood.integration.test.ts`

Expected: PASS.

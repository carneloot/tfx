# Slice 2 Food Correction and Deletion Implementation Plan

**Goal:** Deliver `/corrigir_racao` and `/deletar_racao` with current-day selection, access rechecks, and correct atomic reminder rescheduling.

**Architecture:** Repository row-lock methods support focused mutation services. A shared `ReconcileFoodReminder` compares latest entry before/after mutation and updates stable `feeding-reminder:<petId>` scheduling inside same PostgreSQL transaction; conversations commit mutation and state together.

**Tech Stack:** tfx conversations/choices, Effect DateTime/Schema, PostgreSQL, TestClock, Vitest.

---

## File map

- Create: `apps/carneloot-bot/src/domain/pet-food/FoodCorrectionInput.ts`
- Create: `apps/carneloot-bot/src/application/ListCurrentFoodEntries.ts`
- Create: `apps/carneloot-bot/src/application/ReconcileFoodReminder.ts`
- Create: `apps/carneloot-bot/src/application/CorrectFood.ts`
- Create: `apps/carneloot-bot/src/application/DeleteFood.ts`
- Create: `apps/carneloot-bot/src/bot/conversations/CorrectFoodConversation.ts`
- Create: `apps/carneloot-bot/src/bot/conversations/DeleteFoodConversation.ts`
- Create: `apps/carneloot-bot/test/pet-food/FoodCorrectionInput.test.ts`
- Create: `apps/carneloot-bot/test/pet-food/FoodMutations.test.ts`
- Create: `apps/carneloot-bot/test/pet-food/FoodMutations.integration.test.ts`
- Create: `apps/carneloot-bot/test/pet-food/FoodMutationCommands.e2e.integration.test.ts`
- Modify: `apps/carneloot-bot/src/domain/pet-food/PetFoodError.ts`
- Modify: `apps/carneloot-bot/src/ports/PetFoodRepository.ts`
- Modify: `apps/carneloot-bot/src/postgres/PetFoodRepositoryLive.ts`
- Modify: `apps/carneloot-bot/src/bot/Declaration.ts`
- Modify: `apps/carneloot-bot/src/bot/PetFoodHandlers.ts`
- Modify: `apps/carneloot-bot/src/Router.ts`
- Modify: `apps/carneloot-bot/src/DomainLive.ts`
- Modify: `apps/carneloot-bot/test/BotLayers.test.ts`
- Modify: `apps/carneloot-bot/test/NodeSmoke.test.ts`
- Modify: `apps/carneloot-bot/test/Router.test.ts`
- Modify: `apps/carneloot-bot/test/pet-food/PetFoodApplication.test.ts`
- Modify: `apps/carneloot-bot/test/pet-food/PetFoodCommands.test.ts`
- Modify: `apps/carneloot-bot/test/notifications/FeedingReminderScheduling.integration.test.ts`

### Task 1: Define correction input and entry projections

- [x] **Step 1: Write failing correction parser tests**

Accept amount-only (`50`, `50g`, `50000mg`, `0.05kg`), time-only (`08:30`, `14/07 08:30`), and amount+time. Reject empty input, malformed amount/date/time, date without time, multiple amounts, and trailing text.

- [x] **Step 2: Implement pure correction parser**

Expose:

```ts
export interface FoodCorrection {
  readonly amountMg?: FoodAmount
  readonly when?: string
}
export const parse: (
  input: string
) => Effect.Effect<FoodCorrection, InvalidDomainInput>
```

Parser first recognizes supported time-only forms; otherwise splits first amount token and validates optional remainder through `FoodWhenInput`. At least one field is required. It does not interpret timezone.

- [x] **Step 3: Define current-day display projection**

`ListCurrentFoodEntries` returns:

```ts
export interface DisplayFoodEntry {
  readonly entry: PetFoodEntry
  readonly actorDisplay: string
  readonly localTimestamp: string
}
```

Projection sorts `fedAt DESC, id`, formats in pet timezone, and loads actor display without exposing private Telegram fields.

- [x] **Step 4: Run pure tests**

Run: `pnpm --filter carneloot-bot test -- FoodCorrectionInput.test.ts`
Expected: PASS for amount-only, time-only, combined, and malformed cases.

- [x] **Step 5: Commit input model**

```bash
git add apps/carneloot-bot/src/domain/pet-food/FoodCorrectionInput.ts apps/carneloot-bot/src/application/ListCurrentFoodEntries.ts apps/carneloot-bot/test/pet-food/FoodCorrectionInput.test.ts
git commit -m "feat(carneloot): model food correction input"
```

### Task 2: Add lock-safe food repository operations

- [x] **Step 1: Write failing PostgreSQL repository tests**

Cover current-day half-open range, deterministic order, lock/find by ID+pet, update preserving source/creator timestamps, delete returning prior row, duplicate exclusion of row being corrected, and concurrent update/delete serialization.

- [x] **Step 2: Extend repository contract**

Add:

```ts
readonly listEntries: (
  petId: PetId,
  start: DateTime.Utc,
  end: DateTime.Utc
) => Effect.Effect<ReadonlyArray<PetFoodEntry>, PetFoodRepositoryError>
readonly lockEntry: (
  petId: PetId,
  entryId: FoodEntryId
) => Effect.Effect<PetFoodEntry | undefined, PetFoodRepositoryError>
readonly findBusinessDuplicateExcluding: (
  petId: PetId,
  fedAt: DateTime.Utc,
  excludedEntryId: FoodEntryId
) => Effect.Effect<PetFoodEntry | undefined, PetFoodRepositoryError>
readonly updateEntry: (
  entryId: FoodEntryId,
  amountMg: FoodAmount,
  fedAt: DateTime.Utc,
  now: DateTime.Utc
) => Effect.Effect<PetFoodEntry | undefined, PetFoodRepositoryError>
readonly deleteEntry: (
  entryId: FoodEntryId
) => Effect.Effect<PetFoodEntry | undefined, PetFoodRepositoryError>
```

- [x] **Step 3: Implement parameterized SQL**

`lockEntry` uses pet+entry predicates and `FOR UPDATE`. `listEntries` uses `fed_at >= start AND fed_at < end`. Update changes only `amount_mg`, `fed_at`, and `updated_at`; source fields and `created_at` remain immutable.

- [x] **Step 4: Run repository tests**

Run: `pnpm --filter carneloot-bot test:integration -- FoodMutations.integration.test.ts -t "repository"`
Expected: PASS with row locking and immutable provenance.

- [x] **Step 5: Commit repository methods**

```bash
git add apps/carneloot-bot/src/ports/PetFoodRepository.ts apps/carneloot-bot/src/postgres/PetFoodRepositoryLive.ts apps/carneloot-bot/test/pet-food/FoodMutations.integration.test.ts
git commit -m "feat(carneloot): add food mutation persistence"
```

### Task 3: Centralize reminder reconciliation

- [x] **Step 1: Write failing reconciliation tests**

Cover unchanged latest; latest timestamp changed; backdated row changed but remains non-latest; backdated row becomes latest; latest moves behind previous row; latest deletion exposes previous row; final deletion; reminders disabled; scheduler failure rollback.

- [x] **Step 2: Implement reconciliation contract**

```ts
export interface LatestSnapshot {
  readonly id: FoodEntryId
  readonly fedAt: DateTime.Utc
}
export interface ReconcileFoodReminderRequest {
  readonly botId: BotId
  readonly ownerUserId: UserId
  readonly petId: PetId
  readonly before: LatestSnapshot | undefined
}
```

Export `reconcile(request: ReconcileFoodReminderRequest)`. Inside ambient transaction, reload latest after mutation and settings. If latest identity/time equals `before`, do nothing. If no latest or delay is null, call `cancelForPet`. Otherwise call `replaceForLatest` with `latest.fedAt + reminderDelay`. Stable conflict key replaces prior schedule.

- [x] **Step 3: Run reconciliation tests**

Run: `pnpm --filter carneloot-bot test -- FoodMutations.test.ts -t "reminder reconciliation"`
Expected: PASS for all latest/non-latest transitions.

- [x] **Step 4: Run durable scheduler integration**

Run: `pnpm --filter carneloot-bot test:integration -- FeedingReminderScheduling.integration.test.ts FoodMutations.integration.test.ts -t "reminder"`
Expected: one active reminder per pet, prior job cancelled, rollback on scheduler failure.

- [x] **Step 5: Commit reconciliation**

```bash
git add apps/carneloot-bot/src/application/ReconcileFoodReminder.ts apps/carneloot-bot/test/pet-food/FoodMutations.test.ts apps/carneloot-bot/test/notifications/FeedingReminderScheduling.integration.test.ts
git commit -m "fix(carneloot): reconcile reminders after food mutation"
```

### Task 4: Implement correction and deletion services

- [x] **Step 1: Write failing application tests**

Cover owner/caregiver success, pending/rejected denial, missing/deleted entry, current-day enforcement, amount-only/time-only correction, duplicate corrected timestamp, access revocation, and scheduler failure rollback.

- [x] **Step 2: Implement `CorrectFood.execute`**

Within one transaction:

1. resolve current identity and lock authorized pet;
2. capture current latest snapshot;
3. lock selected entry by pet;
4. compute current pet-day bounds and reject entry outside range;
5. parse correction; retain omitted amount/time;
6. interpret supplied time in pet timezone using current correction message's Telegram instant, not processing clock;
7. reject another entry within `< 60_000ms` while excluding selected row;
8. update row;
9. reconcile reminder;
10. return updated row and timezone.

- [x] **Step 3: Implement `DeleteFood.execute`**

Use same authorization/day/lock sequence, delete selected entry, reconcile from remaining latest entry, and return deleted row. Missing entry produces non-leaking `FoodEntryNotFound`.

- [x] **Step 4: Run application and SQL tests**

Run: `pnpm --filter carneloot-bot test -- FoodMutations.test.ts`
Expected: PASS.

Run: `pnpm --filter carneloot-bot test:integration -- FoodMutations.integration.test.ts`
Expected: PASS with transaction rollback and durable reminder replacement.

- [x] **Step 5: Commit services**

```bash
git add apps/carneloot-bot/src/application apps/carneloot-bot/src/domain/pet-food/PetFoodError.ts apps/carneloot-bot/test/pet-food/FoodMutations*.test.ts
git commit -m "feat(carneloot): correct and delete food safely"
```

### Task 5: Add command declarations and conversations

- [x] **Step 1: Add failing exhaustive-builder fixture**

Declare IDs before bindings and run `BotLayers.test.ts`; expect missing implementations.

- [x] **Step 2: Declare commands**

```text
correctFood → corrigir_racao → Corrigir um registro de ração
deleteFood  → deletar_racao  → Deletar um registro de ração
```

Both use `RegisteredUser`, no command arguments, and `ApplicationError`.

- [x] **Step 3: Implement correction conversation**

ID `correct-pet-food`, version `1`, steps `pet`, `entry`, `correction`. Accessible-pet choice rechecks access. Entry options show amount, localized timestamp, and actor; add `Cancelar`. Empty day replies `Não há registros de ração hoje para este pet.`. Correction handler passes current `MessageContext.message.date` as parsing anchor. Success: `Ração alterada com sucesso!`.

- [x] **Step 4: Implement deletion conversation**

ID `delete-pet-food`, version `1`, steps `pet`, `entry`. Use same entry projection and `Cancelar`. Success: `Ração deletada com sucesso!`.

- [x] **Step 5: Bind router and errors**

Add handlers, built conversations, `FoodEntryNotFound`/correction input classification, command-menu expectations, and package type tests. Mutations occur inside storage-controlled transition transaction; success output stays in `afterCommit`.

- [x] **Step 6: Run command tests**

Run: `pnpm --filter carneloot-bot test -- PetFoodCommands.test.ts BotLayers.test.ts Router.test.ts NodeSmoke.test.ts`
Expected: PASS for empty/cancel/invalid/restart/output-failure flows.

- [x] **Step 7: Commit commands**

```bash
git add apps/carneloot-bot/src/bot apps/carneloot-bot/src/Router.ts apps/carneloot-bot/test
git commit -m "feat(carneloot): add food correction and deletion commands"
```

### Task 6: Prove correction/deletion end to end

- [x] **Step 1: Add correction/deletion update scenario**

With real PostgreSQL: create previous/latest/backdated entries; correct latest time; move latest behind previous; delete resulting latest; delete final entry. Assert exact active reminder target/run time after each update.

- [x] **Step 2: Add duplicate/revocation/replay scenario**

Reject corrected business duplicate, revoke caregiver between entry rendering and input, and redeliver final update. Assert no unauthorized write and one mutation on replay.

- [x] **Step 3: Run E2E and package gates**

Run: `pnpm --filter carneloot-bot test:integration -- FoodMutationCommands.e2e.integration.test.ts FoodMutations.integration.test.ts`
Expected: PASS.

Run: `pnpm format && pnpm lint && pnpm --filter carneloot-bot check && pnpm --filter carneloot-bot test`
Expected: PASS.

- [x] **Step 4: Commit proof**

```bash
git add apps/carneloot-bot/test/pet-food/FoodMutationCommands.e2e.integration.test.ts apps/carneloot-bot/src/DomainLive.ts
git commit -m "test(carneloot): prove corrected reminder rescheduling"
```

## Acceptance criteria

- Both commands work for owner and currently accepted caregiver.
- Current-day options use pet-local day boundary and actor display.
- Correction supports amount, time, or both and preserves immutable source identity.
- Latest correction replaces reminder schedule.
- Latest deletion schedules from previous latest entry; final deletion cancels reminder.
- Backdated mutation does not disturb unchanged latest reminder.
- Mutation, reminder change, and conversation transition roll back together.

# Slice 1 Owned-Pet Food Commands Implementation Plan

**Goal:** Deliver owned-pet day-start/reminder-delay configuration, food status, and food insertion workflows with timezone-correct integer-milligram persistence.

**Architecture:** Pure codecs/date calculations feed transactional application services. Conversations select only owned/access-checked pets and recheck authorization at mutation time. `ReminderScheduler` is a port used inside same ambient PgClient transaction; Plan 11 supplies durable event/job implementation.

**Tech Stack:** tfx conversations/keyboards, Effect Schema/DateTime/Duration, PostgreSQL timestamptz/time, TestClock.

---

## File map

- Create: `apps/carneloot-bot/migrations/0002_pet_food.sql`
- Create: `apps/carneloot-bot/src/domain/pet-food/{FoodAmount.ts,FoodDateTime.ts,DayBoundary.ts,PetFood.ts,PetFoodError.ts}`
- Create: `apps/carneloot-bot/src/ports/{PetFoodRepository.ts,ReminderScheduler.ts}`
- Create: `apps/carneloot-bot/src/postgres/PetFoodRepositoryLive.ts`
- Create: `apps/carneloot-bot/src/application/{ConfigureDayStart.ts,ConfigureReminderDelay.ts,GetFoodStatus.ts,AddFood.ts}`
- Create: `apps/carneloot-bot/src/bot/conversations/{ConfigureDayStartConversation.ts,ConfigureReminderDelayConversation.ts,AddFoodConversation.ts}`
- Create: `apps/carneloot-bot/src/bot/PetFoodHandlers.ts`
- Create: `apps/carneloot-bot/test/pet-food/{FoodAmount.test.ts,FoodDateTime.test.ts,DayBoundary.test.ts,PetFood.integration.test.ts,PetFood.e2e.test.ts}`

### Task 1: Food schema and pure codecs

- [ ] **Step 1: Write parser/date tests**

Accept `50`, `50g`, `50000mg`, `0.05kg`; reject zero/negative, unknown units, fractional milligram, NaN/infinity, and over 100kg. Parse optional `HH:mm`, `DD/MM HH:mm`, `DD-MM HH:mm`, and four-digit-year forms using injected `Clock` and Effect `DateTime` only—never `new Date` or host timezone. For yearless day/month, choose the earliest valid local calendar date on or after the injected current zoned local date (current year, otherwise next year), including today even when the supplied clock time has passed; reject when that date is more than 366 local calendar days ahead. Reject nonexistent DST local time and resolve repeated time with the earlier offset. Test Dec→Jan rollover, leap-day valid/invalid years, DST gap, repeated offset, and TestClock-controlled current date.

- [ ] **Step 2: Add migration**

Migration uses fixed qualified application schema established in Plan 9:

```text
carneloot.pet_food_settings(pet_id uuid primary key references carneloot.pets on delete cascade, day_start time null, timezone text null, reminder_delay_ms bigint null, created_at timestamptz not null, updated_at timestamptz not null)
carneloot.pet_food_entries(id uuid primary key, pet_id uuid not null references carneloot.pets on delete cascade, recorded_by uuid not null references carneloot.users, amount_mg bigint not null check(amount_mg > 0), fed_at timestamptz not null, source_bot_id text not null, source_update_id bigint not null, source_message_chat_id bigint null, source_message_id bigint null, created_at timestamptz not null, updated_at timestamptz not null, unique(source_bot_id,source_update_id,pet_id))
```

Require day_start and timezone both null or both non-null. Delay null means reminders disabled; otherwise positive and at most 30 days.

- [ ] **Step 3: Implement pure domain modules**

Normalize amount to integer milligrams. `DayBoundary.current(now,{localTime,timezone})` computes previous/next local boundary then converts to instants, including DST. Validate IANA timezone before persistence.

- [ ] **Step 4: Run and commit**

Run: `pnpm format && pnpm lint && pnpm --filter carneloot-bot test -- FoodAmount.test.ts FoodDateTime.test.ts DayBoundary.test.ts`
Expected: all units/midnight/DST cases PASS.

```bash
git add apps/carneloot-bot/migrations/0002_pet_food.sql apps/carneloot-bot/src/domain/pet-food apps/carneloot-bot/test/pet-food/*.test.ts
git commit -m "feat(carneloot): model pet food and day boundaries"
```

### Task 2: Repository and transactional use cases

- [ ] **Step 1: Write integration failures first**

Test owner-only settings, 00:00 and 23:00, status window, exact mg sums, source replay precedence, business duplicate boundaries at 59,999ms and exactly 60,000ms, latest/backdated detection, no-delay success, concurrent insert locking, and rollback when scheduler fails.

- [ ] **Step 2: Define repository/scheduler ports**

Repository exposes settings, latest entry, insert-if-not-duplicate, and status query. Scheduler operations: `replaceForLatest`, `cancelForPet`, both using the same externally supplied ambient PgClient transaction as repositories. Provide a recording Layer only from test modules; production Layer composition must have no export/path that can select it. Plan 11 replaces it and reruns every scheduler rollback/atomicity case against PostgreSQL JobStore.

- [ ] **Step 3: Implement setting use cases**

Day-start update validates ownership/timezone. Delay set updates setting then, when latest food exists, replaces reminder from `fedAt + delay`; delete clears delay and cancels reminder. All in one PgClient transaction.

- [ ] **Step 4: Implement `AddFood`**

Inside one transaction and pet-scoped row/advisory lock: recheck pet access; require day-start; parse local timestamp. First query the exact `(source_bot_id,source_update_id,pet_id)` key: replay returns the existing successful result and performs no scheduling. Otherwise reject a business duplicate only when absolute timestamp distance is `< 60_000ms` (59,999ms rejects; exactly 60,000ms is allowed), insert, then schedule only when that newly inserted row is latest. Backdated insertion never alters the reminder. Concurrent tests prove source replay/business duplicate races produce one row and one scheduler action. Scheduler failure rolls back insert. Missing delay inserts food and schedules nothing.

- [ ] **Step 5: Implement status**

For each accessible pet, compute current window and return typed projection with total mg/latest instant or missing-day-start marker. Never return an empty-send instruction.

- [ ] **Step 6: Run and commit**

Run: `pnpm format && pnpm lint && pnpm --filter carneloot-bot test -- PetFood.integration.test.ts`
Expected: SQL, transaction, idempotency, latest/backdated cases PASS.

```bash
git add apps/carneloot-bot/src/ports apps/carneloot-bot/src/postgres/PetFoodRepositoryLive.ts apps/carneloot-bot/src/application apps/carneloot-bot/test/pet-food/PetFood.integration.test.ts
git commit -m "feat(carneloot): implement pet food services"
```

### Task 3: Day-start conversation

- [ ] **Step 1: Write E2E transcript**

No owned pets replies `Você não tem pets` and creates no conversation. Otherwise select pet inline, show current value, confirm change, select hour `0h`–`23h`, select/enter validated IANA timezone, save, and reply `Início do dia configurado com sucesso!`. Invalid choice re-prompts `Por favor, escolha uma opção`.

- [ ] **Step 2: Implement state machine**

Steps: `pet`, `confirm`, `hour`, `timezone`; persisted state stores IDs/primitive values only. Recheck ownership in final handler. Midnight is accepted. Cancel removes reply keyboard.

- [ ] **Step 3: Run and commit**

Run: `pnpm format && pnpm lint && pnpm --filter carneloot-bot test -- PetFood.e2e.test.ts -t configurar_inicio_dia`
Expected: empty/midnight/invalid/restart/cancel cases PASS.

```bash
git add apps/carneloot-bot/src/bot/conversations/ConfigureDayStartConversation.ts apps/carneloot-bot/src/bot/PetFoodHandlers.ts apps/carneloot-bot/test/pet-food/PetFood.e2e.test.ts
git commit -m "feat(carneloot): configure pet day start"
```

### Task 4: Reminder-delay conversation

- [ ] **Step 1: Write E2E transcript**

No pets exits. Missing setting offers define; existing setting offers `Alterar`/`Excluir`; delete confirms and says notifications disabled. Accept Portuguese/English units (`30 minutos`, `2 horas`, `30 minutes`, `2 hours`), reject non-positive/>30-day values with `Formato inválido. Envie uma duração positiva de até 30 dias.`

- [ ] **Step 2: Implement state machine/use-case calls**

Steps: pet, action, duration, delete-confirm. Setting change uses latest food reschedule port; delete cancels. Success text states normalized duration.

- [ ] **Step 3: Run and commit**

Run: `pnpm format && pnpm lint && pnpm --filter carneloot-bot test -- PetFood.e2e.test.ts -t configurar_atraso_notificacao`
Expected: define/change/delete/reschedule/restart PASS.

```bash
git add apps/carneloot-bot/src/bot/conversations/ConfigureReminderDelayConversation.ts apps/carneloot-bot/test/pet-food/PetFood.e2e.test.ts
git commit -m "feat(carneloot): configure feeding reminder delay"
```

### Task 5: Status and food insertion flows

- [ ] **Step 1: Write status transcripts**

No pets: `Você não tem pets`. Missing setup: `Você não configurou o início do dia para o pet Rex.`. Configured lines: `- Rex: 120 g, última vez há 2 horas e 15 minutos`; zero food line is explicit. All-unconfigured case sends warnings only, never empty message.

- [ ] **Step 2: Write add-food transcripts**

No pets exits. Select pet, require day start, prompt quantity/time, reject malformed/duplicate, then post-commit reply `Foram adicionados 50 g de ração para o pet Rex.` and react 👍. Backdated confirmation includes localized timestamp. Duplicate update yields one entry/reply transition.

- [ ] **Step 3: Implement `/status_racao` and `/colocar_racao`**

Status is command handler; add-food state machine has pet and amount/time steps. Authorization is checked when options render and again during insert. Telegram reply/reaction use the actual conversation transition `afterCommit` field after storage commits. For non-conversation commands, the application transaction completes before Telegram output. Output is best effort: failure reports handled-output failure and never rolls back committed food/settings.

- [ ] **Step 4: Run and commit**

Run: `pnpm format && pnpm lint && pnpm --filter carneloot-bot test -- PetFood.e2e.test.ts`
Expected: all four commands, restart, duplicate, timezone, no-empty-message, and output-failure cases PASS.

```bash
git add apps/carneloot-bot/src/bot/conversations/AddFoodConversation.ts apps/carneloot-bot/src/bot/PetFoodHandlers.ts apps/carneloot-bot/test/pet-food/PetFood.e2e.test.ts
git commit -m "feat(carneloot): add and report pet food"
```

## Acceptance criteria

- Food persists only as positive integer milligrams and timestamps as timestamptz.
- Midnight/DST boundaries are executable-tested.
- Empty pet/config states never enter stuck conversation or send empty text.
- Food write and schedule replacement share transaction; backdated entry leaves latest reminder unchanged.
- Missing delay means successful food with reminders disabled.
- Every final mutation rechecks ownership/access and uses a `Number.isSafeInteger`-validated update ID for source idempotency; beyond-safe update IDs remain deferred to a future tfx model change.

# Slice 2 Caregiver Notifications Implementation Plan

**Goal:** Send feeding reminders to owner plus accepted caregivers and create silent actor-excluded food-added notifications with durable per-recipient outcomes.

**Architecture:** Notification events freeze recipients exactly once. Food mutation creates its food-added event, deliveries, and immediate job in same transaction; reminder recipients materialize at dispatch time. Existing fenced delivery state machine remains source of truth, with caregiver access rechecked immediately before send.

**Tech Stack:** Effect services/Layers, tfx JobRuntime, Telegram facade, PostgreSQL, TestClock, Vitest.

---

## File map

- Create: `apps/carneloot-bot/migrations/0007_notification_recipient_freeze.sql`
- Create: `apps/carneloot-bot/src/postgres/Migration0007Sql.ts`
- Create: `apps/carneloot-bot/src/ports/FoodNotificationScheduler.ts`
- Create: `apps/carneloot-bot/src/postgres/FoodNotificationSchedulerLive.ts`
- Create: `apps/carneloot-bot/src/jobs/FoodAddedNotificationJob.ts`
- Create: `apps/carneloot-bot/src/jobs/FoodAddedNotificationJobLive.ts`
- Create: `apps/carneloot-bot/test/notifications/CaregiverRecipients.integration.test.ts`
- Create: `apps/carneloot-bot/test/notifications/FoodAddedNotification.test.ts`
- Create: `apps/carneloot-bot/test/notifications/FoodAddedNotification.e2e.integration.test.ts`
- Modify: `apps/carneloot-bot/src/postgres/AppMigrator.ts`
- Modify: `apps/carneloot-bot/src/postgres/RepositoriesLive.ts`
- Modify: `apps/carneloot-bot/src/domain/notifications/NotificationEvent.ts`
- Modify: `apps/carneloot-bot/src/domain/notifications/NotificationDelivery.ts`
- Modify: `apps/carneloot-bot/src/ports/NotificationRecipients.ts`
- Modify: `apps/carneloot-bot/src/ports/NotificationRepository.ts`
- Modify: `apps/carneloot-bot/src/postgres/NotificationRecipientsLive.ts`
- Modify: `apps/carneloot-bot/src/postgres/NotificationRepositoryLive.ts`
- Modify: `apps/carneloot-bot/src/application/AddFood.ts`
- Modify: `apps/carneloot-bot/src/application/DispatchNotificationDelivery.ts`
- Modify: `apps/carneloot-bot/src/DomainLive.ts`
- Modify: `apps/carneloot-bot/src/JobWorker.ts`
- Modify: `apps/carneloot-bot/src/main.ts`
- Modify: `apps/carneloot-bot/test/MigrationArtifact.test.ts`
- Modify: `apps/carneloot-bot/test/JobWorker.test.ts`
- Modify: `apps/carneloot-bot/test/notifications/DispatchNotificationDelivery.test.ts`
- Modify: `apps/carneloot-bot/test/notifications/FeedingReminder.test.ts`
- Modify: `apps/carneloot-bot/test/notifications/NotificationDomain.test.ts`
- Modify: `apps/carneloot-bot/test/notifications/NotificationRepository.test.ts`

### Task 1: Persist frozen-recipient and food-message metadata

- [ ] **Step 1: Write failing migration/domain tests**

Require event fields `recipientsMaterializedAt` and `foodTimestampExplicit`; verify migrated SQL rows project explicit `null`/`false` values and every object fixture supplies both fields; require artifact parity and migration version 7. Do not add JavaScript-object decode defaults.

- [ ] **Step 2: Add migration**

Create:

```sql
ALTER TABLE carneloot.notification_events
  ADD COLUMN recipients_materialized_at timestamptz,
  ADD COLUMN food_timestamp_explicit boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT notification_events_food_timestamp_shape CHECK (
    food_timestamp_explicit = false OR kind = 'food-added'
  );
```

`recipients_materialized_at IS NULL` means membership may still be resolved. Non-null freezes membership; delivery retries never add recipients.

- [ ] **Step 3: Generate immutable SQL module**

Run: `pnpm --filter carneloot-bot migrations:generate`
Expected: Effect generator creates `Migration0007Sql.ts` from canonical migration with exact bytes/checksum.

Run: `pnpm --filter carneloot-bot migrations:check`
Expected: exits 0.

Register version 7 and extend `MigrationArtifact.test.ts`.

- [ ] **Step 4: Extend schemas and event input**

Add both fields to `NotificationEvent`. Add `foodTimestampExplicit` to `EventInput`; reminder callers pass false, food-added caller passes whether user supplied local date/time.

- [ ] **Step 5: Run migration/domain tests**

Run: `pnpm --filter carneloot-bot test -- MigrationArtifact.test.ts NotificationDomain.test.ts`
Expected: PASS with exact SQL/checksum and explicit new event fields in SQL projections/fixtures.

- [ ] **Step 6: Commit migration**

```bash
git add apps/carneloot-bot/migrations/0007_notification_recipient_freeze.sql apps/carneloot-bot/src/postgres/Migration0007Sql.ts apps/carneloot-bot/src/postgres/AppMigrator.ts apps/carneloot-bot/src/domain/notifications apps/carneloot-bot/test/MigrationArtifact.test.ts apps/carneloot-bot/test/notifications/NotificationDomain.test.ts
git commit -m "feat(carneloot): freeze notification recipient sets"
```

### Task 2: Resolve owner and accepted-caregiver recipients

- [ ] **Step 1: Write failing PostgreSQL recipient tests**

Cover owner only; owner plus accepted caregivers; pending/rejected exclusion; actor exclusion; missing private chat as unreachable; stable ordering owner then caregivers by user ID; and duplicate identity protection.

- [ ] **Step 2: Extend recipient port**

```ts
export interface PetNotificationRecipient {
  readonly userId: UserId
  readonly role: "owner" | "caregiver"
  readonly resolution: ResolvedRecipient
}

readonly resolvePetRecipients: (
  botId: BotId,
  petId: PetId,
  options?: { readonly excludeUserId?: UserId }
) => Effect.Effect<ReadonlyArray<PetNotificationRecipient>, NotificationRecipientsError>
```

Keep `resolveOwner` temporarily for existing callers; remove only after dispatcher uses new method.

- [ ] **Step 3: Implement one parameterized query**

Join pet owner and accepted caregiver users to bot-scoped Telegram identities. Pending/rejected rows cannot appear. Return audited unreachable recipient when no private chat exists. Never infer chat from username.

- [ ] **Step 4: Run recipient tests**

Run: `pnpm --filter carneloot-bot test:integration -- CaregiverRecipients.integration.test.ts NotificationRecipients.integration.test.ts`
Expected: PASS for status filtering, actor exclusion, and unreachable audit rows.

- [ ] **Step 5: Commit recipient resolution**

```bash
git add apps/carneloot-bot/src/ports/NotificationRecipients.ts apps/carneloot-bot/src/postgres/NotificationRecipientsLive.ts apps/carneloot-bot/test/notifications/CaregiverRecipients.integration.test.ts apps/carneloot-bot/test/notifications/NotificationRecipients.integration.test.ts
git commit -m "feat(carneloot): resolve caregiver notification recipients"
```

### Task 3: Make recipient materialization one-shot

- [ ] **Step 1: Write failing repository concurrency tests**

Two concurrent materializers use different recipient sets. Assert one event lock winner freezes one complete set, loser observes frozen state and inserts none; no retry adds later caregiver. Existing delivery uniqueness remains enforced.

- [ ] **Step 2: Extend repository contract**

Add:

```ts
readonly lockForMaterialization: (
  eventId: EventId
) => Effect.Effect<NotificationEvent | undefined, NotificationRepositoryError>
readonly markRecipientsMaterialized: (
  eventId: EventId,
  now: DateTime.Utc
) => Effect.Effect<boolean, NotificationRepositoryError>
readonly findSentByTelegramMessage: (
  botId: BotId,
  chatId: TelegramChatId,
  messageId: number
) => Effect.Effect<NotificationReplyContext | undefined, NotificationRepositoryError>
```

`NotificationReplyContext` contains sent delivery plus event. Query uses all three identity columns and never message ID alone. Plan 6 consumes it.

- [ ] **Step 3: Implement locked materialization transaction**

Caller opens transaction, `lockForMaterialization` selects event `FOR UPDATE`, exits when marker non-null, resolves recipients through same `PgClient`, inserts all deliveries, then marks timestamp. Any failure rolls back rows and marker together.

- [ ] **Step 4: Implement exact sent lookup**

Join sent delivery/event on `(telegram_bot_id, recipient_chat_id, telegram_message_id)`. Return undefined for failed/unknown/pending delivery and malformed unsafe IDs before SQL.

- [ ] **Step 5: Run repository tests**

Run: `pnpm --filter carneloot-bot test:integration -- NotificationRepository.integration.test.ts`
Expected: PASS for concurrent freeze, exact lookup, and existing fenced transitions.

- [ ] **Step 6: Commit repository changes**

```bash
git add apps/carneloot-bot/src/ports/NotificationRepository.ts apps/carneloot-bot/src/postgres/NotificationRepositoryLive.ts apps/carneloot-bot/test/notifications/NotificationRepository.integration.test.ts
git commit -m "feat(carneloot): freeze and correlate notification deliveries"
```

### Task 4: Deliver reminders to frozen owner/caregiver set

- [ ] **Step 1: Write failing dispatcher tests**

Cover owner+two accepted caregivers, one unreachable caregiver, acceptance before materialization, acceptance after freeze, revocation before send, retry after partial send, and no resend of sent/unknown delivery.

- [ ] **Step 2: Refactor reminder preparation**

In `DispatchNotificationDelivery`, wrap only event lock/recipient resolution/materialization/marker in `PgClient.withTransaction`. Then release transaction before Telegram calls. Recipient IDs are generated once per first materialization.

- [ ] **Step 3: Recheck caregiver before send**

For each claimed caregiver delivery, query current accepted relation. Revoked/missing access finalizes permanent failure with safe code `caregiver-access-revoked` and performs no Telegram call. Owner delivery remains valid only while pet ownership/event context matches.

- [ ] **Step 4: Keep independent delivery loop**

A sent/unknown row skips; retryable failed follows existing policy; one recipient failure cannot reattempt already terminal recipients. Event completes only when repository summary says no pending/sending/retryable work.

- [ ] **Step 5: Run dispatcher tests**

Run: `pnpm --filter carneloot-bot test -- DispatchNotificationDelivery.test.ts FeedingReminderJob.test.ts`
Expected: PASS for recipient freeze, revocation, fencing, and partial delivery.

Run: `pnpm --filter carneloot-bot test:integration -- FeedingReminder.e2e.integration.test.ts CaregiverRecipients.integration.test.ts`
Expected: reminder sent to owner/current caregivers with persisted role/message identity.

- [ ] **Step 6: Commit reminder expansion**

```bash
git add apps/carneloot-bot/src/application/DispatchNotificationDelivery.ts apps/carneloot-bot/test/notifications
git commit -m "feat(carneloot): remind owners and caregivers"
```

### Task 5: Schedule food-added events transactionally

- [ ] **Step 1: Write failing atomicity tests**

Cover actor owner/caregiver exclusion, event+delivery+job creation, no recipients, unreachable recipient, scheduler failure rollback of food, and replay producing no duplicate event/job/delivery.

- [ ] **Step 2: Define scheduler port and job**

`FoodNotificationScheduler.scheduleAdded` accepts:

```ts
export interface FoodAddedSchedule {
  readonly botId: BotId
  readonly ownerUserId: UserId
  readonly actorUserId: UserId
  readonly petId: PetId
  readonly foodEntryId: FoodEntryId
  readonly sourceUpdateId: number
  readonly timestampExplicit: boolean
}
```

Create `FoodAddedNotificationJob` payload V1 `{ eventId, botId, petId, foodEntryId }`, max attempts 8, explicit retry classification for rate-limit/transient persistence errors, permanent classification for invalid/deleted context, and fatal classification for defects. Use exponential default delay capped at 30 minutes and honor error-specific `retryAfter`. Conflict key is `food-added:<botId>:<petId>:<sourceUpdateId>`.

- [ ] **Step 3: Implement scheduler Layer**

Inside caller's ambient transaction: resolve actor-excluded owner/accepted caregivers. When recipient set is empty, return without event/job. Otherwise create `food-added` event with dedupe key; insert all pending/unreachable delivery audit rows; mark recipients materialized; schedule immediate job through `JobRuntime`; attach job. No Telegram call occurs.

- [ ] **Step 4: Integrate `AddFood`**

After successful non-replay insertion and reminder reconciliation, call `scheduleAdded`. Pass `timestampExplicit = input.when.length > 0`. A scheduler/database failure rolls back food, reminder changes, event, deliveries, and immediate job. Replay returns existing food and schedules nothing again because original transaction already completed atomically.

- [ ] **Step 5: Run atomicity tests**

Run: `pnpm --filter carneloot-bot test -- FoodAddedNotification.test.ts PetFoodApplication.test.ts`
Expected: PASS.

Run: `pnpm --filter carneloot-bot test:integration -- FoodAddedNotification.e2e.integration.test.ts FeedingReminderScheduling.integration.test.ts`
Expected: PASS with one transaction and one immediate job.

- [ ] **Step 6: Commit scheduling**

```bash
git add apps/carneloot-bot/src/ports/FoodNotificationScheduler.ts apps/carneloot-bot/src/postgres/FoodNotificationSchedulerLive.ts apps/carneloot-bot/src/jobs/FoodAddedNotificationJob.ts apps/carneloot-bot/src/application/AddFood.ts apps/carneloot-bot/test/notifications
git commit -m "feat(carneloot): schedule food-added notifications"
```

### Task 6: Send silent food-added messages

- [ ] **Step 1: Write failing message/payload tests**

Assert actor display, pet name, amount, explicit localized timestamp only when requested, recipient exclusion, and `disable_notification: true` for every food-added send.

- [ ] **Step 2: Add event-kind dispatch branch**

Load food entry/pet/actor and render:

```text
<ator> colocou 50 g de ração para <pet>.
<ator> colocou 50 g de ração para <pet> em 16/07/2026 08:30.
```

Use pet timezone for explicit timestamp. Missing/deleted event context finalizes pending deliveries permanent failed without send.

- [ ] **Step 3: Bind job implementation**

Add `FoodAddedNotificationJobLive.implementation` to `DomainLive` job runtime composition and include declaration in worker tests. Job invokes shared fenced dispatcher with food-added mode; it does not alter feeding-reminder stable schedule.

- [ ] **Step 4: Run delivery tests**

Run: `pnpm --filter carneloot-bot test -- FoodAddedNotification.test.ts DispatchNotificationDelivery.test.ts JobWorker.test.ts`
Expected: PASS with silent Telegram payload and independent recipient outcomes.

Run: `pnpm --filter carneloot-bot test:integration -- FoodAddedNotification.e2e.integration.test.ts`
Expected: owner/caregiver deliveries persist exact sent message identity.

- [ ] **Step 5: Run package gate and commit**

Run: `pnpm format && pnpm lint && pnpm --filter carneloot-bot check && pnpm --filter carneloot-bot test`
Expected: PASS.

```bash
git add apps/carneloot-bot/src apps/carneloot-bot/test/notifications apps/carneloot-bot/test/JobWorker.test.ts
git commit -m "feat(carneloot): deliver silent caregiver food updates"
```

## Acceptance criteria

- Reminder first dispatch freezes owner plus currently accepted caregivers.
- Later acceptance does not join frozen event; revoked caregiver is not sent.
- Food insertion atomically creates actor-excluded deliveries and immediate job.
- Food-added Telegram requests always set `disable_notification: true`.
- Every recipient retains independent pending/sending/sent/failed/unknown audit state.
- Exact sent lookup requires bot, chat, and message ID.
- Generic external notification/API behavior remains absent.

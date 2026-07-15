# Slice 1 Durable Feeding Reminders Implementation Plan

**Goal:** Persist reminder notification events and recipient deliveries, schedule them through tfx jobs, and send with fenced per-recipient outcomes safe across retries/crashes.

**Architecture:** Food transaction creates/replaces one scheduled reminder event and one stable-conflict job. Worker resolves current recipients at send time, materializes unique pending deliveries, atomically fences each send, calls Telegram outside SQL, and finalizes only with matching generation. Ambiguous sends become `unknown` and never auto-retry.

**Tech Stack:** tfx Job/JobStore/Telegram, `@tfx/postgres`, PostgreSQL, Effect TestClock.

---

## File map

- Create: `apps/carneloot-bot/migrations/0004_notifications.sql` and `0005_unreachable_notification_deliveries.sql` (version 5 permits null recipient chat only for audited permanent unreachable failures)
- Create: `apps/carneloot-bot/src/domain/notifications/{NotificationEvent.ts,NotificationDelivery.ts,RecipientRole.ts,DeliveryOutcome.ts}`
- Create: `apps/carneloot-bot/src/ports/{NotificationRepository.ts,NotificationRecipients.ts}`
- Create: `apps/carneloot-bot/src/postgres/NotificationRepositoryLive.ts`
- Create: `apps/carneloot-bot/src/application/{ScheduleFeedingReminder.ts,DispatchNotificationDelivery.ts,RecoverStaleDeliveries.ts}`
- Create: `apps/carneloot-bot/src/jobs/FeedingReminderJob.ts`
- Create: `apps/carneloot-bot/test/notifications/{NotificationRepository.integration.test.ts,FeedingReminder.integration.test.ts,FeedingReminder.e2e.test.ts}`
- Modify: `apps/carneloot-bot/src/application/{ConfigureReminderDelay.ts,AddFood.ts}`

### Task 1: Event/delivery schema and extensible roles

- [ ] **Step 1: Write migration/state-machine tests**

Test unique event dedupe, unique recipient/channel, valid status transitions, free extensible role persistence, Telegram message identity uniqueness, generation fencing, and lease timestamps.

- [ ] **Step 2: Add schema**

Migration uses fixed qualified application schema established in Plan 9:

```text
carneloot.notification_events(id uuid primary key, kind text not null, owner_user_id uuid not null references carneloot.users, pet_id uuid null references carneloot.pets, food_entry_id uuid null references carneloot.pet_food_entries, scheduled_for timestamptz null, status text not null, dedupe_key text not null unique, created_at timestamptz not null, updated_at timestamptz not null, completed_at timestamptz null, cancelled_at timestamptz null)
carneloot.notification_deliveries(id uuid primary key, event_id uuid not null references carneloot.notification_events, recipient_user_id uuid not null references carneloot.users, recipient_chat_id bigint not null, recipient_role text not null, channel text not null, status text not null, attempt_generation bigint not null default 0, attempt_count int not null default 0, sending_started_at timestamptz null, sending_lease_expires_at timestamptz null, retry_at timestamptz null, retryable boolean not null default false, telegram_bot_id text null, telegram_message_id bigint null, safe_error_json jsonb null, sent_at timestamptz null, failed_at timestamptz null, unknown_at timestamptz null, unique(event_id,recipient_user_id,channel))
```

Partial unique index enforces `(telegram_bot_id,recipient_chat_id,telegram_message_id)` when sent identity exists. Status checks allow `pending|sending|sent|failed|unknown`; event allows `scheduled|dispatching|completed|cancelled`.

- [ ] **Step 3: Implement role model**

`RecipientRole` is validated lowercase kebab text, not SQL enum/check union. Export constructors/constants `owner`, `caregiver`, `subscriber`; unknown future valid role round-trips. Slice 1 recipient resolver emits owner only.

- [ ] **Step 4: Run and commit**

Run: `pnpm format && pnpm lint && pnpm --filter carneloot-bot test -- NotificationRepository.integration.test.ts`
Expected: schema/role/constraint tests PASS.

```bash
git add apps/carneloot-bot/migrations/0004_notifications.sql apps/carneloot-bot/src/domain/notifications apps/carneloot-bot/test/notifications/NotificationRepository.integration.test.ts
git commit -m "feat(carneloot): persist notification delivery state"
```

### Task 2: Fenced delivery repository

- [ ] **Step 1: Write transition matrix first**

Cover pending claim; eligible rate-limited failed reclaim; generation/count increment; matching success/failure/unknown; stale finalization rejection; expired sending→unknown; sent/unknown skipped; and late unknown→sent only with the same generation. Explicit/manual resend is outside Slice 1; generation fencing remains future-ready without a resend command or transition.

- [ ] **Step 2: Implement repository operations**

`materializeRecipients(event, recipients)` inserts pending rows idempotently. `claimDelivery` atomically changes pending or explicitly retryable due failed to sending, increments generation/count, sets lease, returns token. Normal finalizers compare delivery ID+generation+status sending. Separate `reconcileUnknownAsSent(deliveryId,generation,messageId)` accepts only same-generation unknown and cannot cross any newer generation.

- [ ] **Step 3: Implement recovery**

Recovery marks expired sending unknown, never pending. It records reason `SendingLeaseExpired`; no automatic send is enqueued for unknown/sent.

- [ ] **Step 4: Run and commit**

Run: `pnpm format && pnpm lint && pnpm --filter carneloot-bot test -- NotificationRepository.integration.test.ts`
Expected: transition/race/recovery matrix PASS with two PgClients.

```bash
git add apps/carneloot-bot/src/ports/NotificationRepository.ts apps/carneloot-bot/src/postgres/NotificationRepositoryLive.ts apps/carneloot-bot/src/application/RecoverStaleDeliveries.ts apps/carneloot-bot/test/notifications/NotificationRepository.integration.test.ts
git commit -m "feat(carneloot): fence notification sends"
```

Event completion is exact: mark completed only when no `pending`, no `sending`, and no retryable `failed` delivery remains—whether its `retry_at` is due now or in the future. `sent`, permanent `failed`, and `unknown` are terminal. Mixed-recipient tests keep the event open while any retryable recipient remains.

### Task 3: Transactional reminder scheduling

- [ ] **Step 1: Write transaction/latest tests**

Newest food with delay atomically inserts food, creates scheduled event, and schedules job conflict key `feeding-reminder:<petId>`. Next newest food cancels prior event/job and replaces both. Backdated food changes neither. Deleting delay cancels current event/job. Forced event/job failure rolls back food/setting transaction.

- [ ] **Step 2: Declare versioned payload**

```ts
const FeedingReminderV1 = Schema.Struct({ eventId: EventId, petId: PetId, foodEntryId: FoodEntryId })
const FeedingReminderPayload = VersionedSchema.history(VersionedSchema.version(1, FeedingReminderV1))
```

- [ ] **Step 3: Implement `ReminderScheduler` with JobStore**

Create event dedupe `feeding-reminder:<petId>:<foodEntryId>` and schedule at food time + delay through injected public `JobRuntime.schedule(FeedingReminderJob, payload, { runAt, conflictKey })`. This choice is valid because JobRuntime delegates to injected JobStore and PostgresJobStore uses the same fiber-local, externally supplied PgClient transaction; nested `withTransaction` participates and creates no pool. Add a forced JobStore failure rollback test proving food/event/job all disappear together, plus a service-identity/type composition test proving one external PgClient. Payload encoding/version/maxAttempts remain owned by the Job declaration, not duplicated in app SQL.

- [ ] **Step 4: Replace recording scheduler and run tests**

Run: `pnpm format && pnpm lint && pnpm --filter carneloot-bot test -- FeedingReminder.integration.test.ts PetFood.integration.test.ts`
Expected: atomic/newest/backdated/delete/failure cases PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/carneloot-bot/src/application/ScheduleFeedingReminder.ts apps/carneloot-bot/src/jobs/FeedingReminderJob.ts apps/carneloot-bot/src/application/AddFood.ts apps/carneloot-bot/src/application/ConfigureReminderDelay.ts apps/carneloot-bot/test/notifications/FeedingReminder.integration.test.ts
git commit -m "feat(carneloot): schedule durable feeding reminders"
```

### Task 4: Reminder sender and job outcomes

- [ ] **Step 1: Write Telegram outcome tests**

Definitive success→sent with message identity. 429/explicit retry-after→failed retryable with `delivery.retry_at = now + retryAfter`; only failed recipients whose retry_at is due are claimable on that run. After processing all currently due recipients, any remaining retryable failed delivery—including runs where none is currently claimable—returns `JobOutcome.retryableFailure(error, max(0, earliestRetryAt - now))`. Multiple recipient delays aggregate to the earliest `retry_at`; success is returned only when the exact event terminal-state rule is satisfied. Permanent 400/403→failed permanent. Network timeout, interruption, malformed response, or post-send persistence uncertainty→unknown. Materialization remains idempotent; sent/unknown/permanent-failed recipients skip on job retry, future retryable failures keep the event open but are not claimed early, and mixed-recipient tests cover success plus due/future retryable outcomes.

- [ ] **Step 2: Implement recipient resolution/materialization**

At dispatch, verify event still active and food entry still latest. Resolve current owner identity/chat and later-extensible recipients; insert owner pending delivery. Removed/unreachable identities become permanent failed without Telegram call.

- [ ] **Step 3: Build reminder text at send time**

Compute current pet-day total:

```text
🚨 Hora de dar comida para o pet Rex. Já foram 120 g hoje.
🚨 Hora de dar comida para o pet Rex. Ainda não foi dada ração hoje.
```

- [ ] **Step 4: Implement fenced send**

Claim transaction commits before Telegram call. Call Telegram. Finalize matching generation. Map Telegram results by certainty: a definitive API response (including 429 retry-after and permanent 400/403) is safe to classify; ambiguous transport timeout/disconnect, malformed response after possible send, persistence uncertainty, or fiber interruption after the sending fence becomes `unknown`. Job-worker interruption before a definitive delivery outcome leaves job/delivery leases for recovery and is never converted to permanent/fatal notification outcome. Complete the event only under the exact terminal-state rule above; otherwise schedule the job at the earliest remaining retryable `retry_at`.

- [ ] **Step 5: Run and commit**

Run: `pnpm format && pnpm lint && pnpm --filter carneloot-bot test -- FeedingReminder.integration.test.ts FeedingReminder.e2e.test.ts`
Expected: definitive/ambiguous/interruption taxonomy, mixed recipients, retry_at/job retry coordination, crash recovery, and fencing PASS.

```bash
git add apps/carneloot-bot/src/ports/NotificationRecipients.ts apps/carneloot-bot/src/application/DispatchNotificationDelivery.ts apps/carneloot-bot/src/jobs/FeedingReminderJob.ts apps/carneloot-bot/test/notifications
git commit -m "feat(carneloot): deliver fenced feeding reminders"
```

## Acceptance criteria

- Slice 1 includes event/delivery persistence; no generic HTTP notification/reply routing yet.
- Recipient role storage accepts owner/caregiver/subscriber without future schema redesign.
- Food/event/job changes commit or roll back together; integration tests prove the `ReminderScheduler` implementation performs only ambient-transaction SQL before commit and no external side effect.
- Pending strictly means no Telegram attempt started; missing Telegram identities materialize directly as permanent failed deliveries with sanitized audit errors.
- Every send has committed sending fence; stale completion cannot overwrite newer generation.
- Ambiguous/expired sends become unknown; sent/unknown never auto-retry. Delivery retryability stops permanently at attempt 8, matching the Job declaration maxAttempts.
- Reminder survives process restart and only current latest-food schedule sends.

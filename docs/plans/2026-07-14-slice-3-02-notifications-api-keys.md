# Slice 3 External Notifications and API Keys Implementation Plan

**Goal:** Activate imported/admin-provisioned notification templates and subscriptions, issue hashed API keys, and synchronously persist/send generic notifications with exact delivery outcomes and reply forwarding.

**Architecture:** Reuse existing notification event/delivery fenced state machine. Add immutable external payload persistence and repositories for dormant migration-0009 key/template/subscription tables. `SendExternalNotification.execute` authenticates, renders/freeze template, transactionally creates event plus pending deliveries, then directly concurrently dispatches recipients and maps persisted state to response; it never enqueues a job for initial HTTP request.

**Tech Stack:** TypeScript, Effect v4, Effect SQL PostgreSQL, TFX Telegram, Vitest, Testcontainers PostgreSQL.

---

## File map

- Create: `src/domain/notifications/ApiKey.ts`, `NotificationTemplate.ts`, `ExternalNotification.ts` — validated domain inputs/results/errors.
- Create: `src/ports/ApiKeyRepository.ts`, `NotificationTemplateRepository.ts` — persistence interfaces.
- Modify: `src/ports/NotificationRepository.ts` — atomic external event/payload/delivery creation, rendered payload lookup, exact aggregate result.
- Create: `src/postgres/ApiKeyRepositoryLive.ts`, `NotificationTemplateRepositoryLive.ts` — hash lookup/upsert and template subscriber lookup.
- Modify: `src/postgres/NotificationRepositoryLive.ts`, `RepositoriesLive.ts`, `DomainLive.ts` — SQL implementation and Layer wiring.
- Create: `src/application/GenerateApiKey.ts`, `RenderNotificationTemplate.ts`, `SendExternalNotification.ts`, `RouteNotificationReply.ts` — named public workflows.
- Modify: `src/application/DispatchNotificationDelivery.ts`, `src/bot/FoodReplyHandler.ts`, `src/Router.ts`, `src/domain/ApplicationError.ts` — shared generic dispatcher and reply routing.
- Create: `migrations/0010_external_notification_payload.sql`, generated `src/postgres/Migration0010Sql.ts`; modify `AppMigrator.ts` and migration artifact test.
- Modify: importer tests only — migration 0009 remains immutable.

### Task 1: Define failures, immutable payload, and exact result contract

**Files:**
- Create: `apps/carneloot-bot/src/domain/notifications/ExternalNotification.ts`
- Modify: `apps/carneloot-bot/src/domain/ApplicationError.ts`
- Test: `apps/carneloot-bot/test/notifications/ExternalNotification.test.ts`

- [ ] **Step 1: Write failing domain tests**

Test placeholder extraction/deduplication and rendering replaces every occurrence. Test missing names are sorted and reported. Test aggregate mapping:

```ts
expect(outcome({ sent: 2, failed: 0, unknown: 0 })).toStrictEqual({ status: 'sent', httpStatus: 200 });
expect(outcome({ sent: 1, failed: 1, unknown: 0 })).toStrictEqual({ status: 'partial', httpStatus: 207 });
expect(outcome({ sent: 0, failed: 2, unknown: 0 })).toStrictEqual({ status: 'failed', httpStatus: 502 });
expect(outcome({ sent: 0, failed: 0, unknown: 1 })).toStrictEqual({ status: 'indeterminate', httpStatus: 202 });
```

- [ ] **Step 2: Run test**

Run: `pnpm exec vitest run apps/carneloot-bot/test/notifications/ExternalNotification.test.ts`

Expected: FAIL because domain contract is absent.

- [ ] **Step 3: Implement closed types**

Define `ExternalNotificationInput` as `{ apiKey: string; keyword: string; variables: Readonly<Record<string, string | number>> }`; define failures `InvalidApiKey`, `TemplateNotFound`, `MissingTemplateVariables`, `InitialNotificationPersistenceUnavailable`; and define `ExternalNotificationResult` with event ID, closed status, counts, and sanitized failures. Never put plaintext key or rendered message in errors/log annotations.

Use:

```ts
export const classifyOutcome = ({ sent, failed, unknown }: DeliveryCounts) =>
  sent > 0 && failed === 0 && unknown === 0 ? { status: 'sent', httpStatus: 200 as const } :
  sent > 0 ? { status: 'partial', httpStatus: 207 as const } :
  unknown > 0 ? { status: 'indeterminate', httpStatus: 202 as const } :
  { status: 'failed', httpStatus: 502 as const };
```

- [ ] **Step 4: Run test**

Run: `pnpm exec vitest run apps/carneloot-bot/test/notifications/ExternalNotification.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/carneloot-bot/src/domain/notifications apps/carneloot-bot/src/domain/ApplicationError.ts apps/carneloot-bot/test/notifications/ExternalNotification.test.ts
git commit -m "feat(carneloot): define external notification outcomes"
```

### Task 2: Persist external rendered payload atomically

**Files:**
- Create: `apps/carneloot-bot/migrations/0010_external_notification_payload.sql`
- Create: `apps/carneloot-bot/src/postgres/Migration0010Sql.ts`
- Modify: `apps/carneloot-bot/src/postgres/AppMigrator.ts`, `src/ports/NotificationRepository.ts`, `src/postgres/NotificationRepositoryLive.ts`
- Test: `apps/carneloot-bot/test/MigrationArtifact.test.ts`, `test/notifications/NotificationRepository.integration.test.ts`

- [ ] **Step 1: Write failing integration tests**

Assert one transaction writes external event, rendered snapshot, owner/subscriber pending deliveries, and no rows when transaction fails. Assert later template edits cannot change payload. Assert initial transaction error yields no Telegram requests.

- [ ] **Step 2: Run test**

Run: `RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts apps/carneloot-bot/test/notifications/NotificationRepository.integration.test.ts`

Expected: FAIL because no external payload schema/operation exists.

- [ ] **Step 3: Add migration 0010 and repository operation**

Create `carneloot.notification_event_payloads` with `event_id uuid primary key references notification_events(id) on delete cascade`, nullable `template_id` FK, and nonempty `rendered_message text`; register generated checksum. Add one `createExternalEvent` repository operation that accepts event/payload/recipients and executes event insert, payload insert, reachable/unreachable delivery materialization in existing caller-owned SQL transaction. Do not modify migration 0009.

- [ ] **Step 4: Run migration and integration checks**

Run: `pnpm --filter carneloot-bot migrations:check && RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts apps/carneloot-bot/test/notifications/NotificationRepository.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/carneloot-bot/migrations/0010_external_notification_payload.sql apps/carneloot-bot/src/postgres apps/carneloot-bot/src/ports/NotificationRepository.ts apps/carneloot-bot/test/MigrationArtifact.test.ts apps/carneloot-bot/test/notifications/NotificationRepository.integration.test.ts
git commit -m "feat(carneloot): persist external notification payloads"
```

### Task 3: Implement key/template repositories and key command

**Files:**
- Create: `src/ports/ApiKeyRepository.ts`, `NotificationTemplateRepository.ts`, `src/postgres/ApiKeyRepositoryLive.ts`, `NotificationTemplateRepositoryLive.ts`, `src/application/GenerateApiKey.ts`, `src/bot/ApiKeyHandlers.ts`
- Modify: `src/DomainLive.ts`, `src/postgres/RepositoriesLive.ts`, `src/bot/Declaration.ts`, `src/Router.ts`
- Test: `test/notifications/ApiKeyRepository.integration.test.ts`, `test/notifications/NotificationTemplateRepository.integration.test.ts`, `test/ApiKeyHandlers.test.ts`

- [ ] **Step 1: Write failing tests**

Assert SHA-256 lookup, one key per user replacement, hash never equals plaintext, owner+subscriber template resolution, owner/keyword isolation, imported migration-0009 rows authorize, `/gerar_chave` requires registration, first key displays exactly once, replacement requires confirmation, rejection replies `Okay!`.

- [ ] **Step 2: Run tests**

Run: `pnpm exec vitest run apps/carneloot-bot/test/ApiKeyHandlers.test.ts && RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts apps/carneloot-bot/test/notifications/ApiKeyRepository.integration.test.ts apps/carneloot-bot/test/notifications/NotificationTemplateRepository.integration.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement repositories and command**

Generate opaque key with injected Effect Crypto secure random bytes, hash with SHA-256, and `INSERT ... ON CONFLICT (user_id) DO UPDATE` key hash/timestamp. Never log/return hash. Add registered `/gerar_chave` declaration; handler uses existing conversation choice primitives for replacement confirmation and replies plaintext only as `Aqui está: <pre>${key}</pre>` with HTML parse mode.

Template repository loads template by `(owner_user_id, keyword)` and subscriptions; resolve recipient private chats through existing user data. Missing private chat becomes an unreachable terminal delivery, not a send attempt.

- [ ] **Step 4: Run tests and menu assertion**

Run: `pnpm exec vitest run apps/carneloot-bot/test/ApiKeyHandlers.test.ts apps/carneloot-bot/test/Router.test.ts && RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts apps/carneloot-bot/test/notifications/ApiKeyRepository.integration.test.ts apps/carneloot-bot/test/notifications/NotificationTemplateRepository.integration.test.ts`

Expected: PASS; menu contains all 24 names.

- [ ] **Step 5: Commit**

```bash
git add apps/carneloot-bot/src/{ports,postgres,application,bot} apps/carneloot-bot/test/{ApiKeyHandlers.test.ts,notifications} apps/carneloot-bot/test/Router.test.ts
git commit -m "feat(carneloot): add api keys and imported templates"
```

### Task 4: Directly dispatch generic notifications and preserve outcomes

**Files:**
- Create: `apps/carneloot-bot/src/application/SendExternalNotification.ts`
- Modify: `apps/carneloot-bot/src/application/DispatchNotificationDelivery.ts`, `src/ports/NotificationRepository.ts`, `src/postgres/NotificationRepositoryLive.ts`, `src/DomainLive.ts`
- Test: `apps/carneloot-bot/test/notifications/SendExternalNotification.test.ts`, `test/notifications/SendExternalNotification.integration.test.ts`

- [ ] **Step 1: Write failing delivery matrix tests**

Use recorded Telegram fake. Cover all sent (`200`), sent plus failed/unknown (`207`), all known failed (`502`), unknown with zero sent (`202`), initial database transaction failure (`503`, zero sends), post-send write/reread failure (`207`/`202`, never `503`), concurrent recipients, rate-limit retry classification, and stale sending recovery to unknown.

- [ ] **Step 2: Run tests**

Run: `pnpm exec vitest run apps/carneloot-bot/test/notifications/SendExternalNotification.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `Effect.fn('SendExternalNotification.execute')`**

Workflow order: hash/authenticate key; resolve owner-scoped template; render/validate variables; yield `Crypto.Crypto` and generate every event/delivery/API-key UUID with `yield* crypto.randomUUIDv4`; transactionally persist event/payload/all deliveries; run `DispatchNotificationDelivery` generic mode per delivery with bounded concurrent `Effect.forEach`; finalize every unattempted recipient as failed when send phase ends; reread aggregate state; map exact closed result. Initial transaction persistence errors map only to `InitialNotificationPersistenceUnavailable`; any post-send persistence uncertainty increments unknown. Do not queue an initial job and do not blindly retry unknown/sent rows.

Refactor dispatcher only enough to accept immutable text and generic event kind while retaining existing pet-reminder access checks in its branch. Every public/non-trivial workflow is `Effect.fn` named after module/function.

- [ ] **Step 4: Run unit/integration tests**

Run: `pnpm exec vitest run apps/carneloot-bot/test/notifications/SendExternalNotification.test.ts apps/carneloot-bot/test/notifications/DispatchNotificationDelivery.test.ts && RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts apps/carneloot-bot/test/notifications/SendExternalNotification.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/carneloot-bot/src/application apps/carneloot-bot/src/{ports,postgres} apps/carneloot-bot/test/notifications
git commit -m "feat(carneloot): send external notifications directly"
```

### Task 5: Route subscriber replies to exact owner delivery

**Files:**
- Create: `apps/carneloot-bot/src/application/RouteNotificationReply.ts`
- Modify: `apps/carneloot-bot/src/bot/FoodReplyHandler.ts`, `src/bot/Declaration.ts`, `src/Router.ts`, `src/ports/NotificationRepository.ts`, `src/postgres/NotificationRepositoryLive.ts`
- Test: `apps/carneloot-bot/test/notifications/RouteNotificationReply.integration.test.ts`, `test/Router.test.ts`

- [ ] **Step 1: Write failing tests**

Assert a subscriber reply finds sent delivery by `(botId, chatId, repliedMessageId)`, sends forwarded text as reply to same event owner's sent Telegram message, rejects owner self-reply, ignores unknown reply, and preserves existing feeding reminder route with pet access reauthorization.

- [ ] **Step 2: Run test**

Run: `RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts apps/carneloot-bot/test/notifications/RouteNotificationReply.integration.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement ordered reply dispatcher**

`RouteNotificationReply.execute` first queries generic sent-delivery context. If event is external and role subscriber, locate owner-role sent delivery for same event and call Telegram `sendMessage` replying to owner message ID. If role owner, return typed permanent rejection. If no generic match, delegate unchanged food reply route. Do not infer owner chat/message from unrelated event or message IDs.

- [ ] **Step 4: Run reply suite**

Run: `pnpm exec vitest run apps/carneloot-bot/test/Router.test.ts && RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts apps/carneloot-bot/test/notifications/RouteNotificationReply.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/carneloot-bot/src/application/RouteNotificationReply.ts apps/carneloot-bot/src/bot apps/carneloot-bot/src/{ports,postgres} apps/carneloot-bot/test/notifications/RouteNotificationReply.integration.test.ts apps/carneloot-bot/test/Router.test.ts
git commit -m "feat(carneloot): forward external notification replies"
```

### Task 6: Verify importer/admin provisioning path

**Files:**
- Modify: `apps/carneloot-bot/test/importer/LegacyMapping.test.ts`, `test/importer/LegacyTarget.integration.test.ts`

- [ ] **Step 1: Add failing importer assertions**

Assert `api_keys.key_hash`, template owner/keyword/message, and `(template_id,user_id)` subscription rows map and promote idempotently. Seed imported data then call `SendExternalNotification.execute` to prove key authorization and subscriptions work.

- [ ] **Step 2: Run tests**

Run: `RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts apps/carneloot-bot/test/importer/LegacyTarget.integration.test.ts`

Expected: FAIL only if existing importer misses an active target.

- [ ] **Step 3: Correct importer only if test demonstrates gap**

Keep `LegacyMapping` mappings at `api_keys`, `notification_templates`, and `notification_subscriptions`; change importer code only for demonstrated mapping/promotion failure. Do not add bot/API CRUD for templates/subscriptions.

- [ ] **Step 4: Run slice persistence suite**

Run: `RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts apps/carneloot-bot/test/importer apps/carneloot-bot/test/notifications`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/carneloot-bot/src/importer apps/carneloot-bot/test/importer
git commit -m "test(carneloot): verify imported notification provisioning"
```

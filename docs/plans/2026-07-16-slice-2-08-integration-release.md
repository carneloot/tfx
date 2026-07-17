# Slice 2 Integration and Release Proof Implementation Plan

**Goal:** Wire every Slice 2 Layer, prove complete shared pet-food milestone under Node/Bun with real PostgreSQL, and prepare reviewable tfx package release metadata.

**Architecture:** One production composition supplies repositories, caregiver/food notification schedulers, both job implementations, conversations, registered message handlers, polling, and durable PostgreSQL adapters. End-to-end fixtures drive decoded Telegram updates through real router/storage while recording Telegram requests.

**Tech Stack:** Effect Layers/Scopes, tfx polling/runtime, PostgreSQL 17, Vitest, Node 24.18.0, Bun 1.3.14, GitHub Actions, Changesets.

---

## File map

- Create: `apps/carneloot-bot/test/e2e/SharedPetFoodSystem.e2e.integration.test.ts`
- Create: `apps/carneloot-bot/test/e2e/Slice2Restart.e2e.integration.test.ts`
- Create: `apps/carneloot-bot/test/e2e/Slice2Concurrency.e2e.integration.test.ts`
- Create: `apps/carneloot-bot/test/e2e/Slice2Cutover.e2e.integration.test.ts`
- Create: `docs/demos/2026-07-16-slice-2-shared-pet-food.md`
- Create: `.changeset/typed-message-handlers-and-command-aliases.md`
- Modify: `apps/carneloot-bot/src/AppLive.ts`
- Modify: `apps/carneloot-bot/src/DomainLive.ts`
- Modify: `apps/carneloot-bot/src/PersistenceLive.ts`
- Modify: `apps/carneloot-bot/src/RuntimeLive.ts`
- Modify: `apps/carneloot-bot/src/Program.ts`
- Modify: `apps/carneloot-bot/src/Production.ts`
- Modify: `apps/carneloot-bot/src/DemoSummary.ts`
- Modify: `apps/carneloot-bot/src/postgres/RepositoriesLive.ts`
- Modify: `apps/carneloot-bot/src/Router.ts`
- Modify: `apps/carneloot-bot/src/demo-test.ts`
- Modify: `apps/carneloot-bot/test/AppLive.integration.test.ts`
- Modify: `apps/carneloot-bot/test/PersistenceLive.integration.test.ts`
- Modify: `apps/carneloot-bot/test/Program.test.ts`
- Modify: `apps/carneloot-bot/test/DemoSummary.test.ts`
- Modify: `apps/carneloot-bot/test/NodeSmoke.test.ts`
- Modify: `apps/carneloot-bot/test/smoke.test.ts`
- Modify: `apps/carneloot-bot/README.md`

### Task 1: Audit final Layer graph

- [ ] **Step 1: Add failing Layer construction tests**

Construct production-equivalent Layer with test platform edges and require no unresolved service except explicit config/platform services. Assert PostgreSQL caregiver repository, notification recipient/repository, food notification scheduler, reminder scheduler, all conversations, registered message handler, and both job implementations are present once.

- [ ] **Step 2: Complete persistence composition**

`PersistenceLive`/`RepositoriesLive` merge caregiver and updated notification adapters over same application `PgClient`. Migrations run before repositories become available. No adapter creates its own pool/client.

- [ ] **Step 3: Complete domain composition**

`DomainLive` supplies `RegisteredUser`, `Conversations`, `ReminderScheduler`, `FoodNotificationScheduler`, `FeedingReminderJobLive`, and `FoodAddedNotificationJobLive`. Avoid duplicate `JobRuntime`, `NotificationRepository`, or middleware providers.

- [ ] **Step 4: Complete router/runtime composition**

`Router` includes account, pet/caregiver, pet-food, and reply groups plus all conversations. `RuntimeLive` still selects exactly one polling descriptor and PostgreSQL durable deduplication. Command menu includes every Slice 1/2 command and excludes message handlers.

- [ ] **Step 5: Run Layer tests**

Run: `pnpm --filter carneloot-bot test -- BotLayers.test.ts Program.test.ts NodeSmoke.test.ts`
Expected: PASS with no missing/duplicate Layer service.

Run: `pnpm --filter carneloot-bot test:integration -- AppLive.integration.test.ts PersistenceLive.integration.test.ts`
Expected: complete scoped acquisition/release PASS.

- [ ] **Step 6: Commit composition**

```bash
git add apps/carneloot-bot/src apps/carneloot-bot/test/AppLive.integration.test.ts apps/carneloot-bot/test/PersistenceLive.integration.test.ts apps/carneloot-bot/test/Program.test.ts apps/carneloot-bot/test/NodeSmoke.test.ts
git commit -m "feat(carneloot): compose slice two runtime"
```

### Task 2: Build complete shared pet-food E2E scenario

- [ ] **Step 1: Create owner/caregiver lifecycle fixture**

Drive updates through runtime:

1. register owner and two caregivers;
2. add/configure two pets;
3. invite/accept one caregiver and reject other;
4. list pets/caregivers;
5. accepted caregiver adds food;
6. `/todos` adds food in two timezones;
7. owner corrects then deletes entries;
8. caregiver stops caring;
9. owner deletes pet.

Assert PostgreSQL state, Portuguese messages, menu declarations, one transition per update, and exact reply-keyboard lifecycle from Plan 7.5: finite choices render expected rows, `Cancelar` is visible on selection/action keyboards, and free-text/terminal replies remove stale keyboards.

- [ ] **Step 2: Add notification/reply path**

Advance `TestClock` to reminder. Assert owner+accepted caregiver sent deliveries and exact message identities. Reply to reminder, assert food insertion/new reminder/silent actor-excluded food-added delivery. Reply to single and `/todos` source messages, assert safe correction and schedule repair.

- [ ] **Step 3: Add negative access cases**

Pending/rejected/revoked caregiver cannot list shared pet as cared, mutate food, or use reply shortcut. Same numeric replied message ID in another chat/bot changes nothing. Empty lists produce explicit messages and no conversation.

- [ ] **Step 4: Run complete scenario**

Run: `pnpm --filter carneloot-bot test:integration -- SharedPetFoodSystem.e2e.integration.test.ts`
Expected: full lifecycle PASS with exact domain/delivery assertions.

- [ ] **Step 5: Commit milestone E2E**

```bash
git add apps/carneloot-bot/test/e2e/SharedPetFoodSystem.e2e.integration.test.ts
git commit -m "test(carneloot): prove shared pet food system"
```

### Task 3: Prove restart, duplicate, and concurrency behavior

- [ ] **Step 1: Add restart scenarios**

Stop/rebuild Layers during caregiver invitation, food correction, and deletion conversations; resume from PostgreSQL state and accept a valid button label for the persisted current step. Restart while reminder/food-added job scheduled and while delivery is `sending`; assert scheduled work recovers and expired sending becomes unknown.

- [ ] **Step 2: Add duplicate-update scenarios**

Redeliver caregiver response, `/todos`, correction, deletion, reminder reply, and food-source reply updates. Assert one domain transition/write, per-pet replay behavior, no duplicate recipient materialization, and no resend of sent/unknown delivery.

- [ ] **Step 3: Add ordering/concurrency scenarios**

Same-chat updates execute in order. Unrelated chats progress concurrently. Two users race caregiver accept/removal and correction/revocation; row locks ensure one legal result and no unauthorized mutation. `/todos` respects concurrency cap.

- [ ] **Step 4: Run restart/concurrency suites**

Run: `pnpm --filter carneloot-bot test:integration -- Slice2Restart.e2e.integration.test.ts Slice2Concurrency.e2e.integration.test.ts`
Expected: PASS for restart, deduplication, lease recovery, ordering, and races.

- [ ] **Step 5: Commit durability proof**

```bash
git add apps/carneloot-bot/test/e2e/Slice2Restart.e2e.integration.test.ts apps/carneloot-bot/test/e2e/Slice2Concurrency.e2e.integration.test.ts
git commit -m "test(carneloot): prove slice two durability"
```

### Task 4: Prove failure classification and notification safety

- [ ] **Step 1: Add Telegram failure matrix**

For reminder and food-added recipients, test rate limit, internal/conflict, forbidden/invalid request, network/invalid response, malformed successful result, interruption, and final status-write failure. Assert retryable/permanent/unknown classification and no blind retry after ambiguous outcome.

- [ ] **Step 2: Add transactional failures**

Fail caregiver repository, food mutation, reminder replacement, recipient materialization, immediate job insertion, and initial event transaction. Assert no partial relation/food/job/event/delivery state and no Telegram call before committed delivery.

- [ ] **Step 3: Add post-commit output failures**

Fail conversation success reply/reaction and caregiver DM. Assert committed mutation remains, update outcome is handled-with-output-failure, and duplicate update does not repeat domain write.

- [ ] **Step 4: Run focused suites**

Run: `pnpm --filter carneloot-bot test -- Router.test.ts DispatchNotificationDelivery.test.ts FoodAddedNotification.test.ts CaregiverConversations.test.ts`
Expected: closed outcome mapping PASS.

Run: `pnpm --filter carneloot-bot test:integration -- SharedPetFoodSystem.e2e.integration.test.ts -t "failure"`
Expected: no partial SQL state or unsafe resend.

- [ ] **Step 5: Commit failure proof**

```bash
git add apps/carneloot-bot/test apps/carneloot-bot/src/Router.ts
git commit -m "test(carneloot): verify slice two failure safety"
```

### Task 5: Prove importer cutover

- [ ] **Step 1: Add cutover fixture**

Create legacy database with users, owned/shared pets, settings, food (including rounded grams), API hash, template/subscription, safe/unsafe notification history, sessions, and no BullMQ data source.

- [ ] **Step 2: Execute dry-run then import**

Assert dry-run target remains empty and report counts/blockers/warnings are exact. Run import, assert target rows/FKs/timestamps/hashes/message coordinates, excluded state report, and rebuilt reminders.

- [ ] **Step 3: Start bot on imported database**

Use imported owner/caregiver to list/status/add/reply/correct/delete food. Advance clock and assert rebuilt reminder. Rerun importer and assert zero inserted rows and one stable reminder per pet.

- [ ] **Step 4: Run cutover test**

Run: `pnpm --filter carneloot-bot test:integration -- Slice2Cutover.e2e.integration.test.ts LegacyImporter.integration.test.ts`
Expected: dry-run, promotion, production read, reminder rebuild, and rerun PASS.

- [ ] **Step 5: Commit cutover proof**

```bash
git add apps/carneloot-bot/test/e2e/Slice2Cutover.e2e.integration.test.ts apps/carneloot-bot/test/importer
git commit -m "test(carneloot): prove legacy cutover"
```

### Task 6: Document runnable milestone

- [ ] **Step 1: Update app README**

Document required env, migrations, polling startup, all Slice 1/2 commands, caregiver access rules, reply shortcuts, notification at-least-once/unknown semantics, importer dry-run/import commands, and rollback/cutover warning. State single active bot replica.

- [ ] **Step 2: Add demo runbook**

`docs/demos/2026-07-16-slice-2-shared-pet-food.md` contains exact setup commands, two Telegram users, command transcript, expected database checks, reminder clock/wait behavior, importer fixture command, and cleanup. No production token/database values appear.

- [ ] **Step 3: Extend demo smoke**

`demo-test.ts` acquires production-equivalent Bun composition against test config, verifies declared Slice 2 commands/message updates/job declarations, then releases scope. `DemoSummary` reports delivery mode, durable deduplication, caregiver/shared-food capability, and job declarations without secrets.

- [ ] **Step 4: Run demo**

Run: `pnpm --filter carneloot-bot demo:test`
Expected: exits 0 and prints sanitized Slice 2 readiness summary.

- [ ] **Step 5: Commit docs/demo**

```bash
git add apps/carneloot-bot/README.md apps/carneloot-bot/src/DemoSummary.ts apps/carneloot-bot/src/demo-test.ts apps/carneloot-bot/test/DemoSummary.test.ts docs/demos/2026-07-16-slice-2-shared-pet-food.md
git commit -m "docs: add slice two runbook"
```

### Task 7: Validate Node and Bun gates

- [ ] **Step 1: Run canonical Node gate**

```bash
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm format
mise exec -- pnpm lint
mise exec -- pnpm --filter tfx telegram:check
mise exec -- pnpm check:tfx:package
mise exec -- pnpm check
mise exec -- pnpm test:unit
mise exec -- pnpm test:integration
mise exec -- pnpm build
mise exec -- pnpm check:packed:consumers
mise exec -- pnpm --filter carneloot-bot demo:test
```

Expected: all commands exit 0 under Node 24.18.0 and PostgreSQL 17.

- [ ] **Step 2: Run canonical Bun gate**

```bash
mise exec -- bun x tsc -b tsconfig.json --pretty false
mise exec -- bun x vitest run --exclude '**/*.integration.test.ts' --exclude '**/*.e2e.test.ts' packages/tfx/test packages/postgres/test apps/carneloot-bot/test
mise exec -- bun x vitest run --config vitest.integration.config.ts
```

Expected: all commands exit 0 under Bun 1.3.14 and PostgreSQL 17.

- [ ] **Step 3: Confirm CI selection**

Inspect `.github/workflows/ci.yml` and record that existing `apps/carneloot-bot/test` unit/integration globs include every new suite. Retain mise pins and both runtime jobs; no workflow edit is required.

- [ ] **Step 4: Record gate evidence**

Add exact date/runtime/database versions and command outcomes to demo runbook validation section. Do not paste tokens, URLs, API hashes, message text payloads, or private identifiers.

### Task 8: Add release metadata and final review

- [ ] **Step 1: Create changeset**

Create `.changeset/typed-message-handlers-and-command-aliases.md`:

```markdown
---
"tfx": minor
---

Add command aliases plus typed message and reply-handler declarations with exhaustive builder and runtime routing support.
```

Expected: one minor changeset for `tfx`; Carneloot app remains private and has no publication entry.

- [ ] **Step 2: Dry-run package validation**

Run: `pnpm check:tfx:package && pnpm check:packed && pnpm check:packed:consumers`
Expected: tfx packed command declarations support aliases, exports include MessageHandler/MessageInput/MessageHandlerResult, and no internal test helper or Carneloot code leaks.

- [ ] **Step 3: Run fresh code review**

Review against Slice 2 checklist: six pet/caregiver commands, two all-pet aliases, correction/deletion, reminder replies, safe source replies, caregiver reminders, silent notifications, corrected rescheduling, importer, and Plan 7.5 conversation keyboards. Final Slice 2 Telegram menu contains 17 command names; `/cancelar` remains lifecycle-only until Slice 3 declaration. Check SQL parameterization, access rechecks, exact message identity, recipient fencing, report sanitization, finite-choice keyboard coverage, visible cancellation, stale-keyboard removal, and Slice 3 exclusions.

- [ ] **Step 4: Fix findings with follow-up commits**

For each accepted finding, add/reproduce test first, implement minimal fix, run owned focused gate, then create new commit. Do not amend earlier commits.

- [ ] **Step 5: Commit release metadata**

```bash
git add .changeset apps/carneloot-bot/test docs/demos/2026-07-16-slice-2-shared-pet-food.md
git commit -m "chore: prepare slice two release proof"
```

## Acceptance criteria

- All Slice 2 commands and aliases are declared, handled, and demonstrated.
- Every finite conversation choice renders a typed reply keyboard; cancellation and free-text/terminal keyboard removal are proven through recorded Telegram requests.
- Complete caregiver→shared food→notification→reply→revocation path passes with real PostgreSQL.
- Restart, duplicate updates, same-chat ordering, cross-chat concurrency, correction/deletion, backdated food, Telegram failures, and malformed results are covered.
- Import dry-run/cutover/rerun is proven end to end.
- Node 24.18.0 and Bun 1.3.14 gates pass.
- tfx packed package supports command aliases, exports message-handler API, and contains no private harness.
- Fresh review confirms Slice 2 coverage and no Slice 3 behavior creep.

# Slice 1 Integration and Runnable Release Implementation Plan

**Goal:** Compose Bun Carneloot production Layers, prove complete owned-pet food loop through end-to-end updates/restarts, and produce reviewed dry-run package/application artifacts.

**Architecture:** One scoped Effect program acquires PgClient, migrations, Telegram facade, PostgreSQL tfx adapters, domain repositories, job workers, and polling runtime. Production startup asserts durable deduplication and never falls back to memory/no-op services.

**Tech Stack:** `@effect/platform-bun`, `@effect/platform-node` validation, tfx, `@tfx/postgres`, PostgreSQL 17, pnpm/Changesets.

---

## File map

- Create: `apps/carneloot-bot/src/{Config.ts,Layers.ts,Program.ts,JobWorker.ts}`
- Modify: `apps/carneloot-bot/src/main.ts`
- Modify: `packages/tfx/src/BotRuntime.ts`, `packages/tfx/test/BotRuntime.test.ts`
- Create: `apps/carneloot-bot/src/postgres/Migrations.ts`
- Create: `apps/carneloot-bot/test/Config.test.ts`
- Create: `apps/carneloot-bot/test/e2e/{OwnedPetFoodLoop.e2e.test.ts,RestartRecovery.e2e.test.ts,Concurrency.e2e.test.ts}`
- Create: `apps/carneloot-bot/README.md`, `apps/carneloot-bot/.env.example`
- Create: `.changeset/slice-1-owned-pet-food.md`
- Modify: root `README.md`, package manifests/scripts, CI workflow

### Task 1: Observable runtime lifecycle, configuration, and scoped composition

- [ ] **Step 1: Add the public BotRuntime lifecycle contract**

Write failing tfx tests where a controlled UpdateSource fails after Layer acquisition and where scope shutdown interrupts a running source. Extend `BotRuntimeService` with `readonly await: Effect.Effect<void, unknown>`; the Layer retains the scoped source fiber and `await` joins it, preserving authentication/conflict/fatal polling failure instead of hiding it. Keep `dispatch` unchanged. Top-level application code must run/await this effect; scope shutdown interrupts source, dispatcher children, and job worker.

- [ ] **Step 2: Write config failures**

Require only consumed fields: redacted bot token/database URL, bot ID, polling timeout seconds, polling retry-delay milliseconds, dispatcher capacity/concurrency, job idle-backoff milliseconds, job/dedup lease/heartbeat milliseconds, and tfx-only `TFX_POSTGRES_SCHEMA`/`TFX_POSTGRES_TABLE_PREFIX`. Decode numeric environment values once into the exact numeric units expected by Polling/worker APIs. Carneloot tables remain fixed in explicitly qualified `carneloot`. Reject heartbeat ≥ lease, unsafe/non-integer bot/update identity configuration, and non-durable production mode before polling. Do not retain an HTTP-timeout or transport-margin field until an actual platform HttpClient configuration consumes it.

- [ ] **Step 3: Implement application Layer graph**

Declare app runtime dependencies explicitly: runtime dependencies `@effect/platform-bun`, `@effect/sql-pg`, `effect`, `tfx`, and `@tfx/postgres`; dev dependency `@effect/platform-node` for portable smoke composition. Provide `PgClient.layer` exactly once. `TfxPostgres.layer` performs its own coordinated tfx migration once; app migrator uses the same client, with no manual duplicate tfx migration. Compose repositories, handlers, FeedingReminder JobRuntime, JobWorker, Telegram facade, Bun HttpClient, and `BotRuntime.layer(Carneloot, { delivery: Polling.make({ timeout: config.pollingTimeoutSeconds, retryDelay: config.pollingRetryDelayMillis }), capacity: config.dispatchCapacity, concurrency: config.dispatchConcurrency })`. Layer dependencies—not handwritten acquisition order—express migration-before-repository/runtime construction. Assert dedup diagnostics `mode === "durable"`.

- [ ] **Step 4: Implement scoped JobWorker and Bun program**

Create a `JobWorker` service/Layer because `JobRuntime.layer` only exposes `runOne`. Its scoped loop calls `runOne({ leaseDuration })`, immediately continues after a claimed job, and sleeps the configured bounded idle backoff only when no job is due; validate positive finite durations, prevent zero-delay spin, preserve worker defects/store failures through an `await` lifecycle effect, and let interruption leave leases for recovery. Bun main runs one scoped Layer graph and awaits both `BotRuntime.await` and `JobWorker.await` (race/fail-fast supervision); signals interrupt the shared scope, whose finalizers stop polling/dispatcher/jobs. Tests use TestClock for idle backoff and interruption/recovery.

- [ ] **Step 5: Add Node smoke composition**

Test same portable packages/program factory with `@effect/platform-node` HttpClient; no tfx platform wrappers.

- [ ] **Step 6: Run and commit**

Run: `pnpm format && pnpm lint && pnpm --filter carneloot-bot check && pnpm --filter carneloot-bot test -- Config && pnpm --filter tfx test -- BotRuntime`
Expected: config/composition tests PASS.

```bash
git add apps/carneloot-bot/src apps/carneloot-bot/test package.json pnpm-lock.yaml
git commit -m "feat(carneloot): compose Slice 1 runtime"
```

### Task 2: Complete owned-pet E2E transcript

- [ ] **Step 1: Add golden update sequence**

Drive public runtime with fake Telegram and real PostgreSQL:

```text
/cadastrar
/cadastrar after username/name change
/adicionar_pet → Rex
/listar_pets
/configurar_inicio_dia → Rex → 0h → America/Sao_Paulo
/configurar_atraso_notificacao → Rex → 8 horas
/status_racao
/colocar_racao → Rex → 50g
/status_racao
```

Assert exact Portuguese requests, profile refresh, one pet, midnight settings, 50,000mg row, reminder event/job, and status line.

- [ ] **Step 2: Add failure/correction scenarios**

Unregistered guard; missing sender; no pets; invalid pet/timezone/duration/food; duplicate feeding/update; no delay; backdated food; scheduler rollback; Telegram output failure after commit; `/cancelar` cleanup.

- [ ] **Step 3: Run E2E**

Run: `pnpm format && pnpm lint && pnpm --filter carneloot-bot test -- OwnedPetFoodLoop.e2e.test.ts`
Expected: PASS with real PostgreSQL and no external Telegram.

- [ ] **Step 4: Commit**

```bash
git add apps/carneloot-bot/test/e2e/OwnedPetFoodLoop.e2e.test.ts
git commit -m "test(carneloot): cover owned-pet food loop"
```

### Task 3: Restart, dedup, reminder, and concurrency proof

- [ ] **Step 1: Add restart test**

Stop scope mid-conversation, recreate scope with same database, finish conversation. Restart before due reminder, advance TestClock/run worker, assert one owner send and sent delivery. Restart after committed sending without finalization, expire lease, assert unknown and no resend.

- [ ] **Step 2: Add job migration/lease proof**

Seed v1/current and invalid/newer payloads. Assert migration claim does not increment attempts, promotion does, invalid/newer quarantine, execution takeover consumes next attempt, and stale completion fails.

- [ ] **Step 3: Add update concurrency proof**

Duplicate update across two runtime clients executes one mutation. Same-chat updates run FIFO; unrelated chats overlap. Retryable update blocks contiguous polling offset while later completed update is skipped on repeated batch. Every update/chat/user ID fixture stays within JS safe-integer range and ingress rejection of an unsafe number is covered; arbitrary bigint/string Telegram IDs remain deferred to a future tfx model change.

- [ ] **Step 4: Run and commit**

Run: `pnpm format && pnpm lint && pnpm --filter carneloot-bot test -- RestartRecovery.e2e.test.ts Concurrency.e2e.test.ts`
Expected: PASS.

```bash
git add apps/carneloot-bot/test/e2e/RestartRecovery.e2e.test.ts apps/carneloot-bot/test/e2e/Concurrency.e2e.test.ts
git commit -m "test(carneloot): prove durable restart semantics"
```

### Task 4: Documentation and runnable demo

- [ ] **Step 1: Document local operation**

Include `mise install`, `pnpm install`, PostgreSQL startup, migrations, env fields, Bun polling command, graceful stop, test commands, and explicit Slice 1 command list. State reminders-at-least-once with per-recipient unknown safeguard.

- [ ] **Step 2: Add safe demo command**

`pnpm --filter carneloot-bot demo` starts against configured PostgreSQL/Telegram only when required env is present; `demo:test` runs fake Telegram transcript and prints persisted summary without secrets.

- [ ] **Step 3: Add Changeset**

Minor changesets for `tfx` and `@tfx/postgres`; describe generated Telegram facade, declarations/runtime, conversations/jobs/dedup, PostgreSQL adapters. Do not publish.

- [ ] **Step 4: Validate and commit docs**

Run: `pnpm format && pnpm lint`
Expected: PASS before staging documentation/package changes.

```bash
git add README.md apps/carneloot-bot/README.md apps/carneloot-bot/.env.example package.json apps/carneloot-bot/package.json .changeset/slice-1-owned-pet-food.md
git commit -m "docs: add Slice 1 runnable demo"
```

### Task 5: Final validation, review, and release dry run

- [ ] **Step 1: Regeneration and static gates**

Run: `pnpm format && pnpm lint && pnpm --filter tfx telegram:check && pnpm check && pnpm test:unit && pnpm test:integration && pnpm build`
Expected: PASS, clean generated diff, and no environment-gated PostgreSQL skip in release mode. CI mirrors these format/lint/generated/check/unit/integration/build gates.

- [ ] **Step 2: Real PostgreSQL suites under Node**

Run: `pnpm format && pnpm lint && pnpm test:integration && pnpm --filter carneloot-bot test -- test/e2e`
Expected: every real-PostgreSQL suite executes and passes. Release validation fails when a suite reports an environment-gated skip; CI supplies PostgreSQL 17 and `TEST_DATABASE_URL`.

- [ ] **Step 3: Bun compatibility gate**

Run: `bun x vitest run packages/tfx/test packages/postgres/test apps/carneloot-bot/test`
Expected: PASS against PostgreSQL 17.

- [ ] **Step 4: Package/export inspection**

Run `pnpm --filter tfx pack --pack-destination dist-pack` and same for `@tfx/postgres`. Inspect tarballs: declared public subpaths and the generated Telegram runtime asset required by the facade are present; broad raw/internal source subpaths remain inaccessible through package exports; private tests and Testcontainers are absent. Install both packed tarballs into temporary Node and Bun consumers, import every public subpath, and execute one facade call through fake HttpClient. Keep Changesets as a dry run only: no publish or deployment.

- [ ] **Step 5: Fresh review**

Review against design sections 4–10, 14, and Slice 1 checklist. Require no SQL in handlers, no app/internal imports, and no implicit memory/no-op production Layer. Record evidence for reviewer resolution R1: migration claim consumes zero attempts and expired execution reclaims then increments exactly once on promotion (`JobRuntime.test.ts`, `JobStore.integration.test.ts`); R2: recipient role persists extensible `owner|caregiver|subscriber` constructors without PostgreSQL enum migration (`NotificationRepository.integration.test.ts`); R3: Slice 1 reminder event/delivery persistence fences `pending→sending→outcome`, recovers stale sending to unknown, and skips sent/unknown (`FeedingReminder.integration.test.ts`).

- [ ] **Step 6: Run demo and record evidence**

Run: `pnpm format && pnpm lint && pnpm --filter carneloot-bot demo:test`
Expected: transcript completes and reports one user, one pet, one food entry, one scheduled/completed reminder with persisted delivery outcome.

- [ ] **Step 7: Commit review fixes separately if needed**

Start review from a clean tree. After applying fixes, inspect and stage only review changes:

```bash
git status --short
git diff --name-only -z | xargs -0 --no-run-if-empty git add --
git diff --cached --name-only
git commit -m "fix: address Slice 1 review"
```

Skip commit when review requires no changes. Never amend prior commits. Do not publish or deploy before user approval.

## Acceptance criteria

- Seven required commands and durable reminder work through runtime using real PostgreSQL.
- Repeat registration refresh, midnight, empty lists, latest/backdated scheduling, dedup, restart, and fenced unknown outcomes are proven.
- Node 24.18.0 and Bun 1.3.14 gates pass.
- `tfx` and `@tfx/postgres` pack cleanly without private harness/internal raw client.
- Fresh review completes; demo is runnable; no registry publication occurs.

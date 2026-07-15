# Slice 1 PostgreSQL Adapters and Migrations Implementation Plan

**Goal:** Implement coordinated `@tfx/postgres` migrations and durable conversation, job, and deduplication Layers over one application-provided `PgClient.PgClient`.

**Architecture:** Adapter package owns only tfx infrastructure tables. Every operation uses safe identifier fragments and ambient Effect SQL transaction; conversation handler effects share row-lock transaction, jobs use fenced two-phase claims with `SKIP LOCKED`, and dedup claims use generation leases.

**Tech Stack:** PostgreSQL 17, `@effect/sql-pg` 4.0.0-beta.98, Effect SQL migrator, private conformance harness.

---

## File map

- Create: `packages/postgres/src/{Options.ts,PostgresConversationStorage.ts,PostgresJobStore.ts,PostgresUpdateDeduplicator.ts,TfxPostgres.ts}`
- Create: `packages/postgres/src/internal/{Identifiers.ts,Tables.ts,SqlErrors.ts,Migrator.ts}`
- Create: `packages/postgres/migrations/0001_tfx_core.ts`
- Create: `packages/postgres/test/{Identifiers.test.ts,Migrations.integration.test.ts,ConversationStorage.integration.test.ts,JobStore.integration.test.ts,Deduplicator.integration.test.ts,Layers.integration.test.ts}`
- Modify: `packages/postgres/package.json`, CI workflow

### Task 1: Identifier options and coordinated migration

- [ ] **Step 1: Write failing validation tests**

Accept `tfx`, `tenant_1`; reject uppercase, dash, quote, leading digit, empty, UTF-8 over 63 bytes, and valid schema/prefix whose composed table exceeds 63 bytes. Prove malicious value never reaches SQL.

- [ ] **Step 2: Implement branded identifiers**

Validate `^[a-z_][a-z0-9_]*$` and PostgreSQL 63-byte limit using UTF-8 bytes. Build identifiers only through SQL identifier-fragment API.

- [ ] **Step 3: Add identifier-safe migration**

`0001_tfx_core.ts` receives validated `Tables` identifier fragments and creates the conceptual schema below through Effect SQL; no raw interpolation/template substitution is allowed, so configured schema/prefix applies to every table and index:

```text
tfx_conversations(bot_id, chat_id, user_id, conversation_id, version, step, state_json, revision, last_update_id, expires_at, created_at, updated_at)
tfx_jobs(id, declaration, payload_version, payload_json, status, conflict_key, attempts, max_attempts, run_at, lease_generation, lease_phase, lease_expires_at, cancellation_requested, quarantine_json, last_error_json, completed_at, failed_at, created_at, updated_at)
tfx_job_attempts(job_id, attempt, lease_generation, started_at, finished_at, outcome, error_json)
tfx_update_deduplication(bot_id, update_id, status, lease_generation, lease_expires_at, outcome_json, attempts, completed_at, created_at, updated_at)
```

Constraints include unique active conversation scope, unique active conflict key via partial index, valid statuses/phases, and `(bot_id,update_id)` dedup key.

- [ ] **Step 4: Test idempotent migration and commit**

Run: `pnpm --filter @tfx/postgres test -- Identifiers.test.ts Migrations.integration.test.ts`
Expected: first and repeated migration PASS; exact tables/indexes exist.

```bash
git add packages/postgres/src/Options.ts packages/postgres/src/internal packages/postgres/migrations packages/postgres/test/Identifiers.test.ts packages/postgres/test/Migrations.integration.test.ts
git commit -m "feat(postgres): add coordinated tfx schema"
```

### Task 2: PostgreSQL conversation storage

- [ ] **Step 1: Run shared suite as failing test**

Wire `conversationStorageConformance(PostgresConversationStorage.layer({ schema: "tfx_test", tablePrefix: "case_" }), {durableRestart:true,multiProcess:true,transactionRollback:true})`.

Expected initial FAIL because Layer missing.

- [ ] **Step 2: Implement row-lock transition**

Inside `PgClient.withTransaction`: select scope `FOR UPDATE`; verify active/revision/last update; decode; run supplied handler with same ambient client; persist transition/revision/update ID; commit. Only then engine runs enter/afterCommit. Finite deadline interrupts and rolls back.

- [ ] **Step 3: Add domain-write rollback probe**

Create test probe table; handler inserts then fails. Assert probe and transition both absent. Two different updates block before second handler; same update returns duplicate without effect.

- [ ] **Step 4: Run and commit**

Run: `pnpm --filter @tfx/postgres test -- ConversationStorage.integration.test.ts`
Expected: conformance plus lock/rollback/restart PASS.

```bash
git add packages/postgres/src/PostgresConversationStorage.ts packages/postgres/test/ConversationStorage.integration.test.ts
git commit -m "feat(postgres): persist conversation transitions"
```

### Task 3: PostgreSQL job store with two-phase claims

- [ ] **Step 1: Wire job conformance and SQL race tests**

Two clients claim same due set; one wins each row. Verify `FOR UPDATE SKIP LOCKED`, conflict replacement, migration reclaim without attempts, atomic promotion with attempts, expired `running` execution reclaim, stale generation rejection, crash-after-send-start race, and job-attempt audit.

- [ ] **Step 2: Implement migration claim**

Atomic update sets `lease_phase='migration'`, increments generation, lease expiry; leaves `status='scheduled'` and attempts unchanged. Live lease excludes claimant. Expired lease can be reclaimed.

- [ ] **Step 3: Implement fenced promotion/quarantine**

Matching token writes migrated payload/version and transitions to `running`,`execution`, increments attempts, inserts attempt row in one transaction. Matching migration token can quarantine without attempt. No other path enters running.

- [ ] **Step 4: Implement execution reclaim and finalization**

Expired `running`+`execution` lease reclaim below max attempts atomically closes prior attempt as `LeaseLost`, returns row to `scheduled`+`migration`, increments generation, grants new migration lease, and does not increment attempts. Next fenced promotion increments attempts exactly once. At max attempts, reclaim closes prior attempt and marks `failed/AttemptsExhausted` without another promotion. Heartbeat, success, retry schedule, failed/quarantine release, cancel, and takeover all compare ID+generation+phase. Partial unique conflict index supports atomic reminder replacement.

- [ ] **Step 5: Run and commit**

Run: `pnpm --filter @tfx/postgres test -- JobStore.integration.test.ts`
Expected: full conformance and multi-client races PASS.

```bash
git add packages/postgres/src/PostgresJobStore.ts packages/postgres/test/JobStore.integration.test.ts
git commit -m "feat(postgres): persist fenced jobs"
```

### Task 4: PostgreSQL update deduplicator

- [ ] **Step 1: Wire dedup conformance and multi-client tests**

Assert one acquire, bounded in-progress observation, heartbeat, expired takeover generation, stale complete/release rejection, completed replay, retention cleanup.

- [ ] **Step 2: Implement durable claims**

Use insert-on-conflict/locked update. Same-process waiters use Deferred only as optimization; polling database remains source of truth. Completion stores closed dispatch outcome. Diagnostics report `{mode:"durable",backend:"postgres"}`.

- [ ] **Step 3: Run and commit**

Run: `pnpm --filter @tfx/postgres test -- Deduplicator.integration.test.ts`
Expected: PASS.

```bash
git add packages/postgres/src/PostgresUpdateDeduplicator.ts packages/postgres/test/Deduplicator.integration.test.ts
git commit -m "feat(postgres): deduplicate Telegram updates"
```

### Task 5: Individual/aggregate Layers and CI

- [ ] **Step 1: Implement aggregate Layer**

`TfxPostgres.layer(options)` merges three adapters; individual `.layer(options)` remain available. All require same external `PgClient.PgClient`; none creates pool.

- [ ] **Step 2: Test one-client transaction sharing**

Provide instrumented PgClient and assert all Layers use it. Merge application SQL write with conversation transition and job scheduling in one transaction, then force rollback.

- [ ] **Step 3: Add PostgreSQL CI service under Node and Bun**

Run migrations and full adapter conformance once per runtime.

- [ ] **Step 4: Export, validate, commit**

Run: `pnpm --filter @tfx/postgres check && pnpm --filter @tfx/postgres test`
Expected: PASS.

Run: `bun x vitest run packages/postgres/test/*.integration.test.ts`
Expected: PASS.

```bash
git add packages/postgres/src/TfxPostgres.ts packages/postgres/src/index.ts packages/postgres/package.json packages/postgres/test/Layers.integration.test.ts .github/workflows/ci.yml
git commit -m "feat(postgres): compose tfx PostgreSQL adapters"
```

## Acceptance criteria

- Adapter package owns no Carneloot table.
- All services use application-provided PgClient and safe identifiers.
- Conversation domain writes and transition roll back together.
- Job migration claim/promotion attempt accounting matches roadmap exactly.
- Dedup leases and stale-token fences pass multi-client tests.
- Individual and aggregate Layers pass Node/Bun real-PostgreSQL validation.

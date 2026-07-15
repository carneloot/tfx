# Slice 1 Jobs, Deduplication, and Memory Stores Implementation Plan

**Goal:** Define storage-neutral durable-job and update-deduplication contracts, closed outcomes, fenced two-phase execution, and explicit memory Layers.

**Architecture:** Job runtime separates migration claim from attempt-consuming execution. Stores own scheduling/claims/fencing; declarations own payload history, retry classification, and handler requirements. Deduplicator uses leased generation tokens with bounded observation of in-progress work.

**Tech Stack:** Effect Schema/Layer/Schedule/Clock/Fiber/Deferred, tfx `VersionedSchema`.

---

## File map

- Create: `packages/tfx/src/{Job.ts,JobStore.ts,JobRuntime.ts,JobOutcome.ts,MemoryJobStore.ts}`
- Create: `packages/tfx/src/{DispatchOutcome.ts,UpdateDeduplicator.ts,MemoryUpdateDeduplicator.ts}`
- Create: `packages/tfx/src/internal/job/{ClaimToken.ts,Retry.ts,Worker.ts}`
- Create: `packages/tfx/test/{Job.test.ts,JobRuntime.test.ts,MemoryJobStore.test.ts,UpdateDeduplicator.test.ts}`
- Create: `packages/tfx/test/types/Job.tst.ts`
- Modify: `packages/tfx/package.json`

### Task 1: Job declarations and closed outcomes

- [ ] **Step 1: Write failing declaration/type tests**

Test literal name, current payload inference from history tail, typed handler error, requirements, explicit retry classifier/schedule, max attempts, stable conflict key, and unknown declaration.

- [ ] **Step 2: Define public model**

```ts
const FeedingReminder = Job.make("feeding-reminder", {
  payload: FeedingReminderPayload,
  error: FeedingReminderError,
  maxAttempts: 5,
  retry: FeedingReminderRetry
})
```

Outcomes are exactly `Succeeded`, `RetryableFailure`, `PermanentFailure`, `FatalFailure`, `Cancelled`, `LeaseLost`. Unclassified typed errors become permanent; defects become fatal with sanitized Cause.

- [ ] **Step 3: Define store records/errors**

Statuses remain `scheduled|running|completed|failed|quarantined|cancelled`. Persist attempts/max, run time, payload/version, conflict key, lease generation/phase/expiry, cancellation request, safe error summary, and outcome timestamps.

- [ ] **Step 4: Run and commit**

Run: `pnpm --filter tfx check && pnpm --filter tfx test -- Job.test.ts`
Expected: PASS.

```bash
git add packages/tfx/src/Job.ts packages/tfx/src/JobOutcome.ts packages/tfx/src/JobStore.ts packages/tfx/test/Job.test.ts packages/tfx/test/types/Job.tst.ts
git commit -m "feat(tfx): define versioned jobs"
```

### Task 2: Two-phase fenced claim and execution runtime

- [ ] **Step 1: Write attempt-accounting tests first**

Required table:

| Event | Attempt delta | Generation |
|---|---:|---:|
| migration claim | 0 | +1 |
| migration crash/lease reclaim | 0 | +1 |
| migration quarantine | 0 | unchanged after completion |
| fenced promotion to running | +1 | same token |
| execution crash/expired-lease reclaim | 0 at reclaim; +1 on next promotion | +1 at reclaim |
| retryable rerun | +1 | +1 |

Also test one/multi-step migration, persisted migrated payload, missing/invalid/newer quarantine, stale token, retries/retryAfter, exhaustion including expired execution at limit, cancel, release, crash after external send starts, and stale-owner completion racing the reclaimed execution.

- [ ] **Step 2: Implement explicit phase protocol**

```text
claimForMigration
  scheduled + due + no live lease
  → status=scheduled, lease_phase=migration, generation++, lease_expiry
  → attempts unchanged
promoteToRunning(token, migratedPayload, currentVersion)
  matching generation + migration phase
  → persist payload/version, status=running, lease_phase=execution, attempts++ atomically
quarantineMigration(token, reason)
  matching generation + migration phase
  → status=quarantined, lease cleared, attempts unchanged
reclaimExpiredExecution
  running + execution phase + expired lease + attempts < max_attempts
  → close prior attempt as LeaseLost, status=scheduled, lease_phase=migration,
    generation++, new lease_expiry, attempts unchanged
  → next matching promoteToRunning increments attempts exactly once
reclaimExpiredExecutionAtLimit
  running + execution phase + expired lease + attempts >= max_attempts
  → close prior attempt as LeaseLost, status=failed, reason=AttemptsExhausted,
    lease cleared, attempts unchanged
```

Current-version and reclaimed jobs traverse migration-claim validation then promotion, preserving one protocol. A crashed `running` row therefore cannot remain stuck, and its stale owner cannot finalize after generation changes.

- [ ] **Step 3: Implement worker**

Claim due work or reclaim expired execution, decode/migrate, promote, heartbeat, execute scoped handler, observe cancellation, and finalize with matching token. Lease loss interrupts local handler; stale token performs no state change. Retryable failure below limit reschedules using `retryAfter` before declaration schedule. External send recovery relies on application delivery fencing: reclaimed job skips recipient deliveries already `sent` or `unknown`.

- [ ] **Step 4: Implement administrative behavior**

Scheduled cancel is immediate; running cancel sets request and heartbeat interrupts. `releaseFailed(id,{reason,resetAttempts})` accepts failed/quarantined only, validates declaration/payload, and reschedules; reset is explicit.

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter tfx test -- JobRuntime.test.ts`
Expected: every attempt/fence/outcome case PASS under TestClock.

```bash
git add packages/tfx/src/JobRuntime.ts packages/tfx/src/internal/job packages/tfx/test/JobRuntime.test.ts
git commit -m "feat(tfx): run jobs with fenced two-phase claims"
```

### Task 3: Memory job store

- [ ] **Step 1: Write parallel memory semantics tests**

Cover scheduling/replacement by conflict key, due ordering, one claimant, migration lease expiry, execution takeover, stale completion, heartbeat, retries, cancellation, quarantine/release, and scope teardown.

- [ ] **Step 2: Implement scoped store**

Use Ref plus semaphore for atomic transitions and TestClock-compatible timestamps. `schedule` replaces only active job with same conflict key and returns replaced ID. No implicit default Layer.

- [ ] **Step 3: Run and commit**

Run: `pnpm --filter tfx test -- MemoryJobStore.test.ts JobRuntime.test.ts`
Expected: PASS.

```bash
git add packages/tfx/src/MemoryJobStore.ts packages/tfx/test/MemoryJobStore.test.ts packages/tfx/package.json
git commit -m "feat(tfx): add memory job store"
```

### Task 4: Update deduplication contract and memory implementation

- [ ] **Step 1: Write claim-state tests**

Test `Acquired(token)`, `Completed(outcome)`, `InProgress(handle)`; bounded waiter; heartbeat; expiry takeover; generation increment; stale complete/release rejection; retryable release; retention; diagnostics.

- [ ] **Step 2: Define dispatch outcomes and required service**

Create closed `DispatchOutcome` here: `Handled`, `HandledWithOutputFailure`, `PermanentInvalid`, `RetryableFailure`, or `Fatal`. Define `CompletedOutcome` as only the first three acknowledgeable variants; retryable/fatal dispatch releases claim and can never be persisted as completed.

```ts
type Claim =
  | { readonly _tag: "Acquired"; readonly token: ClaimToken }
  | { readonly _tag: "Completed"; readonly outcome: CompletedOutcome }
  | { readonly _tag: "InProgress"; readonly await: Effect.Effect<ObservedCompletion> }
```

Use `Context.Service`, never `Context.Reference`. Export explicit `layerNoop` with diagnostics `{ mode:"none", backend:"noop" }`; production can assert durable mode.

- [ ] **Step 3: Implement memory durable-semantics Layer**

Memory implementation supports leases/fences/waiters for conformance but reports `{ mode:"memory", backend:"memory" }`. No-op independently acquires every update and documents duplicate risk.

- [ ] **Step 4: Run and commit**

Run: `pnpm --filter tfx check && pnpm --filter tfx test -- UpdateDeduplicator.test.ts`
Expected: PASS.

```bash
git add packages/tfx/src/DispatchOutcome.ts packages/tfx/src/UpdateDeduplicator.ts packages/tfx/src/MemoryUpdateDeduplicator.ts packages/tfx/test/UpdateDeduplicator.test.ts packages/tfx/package.json
git commit -m "feat(tfx): add fenced update deduplication"
```

## Acceptance criteria

- Migration claim never consumes attempt; only fenced promotion to `running` does.
- Crashes/takeovers, retry classification, exhaustion, cancellation, quarantine, and release are closed/tested.
- Stable conflict key atomically replaces active reminder schedule.
- Deduplicator has no implicit default and stale tokens cannot mutate newer generation.
- Memory Layers implement full contracts and discard state on scope close.

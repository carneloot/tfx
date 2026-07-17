# Slice 1 Bot Runtime and Polling Implementation Plan

**Goal:** Dispatch decoded updates through normalized routing, bounded keyed concurrency, durable deduplication, conversations/commands, and settlement-aware long polling.

**Architecture:** `BotRuntime.layer` installs exactly one branded `UpdateDelivery`; applications never provide internal `UpdateSource`. Runtime normalizes each update once, claims deduplication, partitions work sequentially per key, and maps all behavior to closed `DispatchOutcome` before transport acknowledgement.

**Tech Stack:** Effect Stream/Queue/Fiber/Scope/Schedule, tfx Telegram/bot/conversation/dedup modules.

---

## File map

- Create: `packages/tfx/src/{UpdateDelivery.ts,BotRuntime.ts,Polling.ts}`
- Modify: `packages/tfx/src/DispatchOutcome.ts`
- Create: `packages/tfx/src/{UpdateRoutingScope.ts,Partitioning.ts}`
- Create: `packages/tfx/src/internal/runtime/{Dispatcher.ts,Router.ts,KeyedExecutor.ts,DeduplicatedDispatch.ts}`
- Create: `packages/tfx/src/internal/update-source/{UpdateSource.ts,PollingSource.ts}`
- Create: `packages/tfx/test/{UpdateRoutingScope.test.ts,Partitioning.test.ts,Dispatcher.test.ts,Polling.test.ts,BotRuntime.test.ts}`
- Create: `packages/tfx/test/types/BotRuntime.tst.ts`
- Modify: `packages/tfx/package.json`

### Task 1: Delivery and closed dispatch contracts

- [ ] **Step 1: Write type tests**

Reject missing delivery, arrays/multiple delivery, and direct UpdateSource provision. Verify descriptor Layer error/requirements propagate and `UpdateDeduplicator` remains unresolved until explicit Layer supplied.

- [ ] **Step 2: Define delivery/runtime contracts**

`UpdateDelivery.make({id,layer})` brands one internal source. `BotRuntime.layer(bot,{delivery,partitioning,concurrency,capacity})` requires one descriptor value. Consume closed `DispatchOutcome` defined with deduplication in Plan 5; add transport acknowledgement helpers without widening its variants.

- [ ] **Step 3: Add acknowledgement policy tests**

Acknowledge only handled/output-failure/permanent/completed-dedup. Retryable blocks polling offset; Fatal stops runtime unhealthy.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter tfx check && pnpm --filter tfx test -- BotRuntime.test.ts`
Expected: PASS.

```bash
git add packages/tfx/src/DispatchOutcome.ts packages/tfx/src/UpdateDelivery.ts packages/tfx/src/BotRuntime.ts packages/tfx/test/BotRuntime.test.ts packages/tfx/test/types/BotRuntime.tst.ts
git commit -m "feat(tfx): define bot runtime delivery"
```

### Task 2: Normalize routing scope and partitioning

- [ ] **Step 1: Write fixture matrix**

Cover message, edited/channel post, callback with message, chat-less callback, reaction, inline query, chosen inline result, business connection/message, and update fallback.

- [ ] **Step 2: Implement one normalized union**

```ts
type UpdateRoutingScope =
  | ChatUser | Chat | User | BusinessConnection | Update
```

Every variant includes bot ID. Conversation identity accepts only `ChatUser`; partition keys never masquerade as conversation scope.

- [ ] **Step 3: Implement strategies**

`byChat` prefers bot/chat, then user/business/update. `byConversationScope` uses bot/chat/user when available. Custom function must be total and return hashable stable key.

- [ ] **Step 4: Run and commit**

Run: `pnpm --filter tfx test -- UpdateRoutingScope.test.ts Partitioning.test.ts`
Expected: complete matrix PASS.

```bash
git add packages/tfx/src/UpdateRoutingScope.ts packages/tfx/src/Partitioning.ts packages/tfx/test/UpdateRoutingScope.test.ts packages/tfx/test/Partitioning.test.ts
git commit -m "feat(tfx): normalize update routing"
```

### Task 3: Keyed dispatcher and routing priority

- [ ] **Step 1: Write concurrency tests with latches**

Prove same key executes FIFO with max active 1; unrelated keys overlap up to global bound; queue capacity backpressures; idle groups expire; shutdown interrupts intake then drains/interrupts configured work.

- [ ] **Step 2: Implement Effect-native executor**

Use bounded Queue and `Stream.groupByKey` or equivalent scoped per-key queues/fibers. No Promise pool. Record spans without raw text.

- [ ] **Step 3: Implement route priority**

Order: lifecycle → `/cancelar` → active conversation → command → callback → message/reply → fallback. Slice 1 `/cancelar` cancels active scope, removes reply keyboard, replies `Operação cancelada`; it is not yet full Slice 3 menu/general-command parity.

- [ ] **Step 4: Integrate dedup claim lifecycle**

Acquire before behavior; heartbeat while active; completed skips; in-progress waits bounded; complete/release with matching token. Claim loss interrupts local fiber and returns retryable unless newer completion is observed.

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter tfx test -- Dispatcher.test.ts`
Expected: ordering, concurrency, cancellation, and dedup cases PASS.

```bash
git add packages/tfx/src/internal/runtime packages/tfx/test/Dispatcher.test.ts
git commit -m "feat(tfx): dispatch updates with keyed concurrency"
```

### Task 4: Long-poll source

- [ ] **Step 1: Write startup/retry/offset tests**

Assert `getMe` → `deleteWebhook(drop_pending_updates:false)` → `setMyCommands(language_code:"pt")` → first `getUpdates`; one in flight; default 30s; transport timeout margin; allowed-update inference/override validation; only first call sends allowlist; empty batch loops.

Error cases: 429 honors retry-after; network/5xx follows TestClock schedule; 401/409 terminal. Stop aborts poll and never sends final acknowledgement for unfinished work.

- [ ] **Step 2: Implement batch settlement**

Decode all updates, dispatch with keyed concurrency, await settlement, and compute largest contiguous acknowledgeable update ID. If ID N fails retryably/fatally, never send offset above N even when later updates completed; dedup skips completed items on redelivery.

- [ ] **Step 3: Implement polling descriptor**

`Polling.make(options)` returns branded delivery whose Layer requires Telegram and supplied platform HttpClient through facade. `dropPendingUpdates` defaults false and is used only for webhook deletion.

- [ ] **Step 4: Validate Node and Bun**

Run: `pnpm --filter tfx check && pnpm --filter tfx test -- Polling.test.ts Dispatcher.test.ts BotRuntime.test.ts`
Expected: PASS.

Run: `bun x vitest run packages/tfx/test/Polling.test.ts packages/tfx/test/Dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit polling**

```bash
git add packages/tfx/src/Polling.ts packages/tfx/src/internal/update-source packages/tfx/test/Polling.test.ts packages/tfx/package.json
git commit -m "feat(tfx): add settlement-aware polling"
```

## Acceptance criteria

- Exactly one delivery is enforced by API; UpdateSource stays internal.
- Every update maps through one normalized scope.
- Same-partition updates are sequential and unrelated partitions bounded-concurrent.
- Runtime requires explicit deduplicator.
- Polling publishes menu before first update request and never acknowledges unfinished work.
- Retry/terminal behavior follows typed Telegram reasons.
- Scoped stop leaves unfinished updates eligible for redelivery.

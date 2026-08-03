# Conversation Span Links Implementation Plan

**Goal:** Trace each persisted conversation update as a completed root trace, while linking resumes to its durable start span without keeping a process-lifetime span open.

**Architecture:** Commands stay named roots. Starting a conversation creates a child `Conversation.start` span and persists its span context with a database-generated `instance_id`. Each active-conversation update creates a root `Conversation.<declaration>.<step>` span linked to that stored start span; the resume, durable transition, after-commit output, and next-step prompt remain children. Trace contexts are links only, never parents, so retries/restarts cannot join stale execution contexts.

**Tech Stack:** Effect v4 Tracer/SpanLink, `@tfx/postgres` migrations, PostgreSQL UUIDs, Vitest.

**Status:** Complete. Validated with `pnpm check`, `pnpm test:unit`, and `RUN_TESTCONTAINERS=true pnpm test:integration`.

---

## File map

- Create: `packages/postgres/src/internal/Migration0004.ts` — add durable conversation trace-correlation columns.
- Modify: `packages/postgres/src/Migrations.ts`, `packages/postgres/src/internal/MigrationChecksums.ts` — register migration 4 and checksum.
- Modify: `packages/tfx/src/ConversationStorage.ts` — expose persisted instance/start-span context.
- Modify: `packages/postgres/src/PostgresConversationStorage.ts` — decode, insert, and replace trace context; preserve it across transitions.
- Modify: `packages/tfx/src/Conversations.ts` — trace conversation start/resume and persist start-span context.
- Modify: `packages/tfx/src/BotRouter.ts` — create linked root span for active conversation updates; preserve root command spans.
- Modify: `packages/postgres/test/ConversationStorage.integration.test.ts`, `packages/tfx/test/Conversation.test.ts`, `packages/tfx/test/BotRouter.test.ts` — migration/persistence/span-link coverage.

### Task 1: Persist conversation instance and start-span context

**Files:**
- Create: `packages/postgres/src/internal/Migration0004.ts`
- Modify: `packages/postgres/src/Migrations.ts`
- Modify: `packages/postgres/src/internal/MigrationChecksums.ts`
- Modify: `packages/tfx/src/ConversationStorage.ts`
- Modify: `packages/postgres/src/PostgresConversationStorage.ts`
- Test: `packages/postgres/test/ConversationStorage.integration.test.ts`

- [ ] **Step 1: Add migration 4**

Create `Migration0004.ts` using configured schema/table identifiers:

```ts
export const up = (sql: PgClient.PgClient, tables: Tables) => {
  const schema = sql(tables.schema);
  const conversations = sql(tables.conversations);
  return sql`ALTER TABLE ${schema}.${conversations}
    ADD COLUMN instance_id uuid NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN origin_trace_id text,
    ADD COLUMN origin_span_id text,
    ADD COLUMN origin_span_sampled boolean`;
};
```

`gen_random_uuid()` is already available in project PostgreSQL integration tests. `instance_id` is durable correlation; nullable origin fields allow tracing-disabled/test callers.

- [ ] **Step 2: Register migration and checksum**

Append version 4, name `conversation-trace-context`, in `Migrations.ts`. Generate checksum with:

```bash
sha256sum packages/postgres/src/internal/Migration0004.ts
```

Store resulting digest as `migrationChecksums[4]`. Update every exact migration-ledger assertion.

- [ ] **Step 3: Extend storage row contract**

In `ConversationStorage.ts`, add:

```ts
export interface ConversationTraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;
}

export interface ConversationRow {
  // existing fields
  readonly instanceId: string;
  readonly originTrace: ConversationTraceContext | undefined;
}

export type NewConversationRow = Omit<ConversationRow, 'instanceId' | 'revision'>;
```

Change `create` to accept `NewConversationRow`; PostgreSQL generates `instance_id` and returns it. Callers deliberately supply `originTrace` but never generate instance IDs.

- [ ] **Step 4: Map and preserve columns in PostgreSQL storage**

Update `RowSchema`/`decodeRow` to validate `instance_id` and map nullable origin columns to `originTrace: undefined` unless all three values exist. Include origin columns—but omit `instance_id`—in both `INSERT` paths so PostgreSQL generates it. For `conflict: 'replace'`, omit `instance_id` from the insert columns so `EXCLUDED.instance_id` receives a new default UUID, then set `instance_id`, `origin_trace_id`, `origin_span_id`, and `origin_span_sampled` from `EXCLUDED`; ordinary `transition` updates must not modify them.

- [ ] **Step 5: Add integration assertions**

Create a conversation row, assert returned/loaded `instanceId` is UUID-shaped and `originTrace` round-trips. Create again with `conflict: 'replace'`, assert instance ID and origin context change. Transition row, assert both remain unchanged.

Run:

```bash
RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts packages/postgres/test/ConversationStorage.integration.test.ts
```

Expected: PASS.

### Task 2: Capture start span and link resume roots

**Files:**
- Modify: `packages/tfx/src/Conversations.ts`
- Modify: `packages/tfx/src/BotRouter.ts`
- Test: `packages/tfx/test/Conversation.test.ts`
- Test: `packages/tfx/test/BotRouter.test.ts`

- [ ] **Step 1: Create and persist `Conversation.start` context**

Wrap start persistence/output in `Effect.withSpan('Conversation.start')`. Inside that span, obtain `yield* Effect.currentSpan` and pass its context to storage:

```ts
const span = yield* Effect.currentSpan;
const created = yield* storage.create({
  // existing row fields; instanceId is database-generated
  originTrace: {
    traceId: span.traceId,
    spanId: span.spanId,
    sampled: span.sampled,
  },
}, conflict);
```

Do not add raw startup input, state, scope, chat/user IDs, or output text as span attributes. Database default supplies `instance_id`; use returned `created.instanceId` only for subsequent span annotation.

- [ ] **Step 2: Make active conversation update a linked root**

In `BotRouter` active-conversation path, after loading persisted row and resolving `built`, create an external span only when `row.originTrace` exists:

```ts
const links = row.originTrace === undefined
  ? []
  : [{
      span: Tracer.externalSpan(row.originTrace),
      attributes: {},
    }];

return yield* provideContexts(
  update,
  conversations.resume(built, rawConversationInput(update), {
    scope,
    updateId: update.update_id,
  }),
).pipe(
  Effect.withSpan(`Conversation.${row.conversationId}.${row.step}`, {
    root: true,
    links,
    attributes: {
      conversationInstanceId: row.instanceId,
      conversationId: row.conversationId,
      step: row.step,
      revision: row.revision,
      updateId: update.update_id,
    },
  }),
);
```

Use project's final safe-ID validation before attributes. Attribute names and values must contain stable identifiers only—never persisted state/input/callback data. Keep `Command.<name>` roots unchanged. Do not use `parent: Tracer.externalSpan(...)`; only `links` preserve independent traces.

- [ ] **Step 3: Add child lifecycle spans**

In `Conversations.resume`, add bounded child spans:

```text
Conversation.resume
Conversation.transition
Conversation.afterCommit
Conversation.enter
```

`Conversation.transition` includes only atomic `storage.transition`. `afterCommit` and `enter` remain after successful commit exactly as today; do not move output into transaction. `Conversation.resume` must preserve duplicate/stale/missing behavior.

- [ ] **Step 4: Add tracer tests**

Use `Tracer.make` + `Tracer.NativeSpan` collector. Assert:

- command start root is still `Command.<name>`;
- `Conversation.start` is child of command root;
- resume root is `Conversation.<id>.<step>`;
- resume root has one link to persisted start trace/span;
- `Conversation.resume`, transition, after-commit, and enter are descendants;
- restart/replay behavior and commit-before-output tests still pass;
- every collected attribute excludes input text, state JSON, callback payload, token, and rendered output.

Run:

```bash
pnpm exec vitest run packages/tfx/test/Conversation.test.ts packages/tfx/test/BotRouter.test.ts
```

Expected: PASS.

### Task 3: Validate migration and production tracing contract

**Files:**
- Modify: exact migration-ledger assertions found in test suite
- Test: `apps/carneloot-bot/test/NodeSmoke.test.ts`

- [ ] **Step 1: Run static and focused validation**

```bash
pnpm check
pnpm exec vitest run packages/tfx/test/Conversation.test.ts packages/tfx/test/BotRouter.test.ts packages/tfx/test/Dispatcher.test.ts apps/carneloot-bot/test/NodeSmoke.test.ts
RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts packages/postgres/test/ConversationStorage.integration.test.ts
```

Expected: PASS.

- [ ] **Step 2: Verify telemetry manually**

Restart bot, start a conversation command, then send next input. Inspect roots and link:

```bash
maple traces --service carneloot-bot --since 10m --format table
maple trace <conversation-resume-trace-id>
```

Expected roots include `Command.<name>` and `Conversation.<id>.<step>`; resume trace contains one SpanLink to start trace and lifecycle children.

- [ ] **Step 3: Commit**

```bash
git add packages/tfx packages/postgres apps/carneloot-bot/test
git commit -m "feat(tfx): link persisted conversation traces"
```

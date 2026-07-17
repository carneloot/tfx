# Slice 1 Conversation Kernel Implementation Plan

**Goal:** Implement explicit typed conversation state machines, input/choice/prompt helpers, storage-controlled transitions, migrations, and an explicit complete memory Layer.

**Architecture:** Declarations derive serializable step-state unions; exhaustive builders bind enter/input behavior. `ConversationStorage` owns verify-run-commit ordering through a higher-order transition operation; Telegram output is post-commit and maps failures to `HandledWithOutputFailure` later.

**Tech Stack:** Effect Schema/Layer/Ref/Semaphore/TestClock, tfx bot kernel and keyboards.

---

## File map

- Create: `packages/tfx/src/{VersionedSchema.ts,Conversation.ts,ConversationBuilder.ts,ConversationInput.ts}`
- Create: `packages/tfx/src/{ConversationChoice.ts,ConversationPrompt.ts,ConversationStorage.ts,Conversations.ts,MemoryConversationStorage.ts}`
- Create: `packages/tfx/src/internal/conversation/{Engine.ts,Scope.ts,Transition.ts,PersistedState.ts}`
- Create: `packages/tfx/test/{VersionedSchema.test.ts,Conversation.test.ts,ConversationChoice.test.ts,MemoryConversationStorage.test.ts}`
- Create: `packages/tfx/test/types/{Conversation.tst.ts,ConversationChoice.tst.ts}`
- Modify: `packages/tfx/package.json`

### Task 1: Version histories and declaration types

- [ ] **Step 1: Write failing type/runtime tests**

Cover contiguous versions, duplicate/gap rejection, final payload inference, deterministic one/multi-step migration, missing path, and decode failure. Type-test unknown/missing steps, wrong state for target step, invalid startup input, and incompatible text codecs.

- [ ] **Step 2: Implement local `VersionedSchema`**

Effect checkout has no built-in `VersionedSchema`; create tfx abstraction:

```ts
const V1 = VersionedSchema.version(1, StateV1)
const V2 = VersionedSchema.version(2, StateV2)
const History = VersionedSchema.history(V1).pipe(
  VersionedSchema.to(V2, (v1) => ({ ...v1, renamed: v1.name }))
)
```

Migrations are synchronous deterministic pure functions with no service channel. Construction rejects non-positive, duplicate, or non-contiguous versions.

- [ ] **Step 3: Define conversation declaration**

A declaration fixes ID/version, startup schema, initial step/initializer, step state/input declarations, middleware, optional idle timeout, and migrations. Derived persisted union is `{ step, state }`; callers cannot start at arbitrary internal step.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter tfx check && pnpm --filter tfx test -- VersionedSchema.test.ts Conversation.test.ts`
Expected: PASS.

```bash
git add packages/tfx/src/VersionedSchema.ts packages/tfx/src/Conversation.ts packages/tfx/test/VersionedSchema.test.ts packages/tfx/test/Conversation.test.ts packages/tfx/test/types/Conversation.tst.ts
git commit -m "feat(tfx): declare versioned conversations"
```

### Task 2: Inputs, choices, and prompts

- [ ] **Step 1: Write input and choice tests**

Test message text, callback data, reaction, command inputs; empty choices; duplicate reply labels; duplicate encoded callback values; row/column layout; `Selected`/`Cancelled`; callback acknowledgement; invalid response; and reply-keyboard removal.

- [ ] **Step 2: Implement input constructors**

Text decodes from string and carries decoding requirements; callback/choice carries decoding plus encoding requirements; reaction uses generated Telegram reaction schema. Input declaration determines available context service.

- [ ] **Step 3: Implement choices and yieldable prompt**

```ts
type ChoiceResult<A> =
  | { readonly _tag: "Selected"; readonly value: A }
  | { readonly _tag: "Cancelled" }
```

`ConversationPrompt.choice` fails `EmptyChoiceOptions` before calling Telegram, validates uniqueness, renders immutable keyboard, optionally acknowledges callback, and supports cancellation label/value.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter tfx check && pnpm --filter tfx test -- ConversationChoice.test.ts`
Expected: PASS.

```bash
git add packages/tfx/src/ConversationInput.ts packages/tfx/src/ConversationChoice.ts packages/tfx/src/ConversationPrompt.ts packages/tfx/test/ConversationChoice.test.ts packages/tfx/test/types/ConversationChoice.tst.ts
git commit -m "feat(tfx): add conversation inputs and prompts"
```

### Task 3: Storage contract and transitions

- [ ] **Step 1: Write contract tests with recording storage**

Assert one active `(botId, chatId, userId)`, conflict fail/replace, optimistic revision, last update replay, timeout, complete/cancel, migration, transition deadline, and exact ordering:

```text
lock → verify → handler/domain effect → persist → commit → enter → afterCommit
```

Handler failure must produce rollback; same update must not rerun handler.

- [ ] **Step 2: Define higher-order storage operation**

`transition(scope, updateId, expectedRevision, handler)` receives handler Effect and executes it inside implementation-controlled critical section/transaction. Result distinguishes applied, duplicate, stale-reload, missing, expired, and invariant violation.

- [ ] **Step 3: Implement exhaustive builder and transition API**

Builder requires each step's `enter` and `onInput`; optional invalid-input behavior is typed. Transitions: `to(step,state,{afterCommit})`, `stay`, `complete`, `cancelled`. Target-state type follows literal target step.

- [ ] **Step 4: Implement `Conversations` lifecycle service**

`start(declaration,input,{conflict})`, `cancelCurrent`, `resume`, and runtime routing use normalized chat/user scope supplied by runtime. Starting on chat-less update fails typed `ConversationScopeUnavailable`.

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter tfx check && pnpm --filter tfx test -- Conversation.test.ts`
Expected: PASS.

```bash
git add packages/tfx/src/ConversationBuilder.ts packages/tfx/src/ConversationStorage.ts packages/tfx/src/Conversations.ts packages/tfx/src/internal/conversation packages/tfx/test/Conversation.test.ts
git commit -m "feat(tfx): execute storage-controlled conversations"
```

### Task 4: Complete memory Layer

- [ ] **Step 1: Write memory conformance cases**

Use TestClock and parallel fibers for create/load, conflict, serialization, revision, duplicate update, expiration, migration, cancel/complete, and scope teardown.

- [ ] **Step 2: Implement scoped memory storage**

Map rows by canonical scope and protect each scope with scoped semaphore. Hold semaphore only while processing received update, never while waiting for user. Scope close clears all rows. Explicit Layer only; no Context.Reference/default.

- [ ] **Step 3: Test post-commit output boundary**

Successful state commit followed by failed `enter`/`afterCommit` remains committed and reports output failure; replayed update does not rerun output or handler.

- [ ] **Step 4: Export and commit**

Run: `pnpm --filter tfx check && pnpm --filter tfx test -- MemoryConversationStorage.test.ts Conversation.test.ts`
Expected: PASS.

```bash
git add packages/tfx/src/MemoryConversationStorage.ts packages/tfx/test/MemoryConversationStorage.test.ts packages/tfx/package.json
git commit -m "feat(tfx): add memory conversation storage"
```

## Acceptance criteria

- Conversation state is explicit, serializable, versioned, and exhaustively implemented.
- Storage is always explicitly provided.
- Same update/domain mutation cannot run twice in storage critical section.
- SQL-participating effects can later run inside adapter transaction without handler API change.
- Telegram output happens after commit and failure does not roll back state.
- Empty/duplicate choices fail before invalid keyboard send.
- Memory implementation passes full storage-neutral semantics.

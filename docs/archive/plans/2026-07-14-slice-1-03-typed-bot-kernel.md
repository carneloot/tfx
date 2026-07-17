# Slice 1 Typed Bot Kernel Implementation Plan

**Goal:** Add immutable bot declarations, exhaustive Layer-backed handlers, typed command input, request-scoped middleware services, contextual Telegram helpers, and pure keyboard/callback modules.

**Architecture:** Declaration values mirror Effect HttpApi: pure immutable metadata is separate from implementation Layers. Generic types track known IDs, inputs, declared errors, middleware provisions, and unresolved infrastructure; runtime validation covers cross-fragment collisions.

**Tech Stack:** Effect Context/Layer/Schema, generated Telegram schemas, Vitest compile-time fixtures.

---

## File map

- Create: `packages/tfx/src/{Bot.ts,BotGroup.ts,Command.ts,CommandInput.ts,BotBuilder.ts,Middleware.ts}`
- Create: `packages/tfx/src/{UpdateContext.ts,MessageContext.ts,CallbackQueryContext.ts}`
- Create: `packages/tfx/src/{ReplyKeyboard.ts,InlineKeyboard.ts,CallbackData.ts}`
- Create: `packages/tfx/src/internal/bot/{Declaration.ts,Validation.ts,CommandParser.ts,HandlerRegistry.ts}`
- Create: `packages/tfx/test/{CommandInput.test.ts,CommandParser.test.ts,Middleware.test.ts,Contexts.test.ts,Keyboard.test.ts,CallbackData.test.ts}`
- Create: `packages/tfx/test/types/{BotBuilder.tst.ts,CommandInput.tst.ts,Middleware.tst.ts,Contexts.tst.ts,CallbackData.tst.ts}`
- Modify: `packages/tfx/package.json`, `packages/tfx/src/index.ts`

### Task 1: Immutable declarations and exhaustive builder

- [ ] **Step 1: Write compile-time failures first**

Fixtures assert unknown/missing/duplicate group and command implementations fail, decoded input is inferred, undeclared handler errors fail, and unresolved Layer requirements survive. Use `@ts-expect-error` directly above every intentional failure; run `tsc`, not runtime assertions.

Run: `pnpm --filter tfx check`
Expected: FAIL because declaration modules are missing.

- [ ] **Step 2: Define declaration API**

```ts
const Pets = BotGroup.make("pets")
  .add(Command.make("addPet", { name: "adicionar_pet" }))
const App = Bot.make("Carneloot").add(Pets)
```

Declarations are frozen values; `.add` returns a new value. `Command.make` defaults to `CommandInput.none`. Metadata includes Portuguese menu description/language and required update kinds.

- [ ] **Step 3: Define exhaustive implementation API**

```ts
const PetsLive = BotBuilder.group(App, "pets", (handlers) =>
  handlers.handle("addPet", () => Effect.void)
)
```

Builder closes only when every declaration has one implementation. Handler Layer outputs internal implementation service; infrastructure requirements remain Layer inputs.

- [ ] **Step 4: Add runtime declaration validation**

Reject duplicate Telegram command names, duplicate group IDs, and command names violating Bot API syntax. Include source fragment IDs in errors.

- [ ] **Step 5: Run checks and commit**

Run: `pnpm --filter tfx check && pnpm --filter tfx test -- CommandParser.test.ts`
Expected: PASS.

```bash
git add packages/tfx/src/Bot* packages/tfx/src/Command.ts packages/tfx/src/internal/bot packages/tfx/test/types/BotBuilder.tst.ts packages/tfx/test/CommandParser.test.ts
git commit -m "feat(tfx): add typed bot declarations"
```

### Task 2: `CommandInput`

- [ ] **Step 1: Add type/runtime matrix**

Test `none`, argument, rest, optional, repeated, sequence, map; reject duplicate names, required-after-optional, input-after-rest, multiple rest, and `Schema.Number` encoded as number. Verify decoding requirements propagate but encoding requirements do not.

- [ ] **Step 2: Implement grammar**

```ts
const Input = CommandInput.sequence(
  CommandInput.argument("amount", FoodAmountFromString),
  CommandInput.optional(CommandInput.rest("when", FoodDateTimeFromString))
)
```

Tokenization trims command suffix, preserves rest spacing, and uses `Schema.decodeEffect`. Empty `none` yields `{} as const`.

- [ ] **Step 3: Add Telegram entity-aware matching**

Only `bot_command` entity at offset zero matches. `/x@BotName` matches case-insensitively for current bot; another username and slash-looking text without entity do not.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter tfx check && pnpm --filter tfx test -- CommandInput.test.ts CommandParser.test.ts`
Expected: PASS.

```bash
git add packages/tfx/src/CommandInput.ts packages/tfx/src/internal/bot/CommandParser.ts packages/tfx/test/CommandInput.test.ts packages/tfx/test/CommandParser.test.ts packages/tfx/test/types/CommandInput.tst.ts
git commit -m "feat(tfx): parse typed command input"
```

### Task 3: Middleware service provisioning

- [ ] **Step 1: Write ordering/service tests**

Define `RegisteredUser` providing `CurrentUser` with no request prerequisite and `RequireAdmin` requiring `CurrentUser`, providing `CurrentAdmin`. Reversed order must be compile error. `RegisteredUserLive` requirement for `UserRepository` must remain application Layer input, not declaration requirement.

- [ ] **Step 2: Implement declaration/application semantics**

Middleware tracks literal ID, scope, provided request services, required earlier services, and expected processing error. Ordering is global → group → command/conversation → handler.

- [ ] **Step 3: Test runtime order and commit**

Run: `pnpm --filter tfx check && pnpm --filter tfx test -- Middleware.test.ts`
Expected: exact order and service visibility PASS.

```bash
git add packages/tfx/src/Middleware.ts packages/tfx/test/Middleware.test.ts packages/tfx/test/types/Middleware.tst.ts
git commit -m "feat(tfx): provide middleware services"
```

### Task 4: Contextual Telegram helpers

- [ ] **Step 1: Write request-equivalence tests**

For message/thread/business/callback fixtures, compare each helper's recorded Telegram request to direct facade request. Type fixtures prove `MessageContext` is unavailable to callback-only handlers and vice versa.

- [ ] **Step 2: Implement scoped services**

`UpdateContext` exposes decoded update and normalized IDs. `MessageContext` implements `reply`, `replyToCurrent`, `react`, `editText`, `delete`, `sendChatAction`; `CallbackQueryContext` implements `answer`, `editMessageText`, `deleteMessage`. Helpers perform no retry/dedup/domain logic.

- [ ] **Step 3: Run and commit**

Run: `pnpm --filter tfx check && pnpm --filter tfx test -- Contexts.test.ts`
Expected: PASS.

```bash
git add packages/tfx/src/*Context.ts packages/tfx/test/Contexts.test.ts packages/tfx/test/types/Contexts.tst.ts
git commit -m "feat(tfx): add scoped Telegram contexts"
```

### Task 5: Keyboards and typed callback data

- [ ] **Step 1: Write construction/limit tests**

Test rows, generated callback/URL/Web App buttons, reply options, namespace mismatch, malformed payload, duplicate namespace, 64-byte success, 65-byte failure, and multibyte UTF-8 byte counting.

- [ ] **Step 2: Implement pure immutable builders**

```ts
const PetChoice = CallbackData.make("pet", PetIdFromString)
const keyboard = InlineKeyboard.rows([
  [InlineKeyboard.callback("Rex", yield* PetChoice.encode(petId))]
])
```

Callback codec encoded type must be string; both encoding and decoding service requirements propagate.

- [ ] **Step 3: Export subpaths, verify, commit**

Run: `pnpm --filter tfx check && pnpm --filter tfx test -- Keyboard.test.ts CallbackData.test.ts`
Expected: PASS.

```bash
git add packages/tfx/src/ReplyKeyboard.ts packages/tfx/src/InlineKeyboard.ts packages/tfx/src/CallbackData.ts packages/tfx/test/Keyboard.test.ts packages/tfx/test/CallbackData.test.ts packages/tfx/test/types/CallbackData.tst.ts packages/tfx/package.json
git commit -m "feat(tfx): add typed Telegram keyboards"
```

## Acceptance criteria

- Declaration/builders reject full approved compile-time invalid matrix.
- Command parsing follows Telegram entities and bot username suffix semantics.
- Middleware request requirements and implementation infrastructure remain separate.
- Context helpers emit same requests as Telegram facade and only appear in valid handler kinds.
- Callback data namespaces and UTF-8 byte limit are enforced.
- No mutable registry or grammY compatibility API exists.

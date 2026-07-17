# Slice 2 Message and Reply Routing Implementation Plan

**Goal:** Add typed tfx message-handler declarations, then deliver feeding-reminder replies and exact access-checked reply-based food correction.

**Architecture:** tfx gains minimal immutable message-input declarations and exhaustive builders, dispatched after commands according to approved routing order. Carneloot registers one raw reply-text handler that resolves exact notification identity before exact food-source identity and delegates mutations to transactional application services.

**Tech Stack:** tfx Bot/Builder/Router, Effect Schema, Telegram generated update types, PostgreSQL, Vitest.

---

## File map

- Create: `packages/tfx/src/MessageHandler.ts`
- Create: `packages/tfx/src/MessageInput.ts`
- Create: `packages/tfx/src/MessageHandlerResult.ts`
- Create: `packages/tfx/test/MessageHandler.types.ts`
- Create: `packages/tfx/test/MessageHandler.test.ts`
- Create: `packages/tfx/test/MessageRouting.test.ts`
- Modify: `packages/tfx/src/Bot.ts`
- Modify: `packages/tfx/src/BotGroup.ts`
- Modify: `packages/tfx/src/BotBuilder.ts`
- Modify: `packages/tfx/src/BotRouter.ts`
- Modify: `packages/tfx/src/Polling.ts`
- Modify: `packages/tfx/src/index.ts`
- Modify: `packages/tfx/src/internal/bot/HandlerRegistry.ts`
- Modify: `packages/tfx/package.json`
- Modify: `packages/tfx/test/Bot.types.ts`
- Modify: `packages/tfx/test/BotBuilder.types.ts`
- Modify: `packages/tfx/test/BotBuilder.test.ts`
- Modify: `packages/tfx/test/BotRouter.test.ts`
- Modify: `packages/tfx/test/Polling.test.ts`
- Create: `apps/carneloot-bot/migrations/0008_food_reply_operations.sql`
- Create: `apps/carneloot-bot/src/postgres/Migration0008Sql.ts`
- Create: `apps/carneloot-bot/src/application/RouteFoodReply.ts`
- Create: `apps/carneloot-bot/src/application/CorrectFoodBySource.ts`
- Create: `apps/carneloot-bot/src/bot/FoodReplyHandler.ts`
- Create: `apps/carneloot-bot/test/replies/RouteFoodReply.test.ts`
- Create: `apps/carneloot-bot/test/replies/FoodReplies.e2e.integration.test.ts`
- Modify: `apps/carneloot-bot/src/ports/PetFoodRepository.ts`
- Modify: `apps/carneloot-bot/src/postgres/AppMigrator.ts`
- Modify: `apps/carneloot-bot/src/postgres/PetFoodRepositoryLive.ts`
- Modify: `apps/carneloot-bot/src/bot/Declaration.ts`
- Modify: `apps/carneloot-bot/src/Router.ts`
- Modify: `apps/carneloot-bot/src/DomainLive.ts`
- Modify: `apps/carneloot-bot/test/BotLayers.test.ts`
- Modify: `apps/carneloot-bot/test/MigrationArtifact.test.ts`
- Modify: `apps/carneloot-bot/test/NodeSmoke.test.ts`
- Modify: `apps/carneloot-bot/test/Router.test.ts`
- Modify: `apps/carneloot-bot/test/pet-food/FoodMutations.integration.test.ts`

### Task 1: Define portable message-input declarations

- [ ] **Step 1: Write failing type fixtures**

Prove message declarations retain literal ID, decoded input, declared error, middleware-provided service, and codec decoding requirements. Prove duplicate IDs, unknown handlers, missing handlers, error widening, and non-string text codecs fail through `@ts-expect-error`.

- [ ] **Step 2: Implement `MessageInput`**

Initial constructors:

```ts
export const text: <S extends Schema.ConstraintCodec<any, string, any, any>>(
  codec: S
) => MessageInput<S["Type"], S["DecodingServices"]>

export const replyText: <S extends Schema.ConstraintCodec<any, string, any, any>>(
  codec: S
) => MessageInput<{
  readonly text: S["Type"]
  readonly repliedMessageId: number
}, S["DecodingServices"]>
```

`replyText` matches only ordinary message updates with text and `reply_to_message.message_id`; it does not match edited/channel/callback updates. Decode failures mean declaration did not match and allow later handlers/fallback.

- [ ] **Step 3: Implement declaration/result values**

```ts
export const make: <const Id extends string, I, E, M>(
  id: Id,
  options: {
    readonly input: MessageInput<I, any>
    readonly middleware?: M
    readonly error: E
  }
) => MessageHandler<Id, I, E, M>

export type MessageHandlerResult =
  | { readonly _tag: "Handled" }
  | { readonly _tag: "Unmatched" }
export const handled: MessageHandlerResult
export const unmatched: MessageHandlerResult
```

`Unmatched` permits next message handler/fallback; `Handled` acknowledges normal completion. Errors still map through bot error classifier.

- [ ] **Step 4: Run type/unit tests**

Run: `pnpm --filter tfx test -- MessageHandler.test.ts`
Expected: runtime constructors/matchers PASS.

Run: `pnpm --filter tfx check`
Expected: positive fixtures compile and intentional invalid fixtures remain accepted only under `@ts-expect-error`.

- [ ] **Step 5: Commit declarations**

```bash
git add packages/tfx/src/MessageHandler.ts packages/tfx/src/MessageInput.ts packages/tfx/src/MessageHandlerResult.ts packages/tfx/test/MessageHandler*
git commit -m "feat(tfx): declare typed message handlers"
```

### Task 2: Extend immutable groups and exhaustive builders

- [ ] **Step 1: Write failing group/builder tests**

Add one group with commands and two message handlers. Assert immutability, duplicate message ID rejection, exhaustive implementation, middleware service removal, decoded input, and stable declaration order.

- [ ] **Step 2: Extend `BotGroup`**

Each group contains frozen `commands` and frozen `messageHandlers`. Add `.addMessage(handler)` with duplicate-ID rejection. Existing `.add(command)` API and command menu remain unchanged.

- [ ] **Step 3: Extend `Bot` validation**

Validate duplicate message IDs across independently added groups with clear group names. Message handlers do not appear in Telegram command menu. Bot observed update kinds include `message` when any message handler exists.

- [ ] **Step 4: Extend `BotBuilder`**

Add `.handleMessage(id, handler)` beside `.handle`. Group completion requires every command and message declaration exactly once. Message handler receives decoded input and must return `MessageHandlerResult`; requirements exclude built-in `UpdateContext`, `MessageContext`, and middleware-provided services. Replace command-shaped registry entry with discriminated `CommandHandlerEntry | MessageHandlerEntry`; each carries independent ID/input metadata, and router/polling use exhaustive `_tag` switches so message IDs never collide with command IDs or enter command parsing/menu logic.

- [ ] **Step 5: Run builder tests**

Run: `pnpm --filter tfx test -- BotBuilder.test.ts MessageHandler.test.ts`
Expected: PASS for mixed command/message groups and exhaustive errors.

- [ ] **Step 6: Commit builder support**

```bash
git add packages/tfx/src/Bot.ts packages/tfx/src/BotGroup.ts packages/tfx/src/BotBuilder.ts packages/tfx/src/internal/bot/HandlerRegistry.ts packages/tfx/test
git commit -m "feat(tfx): build message handlers exhaustively"
```

### Task 3: Dispatch message handlers in approved order

- [ ] **Step 1: Write failing routing-order tests**

Prove order: lifecycle, `/cancelar`, active conversation, command, message handlers, fallback. A command that is also a text reply must invoke command only. Active conversation input must not invoke message handler. First `Handled` stops; `Unmatched` continues.

- [ ] **Step 2: Implement registry dispatch**

After command match returns no handler, iterate message entries in bot/group declaration order. Match/decode input, construct `MessageContext`, run middleware, then inspect `MessageHandlerResult`. Do not create `MessageContext` for non-message updates.

- [ ] **Step 3: Infer polling update kinds**

Include `message` when declaration has command, message-text conversation input, or message handler. Explicit `allowed_updates` validation must reject omission of required `message`.

- [ ] **Step 4: Export public modules**

Add root exports and development/publish subpaths for `MessageHandler`, `MessageInput`, and `MessageHandlerResult`; update package checker expectations. No testing helpers become public.

- [ ] **Step 5: Run tfx gates**

Run: `pnpm --filter tfx test -- MessageRouting.test.ts BotRouter.test.ts Polling.test.ts`
Expected: PASS for precedence, context, middleware, and allowed-update inference.

Run: `pnpm --filter tfx build && pnpm --filter tfx check:package`
Expected: package exports resolve from packed output.

- [ ] **Step 6: Commit routing**

```bash
git add packages/tfx/src packages/tfx/package.json packages/tfx/test
git commit -m "feat(tfx): route declared message handlers"
```

### Task 4: Persist reply mutation completion and add exact food-source lookup

- [ ] **Step 1: Write failing migration and SQL/security tests**

Require migration version 8 and exact artifact parity. Create same message ID in two chats/bots and assert lookup sees only exact tuple. Create one `/todos` source with several pets and assert only currently accessible rows return. Revoked/inaccessible rows are absent and undisclosed. Redeliver same reply update and assert persisted prior result is returned without rerunning mutation.

- [ ] **Step 2: Add reply-operation migration**

Create `carneloot.food_reply_operations(bot_id text, update_id bigint, kind text, result_json jsonb, created_at timestamptz, PRIMARY KEY(bot_id, update_id))` with nonempty bot/kind and safe update-ID checks.

Run: `pnpm --filter carneloot-bot migrations:generate`
Expected: Effect generator creates `Migration0008Sql.ts` from canonical migration with exact bytes/checksum.

Run: `pnpm --filter carneloot-bot migrations:check`
Expected: exits 0.

Register version 8 and extend `MigrationArtifact.test.ts`.

- [ ] **Step 3: Extend repository contract**

```ts
readonly lockAccessibleBySourceMessage: (
  actorId: UserId,
  botId: BotId,
  chatId: TelegramChatId,
  messageId: number
) => Effect.Effect<ReadonlyArray<PetFoodEntry>, PetFoodRepositoryError>
```

Live query joins pets and accepted caregiver relationships, accepts owner or accepted caregiver, filters all three source columns, orders by pet ID/entry ID, and locks selected food rows plus pets.

- [ ] **Step 4: Implement `CorrectFoodBySource`**

Within one transaction: resolve current identity; parse correction once; load accessible correlated entries; return `Unrelated` when empty; for each row interpret optional time in that pet timezone using current reply message's Telegram instant, validate duplicate excluding selected row, update; reconcile each distinct pet reminder; return corrected rows. All visible rows commit or roll back together.

- [ ] **Step 5: Add replay ledger to route transaction**

`RouteFoodReply.execute` acquires transaction advisory lock for `(botId, updateId)`, reads `food_reply_operations`, schema-decodes and returns stored result when present, otherwise performs reminder-add or source-correction mutation and inserts sanitized result JSON before commit. Concurrent/redelivered update cannot rerun mutation. Telegram output remains post-commit and may be retried after crash, but domain mutation is replay-safe.

- [ ] **Step 6: Run SQL/application tests**

Run: `pnpm --filter carneloot-bot test -- RouteFoodReply.test.ts`
Expected: bulk correction behavior PASS.

Run: `pnpm --filter carneloot-bot test:integration -- FoodMutations.integration.test.ts -t "source message"`
Expected: exact bot/chat/message and current-access cases PASS.

- [ ] **Step 7: Commit source correction**

```bash
git add apps/carneloot-bot/migrations/0008_food_reply_operations.sql apps/carneloot-bot/src/postgres/Migration0008Sql.ts apps/carneloot-bot/src/postgres/AppMigrator.ts apps/carneloot-bot/src/ports/PetFoodRepository.ts apps/carneloot-bot/src/postgres/PetFoodRepositoryLive.ts apps/carneloot-bot/src/application/CorrectFoodBySource.ts apps/carneloot-bot/test
git commit -m "fix(carneloot): scope reply correction by bot and chat"
```

### Task 5: Route feeding-reminder replies

- [ ] **Step 1: Write failing route tests**

Cover exact sent reminder owner/caregiver delivery; delivery recipient mismatch; failed/unknown delivery; stale/deleted event; revoked caregiver; malformed food input; duplicate food; and successful add/reaction/other-recipient notifications.

- [ ] **Step 2: Implement fixed precedence**

`RouteFoodReply.execute` receives current actor, bot/chat/update/current-message IDs, current Telegram message instant, replied message ID, and text. First call `NotificationRepository.findSentByTelegramMessage`. Handle only `feeding-reminder` event whose delivery recipient equals current actor and event has pet ID. Other event kinds continue to source-message lookup; subscriber forwarding remains Slice 3.

- [ ] **Step 3: Add food from reminder**

Parse required amount plus optional time using normal food syntax. Call `AddFood.execute` for event pet with current reply update/chat/message source and current Telegram message instant. `AddFood` rechecks owner/accepted-caregiver access, schedules next reminder, and schedules silent food-added event transactionally.

- [ ] **Step 4: Define route result**

```ts
export type FoodReplyResult =
  | { readonly _tag: "Unrelated" }
  | { readonly _tag: "ReminderFoodAdded"; readonly entry: PetFoodEntry; readonly pet: Pet }
  | { readonly _tag: "FoodCorrected"; readonly entries: ReadonlyArray<PetFoodEntry> }
  | { readonly _tag: "InvalidInput"; readonly message: string }
```

Domain mutation completes before Telegram output. Invalid matched reply receives format/duplicate/access-safe response and counts handled.

- [ ] **Step 5: Run route tests**

Run: `pnpm --filter carneloot-bot test -- RouteFoodReply.test.ts`
Expected: notification precedence, recipient/access checks, and reminder addition PASS.

### Task 6: Register Carneloot reply handler

- [ ] **Step 1: Add declaration before implementation**

Create `replies` bot group with message ID `foodReply`, `MessageInput.replyText(Schema.String)`, `RegisteredUser`, and `ApplicationError`. Run builder test and expect missing implementation.

- [ ] **Step 2: Implement handler output**

`FoodReplyHandler.handle` reads `CurrentUser`, `UpdateContext`, and `MessageContext`, invokes route, and maps:

```text
Unrelated        → MessageHandlerResult.unmatched
ReminderFoodAdded → reply summary + 👍, then handled
FoodCorrected    → Rações atualizadas com sucesso! + handled
InvalidInput     → safe Portuguese error + handled
```

Output failure maps through existing `TelegramError` handling and never rolls back mutation.

- [ ] **Step 3: Bind group and router**

Add `replyHandlers` built group after command groups. Update menu tests: message group contributes no command. Add new domain/repository errors to closed classifier.

- [ ] **Step 4: Run app unit/type tests**

Run: `pnpm --filter carneloot-bot test -- BotLayers.test.ts Router.test.ts NodeSmoke.test.ts RouteFoodReply.test.ts`
Expected: PASS with exhaustive message handler and unchanged command menu.

- [ ] **Step 5: Commit app routing**

```bash
git add apps/carneloot-bot/src/bot apps/carneloot-bot/src/Router.ts apps/carneloot-bot/test
git commit -m "feat(carneloot): route reminder and food replies"
```

### Task 7: Prove reply security and durability end to end

- [ ] **Step 1: Add real-PostgreSQL scenarios**

Send reminder to owner/caregiver, reply with `50g`, assert food/reminder/food-added notifications. Reply to original single-add source and `/todos` source, assert one/all accessible corrections and reminder rescheduling.

- [ ] **Step 2: Add collision/precedence scenarios**

Create same `message_id` in another chat and bot, assert no cross-record update. Reply while conversation active, assert conversation wins. Send command as reply, assert command wins. Revoke caregiver before reply, assert no mutation.

- [ ] **Step 3: Add duplicate update/output-failure scenarios**

Redeliver same reply update: `food_reply_operations` returns persisted result and mutation runs once. Force Telegram summary/reaction failure after commit: update outcome is handled-with-output-failure; any redelivery may repeat best-effort output but cannot repeat mutation.

- [ ] **Step 4: Run E2E and package gates**

Run: `pnpm --filter carneloot-bot test:integration -- FoodReplies.e2e.integration.test.ts`
Expected: all reply, collision, access, replay, and rescheduling cases PASS.

Run: `pnpm format && pnpm lint && pnpm check && pnpm test:unit`
Expected: repository type-check/unit gate PASS.

- [ ] **Step 5: Commit proof**

```bash
git add apps/carneloot-bot/test/replies packages/tfx/test apps/carneloot-bot/src/DomainLive.ts
git commit -m "test: prove safe food reply routing"
```

## Acceptance criteria

- tfx declarations/builders type-track message inputs, errors, middleware, and requirements.
- Runtime order is lifecycle/cancel/conversation/command/message/fallback.
- Reminder reply identifies event by exact sent bot/chat/message tuple and current recipient.
- Food correction identifies source by exact bot/chat/message tuple and current access.
- Same numeric message ID in another chat/bot cannot mutate unrelated food.
- Reply operation ledger prevents mutation replay after post-commit output failure or crash.
- Corrected latest entries reconcile reminders.
- Generic subscriber forwarding remains absent.

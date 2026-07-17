# Slice 2 Shared Food and `/todos` Implementation Plan

**Goal:** Extend listing/status/single-food workflows to accepted caregivers and add replay-safe `/colocar_racao_todos` plus `/todos` across every accessible pet.

**Architecture:** One `Command` declaration owns canonical `/colocar_racao_todos` plus `/todos` alias, so input, middleware, errors, handler, and menu metadata cannot drift. `AddFood` accepts already-decoded amount plus raw optional local date/time, while `AddFoodToAll` runs bounded per-pet transactions so redelivery replays committed pets through existing `(bot, update, pet)` idempotency.

**Tech Stack:** tfx CommandInput/Conversation, Effect concurrency, PostgreSQL, TestClock, Vitest.

---

## File map

- Modify: `packages/tfx/src/Command.ts`
- Modify: `packages/tfx/src/Bot.ts`
- Modify: `packages/tfx/src/BotRouter.ts`
- Modify: `packages/tfx/test/Bot.test.ts`
- Modify: `packages/tfx/test/BotRouter.test.ts`
- Create: `apps/carneloot-bot/src/domain/pet-food/FoodWhenInput.ts`
- Create: `apps/carneloot-bot/src/application/AddFoodToAll.ts`
- Create: `apps/carneloot-bot/test/pet-food/AddFoodToAll.test.ts`
- Create: `apps/carneloot-bot/test/pet-food/SharedPetFood.e2e.integration.test.ts`
- Modify: `apps/carneloot-bot/src/application/AddFood.ts`
- Modify: `apps/carneloot-bot/src/application/GetFoodStatus.ts`
- Modify: `apps/carneloot-bot/src/application/ListPets.ts`
- Modify: `apps/carneloot-bot/src/domain/pet-food/FoodDateTime.ts`
- Modify: `apps/carneloot-bot/src/bot/Declaration.ts`
- Modify: `apps/carneloot-bot/src/bot/PetHandlers.ts`
- Modify: `apps/carneloot-bot/src/bot/PetFoodHandlers.ts`
- Modify: `apps/carneloot-bot/src/bot/conversations/AddFoodConversation.ts`
- Modify: `apps/carneloot-bot/src/Router.ts`
- Modify: `apps/carneloot-bot/src/DomainLive.ts`
- Modify: `apps/carneloot-bot/test/BotHandlers.test.ts`
- Modify: `apps/carneloot-bot/test/BotLayers.test.ts`
- Modify: `apps/carneloot-bot/test/NodeSmoke.test.ts`
- Modify: `apps/carneloot-bot/test/Router.test.ts`
- Modify: `apps/carneloot-bot/test/pet-food/FoodDateTime.test.ts`
- Modify: `apps/carneloot-bot/test/pet-food/PetFoodApplication.test.ts`
- Modify: `apps/carneloot-bot/test/pet-food/PetFoodCommands.test.ts`
- Modify: `apps/carneloot-bot/test/pet-food/PetFoodConversations.test.ts`

### Task 1: Separate typed amount from pet-local time parsing

- [ ] **Step 1: Write failing parser tests**

Add tests for omitted optional time at `CommandInput.optional`, plus `HH:mm`, `DD/MM HH:mm`, `DD-MM HH:mm`, and four-digit-year forms. `FoodWhenInput` itself rejects an empty string, date without time, mixed date separators, extra tokens, seconds, malformed date, and arbitrary text before any pet lookup. Use Telegram message instant as anchor: omitted date uses message's pet-local date, and time-only later than message local time rolls back one local calendar day. Test delayed processing where `Clock` is one day after Telegram message.

- [ ] **Step 2: Add raw time syntax codec**

Create `FoodWhenInput` as a string-to-string codec that validates only supported syntax; it does not choose timezone or instant:

```ts
const FoodWhenPattern =
  /^(?:\d{2}:\d{2}|\d{2}\/\d{2}(?:\/\d{4})? \d{2}:\d{2}|\d{2}-\d{2}(?:-\d{4})? \d{2}:\d{2})$/u

export const FoodWhenInput = Schema.String.check(
  Schema.isPattern(FoodWhenPattern, {
    message: "Expected HH:mm or DD/MM[/YYYY] HH:mm"
  })
)
```

`CommandInput.optional` represents omitted time, so codec does not need an empty-string branch.

`FoodDateTime.parse` remains responsible for timezone, calendar, DST, and `TestClock` interpretation per pet.

- [ ] **Step 3: Refactor `AddFood` input**

Use this contract:

```ts
export interface ParsedFoodInput {
  readonly amountMg: FoodAmount
  readonly when: string
  readonly messageDate: DateTime.Utc
}
```

Change `execute` arguments to `(access: PetFoodAccess, input: ParsedFoodInput, source: SourceInput)`. Remove duplicate amount decoding from `AddFood`; callers decode once. Change `FoodDateTime.parse` to accept explicit `messageDate: DateTime.Utc`; never derive omitted date from processing clock. Keep source validation and transaction/idempotency behavior.

- [ ] **Step 4: Run parser/application tests**

Run: `pnpm --filter carneloot-bot test -- FoodDateTime.test.ts PetFoodApplication.test.ts`
Expected: PASS with unchanged timezone/DST behavior and typed amount input.

- [ ] **Step 5: Commit input refactor**

```bash
git add apps/carneloot-bot/src/domain/pet-food apps/carneloot-bot/src/application/AddFood.ts apps/carneloot-bot/test/pet-food
git commit -m "refactor(carneloot): separate food amount and local time input"
```

### Task 2: Use actual mutation update/message identity

- [ ] **Step 1: Write failing conversation source test**

Start `/colocar_racao` with update/message A, select pet with B, submit amount with C, then assert stored source is bot/chat/message/update C. Redeliver C and assert one food row and one transition.

- [ ] **Step 2: Remove startup source from amount state**

Conversation startup keeps actor/bot/pet options only. In amount `onInput`, read `UpdateContext.updateId`, `MessageContext.chatId/messageId`, and Telegram `Message.date`; decode seconds-since-epoch to `DateTime.Utc` and pass it as `input.messageDate` to `AddFood.execute`.

- [ ] **Step 3: Preserve post-commit output**

Reply summary and 👍 still run from transition `afterCommit` against amount message C. Failure never advances state; replay never inserts/schedules twice.

- [ ] **Step 4: Run conversation tests**

Run: `pnpm --filter carneloot-bot test -- PetFoodCommands.test.ts PetFoodConversations.test.ts`
Expected: PASS with final-input source identity assertions.

- [ ] **Step 5: Commit source fix**

```bash
git add apps/carneloot-bot/src/bot/conversations/AddFoodConversation.ts apps/carneloot-bot/test/pet-food
git commit -m "fix(carneloot): correlate food with mutation message"
```

### Task 3: Expose accessible pets in existing workflows

- [ ] **Step 1: Write failing shared-access tests**

Cover `/listar_pets`, `/status_racao`, and `/colocar_racao` for owner, accepted caregiver, pending caregiver, rejected caregiver, and revoked caregiver. Assert list format `<name> (cuidando)` only for caregiver role and alphabetical order across roles.

- [ ] **Step 2: Return role-aware list projections**

`ListPets.execute(actorId)` returns:

```ts
export interface ListedPet {
  readonly pet: Pet
  readonly role: "owner" | "caregiver"
}
```

Query/access service deduplicates owned pets even if corrupt duplicate relationship is impossible. Handler renders numbered sorted output and `(cuidando)` suffix only for caregiver role.

- [ ] **Step 3: Generalize status and single-add choices**

`GetFoodStatus` and `startAddFood` use accessible pet list. Owner-only configuration handlers continue `listOwned`. Before status read or food insertion, reauthorize role under transaction.

- [ ] **Step 4: Run shared-access tests**

Run: `pnpm --filter carneloot-bot test -- BotHandlers.test.ts PetFoodCommands.test.ts PetFoodConversations.test.ts`
Expected: PASS for owner/caregiver views and pending/rejected/revoked denial.

- [ ] **Step 5: Commit shared UI**

```bash
git add apps/carneloot-bot/src/application apps/carneloot-bot/src/bot apps/carneloot-bot/test
git commit -m "feat(carneloot): share pet food with accepted caregivers"
```

### Task 4: Add command aliases and declare one all-pet command

- [ ] **Step 1: Write failing tfx alias tests**

In `Bot.test.ts`, require immutable alias storage, invalid alias rejection, canonical/alias collision rejection within and across groups, canonical-first menu output, and one menu row per alias using canonical description. In `BotRouter.test.ts`, dispatch canonical and alias updates—including `@bot_username` suffix—and assert both invoke same handler with same decoded input exactly once.

Run: `pnpm --filter tfx test -- Bot.test.ts BotRouter.test.ts`
Expected: FAIL because `Command.make` has no `aliases` option.

- [ ] **Step 2: Add aliases to `Command.make`**

Extend command model/options:

```ts
export interface Command<
  Id extends string,
  Input extends CommandInput.CommandInput<any, any>,
  ES extends ErrorSchema.ErrorSchema,
  Middlewares extends ReadonlyArray<Middleware.AnyMiddleware> = readonly []
> {
  readonly _tag: "Command"
  readonly id: Id
  readonly name: string
  readonly aliases: ReadonlyArray<string>
  readonly input: Input
  readonly error: ES
  readonly description: string | undefined
  readonly language: string | undefined
  readonly middleware: Middlewares
}

export interface Options<
  Input extends CommandInput.CommandInput<any, any>,
  ES extends ErrorSchema.ErrorSchema,
  Middlewares extends ReadonlyArray<Middleware.AnyMiddleware>
> {
  readonly name: string
  readonly aliases?: ReadonlyArray<string>
  readonly input?: Input
  readonly error: ES
  readonly description?: string
  readonly language?: string
  readonly middleware?: Middlewares
}
```

`Command.make` copies and freezes `aliases`, defaulting to an empty array. Alias values are bare Telegram command names without `/`.

- [ ] **Step 3: Validate, route, and publish aliases**

`Bot.add` validates canonical name and every alias against same Telegram pattern, rejects alias equal to canonical name, duplicate aliases on one command, and collisions against any canonical/alias name in assembled bot. `BotRouter` indexes `[command.name, ...command.aliases]` to same declaration and matches invoked name while retaining one command ID/handler. `Bot.commandMenu` emits canonical row followed by alias rows, all using command description/language metadata, so `/todos` counts among real Telegram menu commands.

- [ ] **Step 4: Add compile-time parser tests and one declaration**

Prove inferred handler input is readonly `{ amount: FoodAmount; when?: string }`; missing amount and malformed time fail parsing; `Schema.Number` remains rejected as text leaf through `@ts-expect-error` fixture.

```ts
export const AddFoodToAllInput = CommandInput.sequence(
  CommandInput.argument("amount", FoodAmount),
  CommandInput.optional(
    CommandInput.rest("when", FoodWhenInput)
  )
)

Command.make("addFoodToAll", {
  name: "colocar_racao_todos",
  aliases: ["todos"],
  description: "Registrar ração para todos os pets",
  input: AddFoodToAllInput,
  middleware: [RegisteredUser],
  error: ApplicationError
})
```

- [ ] **Step 5: Bind one exhaustive handler**

Bind only command ID `addFoodToAll` to `PetFoodHandlers.addFoodToAll`. Update command-menu and builder tests to assert one implementation but two published/matched command names.

- [ ] **Step 6: Run alias/declaration tests**

Run: `pnpm --filter tfx test -- Bot.test.ts BotRouter.test.ts`
Expected: PASS for validation, routing, suffix matching, and menu output.

Run: `pnpm --filter carneloot-bot test -- BotLayers.test.ts NodeSmoke.test.ts PetFoodCommands.test.ts`
Expected: PASS with one command declaration/handler and both command names.

- [ ] **Step 7: Commit alias support**

```bash
git add packages/tfx/src/Command.ts packages/tfx/src/Bot.ts packages/tfx/src/BotRouter.ts packages/tfx/test/Bot.test.ts packages/tfx/test/BotRouter.test.ts apps/carneloot-bot/src/bot/Declaration.ts apps/carneloot-bot/src/Router.ts apps/carneloot-bot/test/BotLayers.test.ts apps/carneloot-bot/test/NodeSmoke.test.ts apps/carneloot-bot/test/pet-food/PetFoodCommands.test.ts
git commit -m "feat(tfx): support command aliases"
```

### Task 5: Implement bounded replay-safe all-pet addition

- [ ] **Step 1: Write failing use-case tests**

Cover no pets; two timezones; amount decoded once; concurrency cap four; setup missing; duplicate; revoked access; mixed domain outcomes; infrastructure failure after one committed pet; redelivery replay; actual actor attribution; and same update producing distinct rows per pet.

- [ ] **Step 2: Define closed per-pet result**

```ts
export type AddFoodToAllItem =
  | { readonly _tag: "Added"; readonly pet: Pet; readonly entry: PetFoodEntry }
  | { readonly _tag: "Replayed"; readonly pet: Pet; readonly entry: PetFoodEntry }
  | { readonly _tag: "SetupMissing"; readonly pet: Pet }
  | { readonly _tag: "Duplicate"; readonly pet: Pet }
  | { readonly _tag: "AccessLost"; readonly pet: Pet }

export interface AddFoodToAllResult {
  readonly items: ReadonlyArray<AddFoodToAllItem>
}
```

Persistence/scheduler failures are not captured as item results; they fail whole handler as retryable so redelivery can replay already committed pets. Wrap each `AddFood.execute` with `Effect.catchTags` mapping only `PetFoodSetupMissing`, `DuplicateFoodEntry`, and `PetAccessDenied` to the three closed item variants; propagate every other error, defect, and interruption. Preserve original accessible-pet order when collecting concurrent results.

- [ ] **Step 3: Implement orchestration**

Load accessible pets once. If empty, return empty result. Run `AddFood.execute` per pet using same source update/chat/message, Telegram message instant, and decoded amount, `Effect.forEach(..., { concurrency: 4 })`. Each call interprets `when` using that pet settings timezone and shared message instant inside its own transaction.

- [ ] **Step 4: Implement output**

Render deterministic summary in pet order:

```text
Ração registrada para 2 pets: Rex, Nina.
Configuração pendente: Bob (início do dia).
Ignorados: Lua (registro duplicado).
```

Treat replay as success, react 👍 when at least one item is Added/Replayed, and use `Você não possui nenhum pet.` for empty access. No success/replay means no reaction.

- [ ] **Step 5: Run use-case tests**

Run: `pnpm --filter carneloot-bot test -- AddFoodToAll.test.ts PetFoodCommands.test.ts`
Expected: PASS for aliases, summaries, bounded concurrency, partial domain results, and retry semantics.

- [ ] **Step 6: Commit `/todos`**

```bash
git add apps/carneloot-bot/src/domain/pet-food/FoodWhenInput.ts apps/carneloot-bot/src/application/AddFoodToAll.ts apps/carneloot-bot/src/bot apps/carneloot-bot/src/Router.ts apps/carneloot-bot/test
git commit -m "feat(carneloot): add food to all accessible pets"
```

### Task 6: Prove shared food flows against PostgreSQL

- [ ] **Step 1: Add end-to-end scenario**

Register owner and caregiver, invite/accept, configure pets in different timezones, run `/todos 50g 08:30`, and assert per-pet UTC instants anchored to command message date, one source key per pet, caregiver actor IDs, reminder replacement, Portuguese summary, and one reaction. Delay update processing past local midnight and assert stored dates still derive from Telegram message instant.

- [ ] **Step 2: Add replay and revocation scenario**

Force one per-pet scheduler persistence failure after earlier pet commits; redeliver same update; assert earlier pet replays and unfinished pet inserts once. Revoke caregiver before another pet transaction and assert access-lost item without write.

- [ ] **Step 3: Run real-PostgreSQL tests**

Run: `pnpm --filter carneloot-bot test:integration -- SharedPetFood.e2e.integration.test.ts PetFood.integration.test.ts`
Expected: PASS for timezone, idempotency, transaction, and revocation cases.

- [ ] **Step 4: Run package gate and commit**

Run: `pnpm format && pnpm lint && pnpm --filter carneloot-bot check && pnpm --filter carneloot-bot test`
Expected: PASS.

```bash
git add apps/carneloot-bot/test/pet-food/SharedPetFood.e2e.integration.test.ts apps/carneloot-bot/src/DomainLive.ts
git commit -m "test(carneloot): prove shared all-pet feeding"
```

## Acceptance criteria

- Accepted caregivers can list, inspect, and feed cared-for pets; pending/rejected users cannot.
- Owner-only food settings remain owner-only.
- `/colocar_racao_todos` and `/todos` share one typed parser and behavior.
- Amount decodes once; timestamp resolves independently per pet timezone.
- Per-pet source key makes partial retry safe.
- Final conversation input supplies stored food source identity.
- No-pet and zero-success outcomes avoid empty/success messages.

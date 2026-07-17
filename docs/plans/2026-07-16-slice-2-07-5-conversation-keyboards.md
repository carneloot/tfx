# Slice 2 Plan 7.5 Conversation Keyboard Completion Implementation Plan

**Goal:** Give every Carneloot conversation step with a finite choice set a typed Telegram reply keyboard, while keeping genuinely free-form values as text input and removing stale keyboards at every free-text or terminal boundary.

**Architecture:** `tfx` remains the single source of keyboard rendering and choice resolution. Plan 7.5 fixes cancellation rendering in `ConversationPrompt`, adds small reply/boolean choice constructors, and introduces one Carneloot conversation UI helper so application conversations stop hand-building Telegram markup. Dynamic choices continue to derive from persisted ID/label snapshots and are revalidated by application services before protected reads or mutations.

**Tech Stack:** tfx `ConversationChoice`/`ConversationPrompt`/`ReplyKeyboard`, Effect 4, Telegram reply markup, Vitest, PostgreSQL E2E fixtures.

---

## Locked UX decisions

1. A step gets a keyboard when every valid response belongs to a finite set known when the prompt is rendered.
2. Pet, caregiver, invitation, food-entry, action, hour, and confirmation selections use reply keyboards.
3. Pet names, usernames, food amounts/timestamps, reminder durations, and IANA timezones remain text inputs when values are open-ended.
4. Dynamic labels are display snapshots only. Selecting a button never authorizes access; existing transactional identity/access rechecks remain unchanged.
5. Dynamic pets, caregivers, invitations, and food entries use one button per row. Duplicate display labels are deterministically suffixed by occurrence (`Rex (1)`, `Rex (2)`), and a domain label equal to `Cancelar` is suffixed so the cancellation row remains unambiguous. Boolean `Sim`/`Não` uses two columns. Day-start hours use four columns. Conditional actions use at most two columns.
6. Selection/action keyboards render `Cancelar` as a final dedicated row. Boolean confirmation keyboards use `Sim`/`Não`; `Não` retains each existing workflow’s semantics—including invitation rejection—and does not get a redundant third button.
7. Selecting `Cancelar` returns `ConversationBuilder.cancelled(...)`, deletes conversation state, replies `Operação cancelada.`, and sends `ConversationPrompt.removeReplyKeyboard` after commit.
8. Global `/cancelar` keeps existing precedence and behavior.
9. Entering a free-text step removes the previous reply keyboard in the same prompt. Every completion, cancellation, empty-result exit, access-loss exit, and output-failure attempt includes keyboard removal.
10. Keyboards are one-time and resized. Plan 7.5 adds no inline keyboard, persistent menu, callback-query, or Slice 3 behavior.
11. Restart means persisted state continues accepting the current step input. Plan 7.5 does not add proactive prompt replay on process startup.
12. Conversation IDs, versions, persisted state schemas, application service contracts, authorization, transaction boundaries, and Portuguese business messages do not change except where prompt wording no longer needs to enumerate options.

## Conversation coverage matrix

| Conversation | Keyboard steps | Text steps that must remove a prior keyboard |
|---|---|---|
| `add-pet` | none | `name` |
| `add-pet-food` | `pet` | `amount` |
| `configure-pet-day-start` | `pet`, `confirm`, `hour` | `timezone` |
| `configure-reminder-delay` | `pet`, `action`, `deleteConfirm` | `duration` |
| `delete-pet` | `pet`, `confirm` | none |
| `invite-pet-caregiver` | `pet` | `username` |
| `list-pet-caregivers` | `pet` | none |
| `pet-caregiver-invitations` | `invitation`, `confirm` | none |
| `remove-pet-caregiver` | `pet`, `caregiver` | none |
| `stop-caring-for-pet` | `pet`, `confirm` | none |
| `correct-pet-food` | `pet`, `entry` | `correction` |
| `delete-pet-food` | `pet`, `entry` | none |

No other Carneloot conversation exists at plan creation time. Any conversation added before Plan 7.5 implementation must be classified by the same finite-choice rule and added to the tests before completion.

## File map

- Create: `apps/carneloot-bot/src/bot/conversations/ConversationUi.ts`
- Create: `apps/carneloot-bot/test/ConversationUi.test.ts`
- Modify: `packages/tfx/src/ConversationChoice.ts`
- Modify: `packages/tfx/src/ConversationPrompt.ts`
- Modify: `packages/tfx/test/ConversationChoice.test.ts`
- Create: `packages/tfx/type-test/ConversationChoice.tst.ts`
- Modify: `apps/carneloot-bot/src/bot/conversations/AddFoodConversation.ts`
- Modify: `apps/carneloot-bot/src/bot/conversations/AddPetConversation.ts`
- Modify: `apps/carneloot-bot/src/bot/conversations/ConfigureDayStartConversation.ts`
- Modify: `apps/carneloot-bot/src/bot/conversations/ConfigureReminderDelayConversation.ts`
- Modify: `apps/carneloot-bot/src/bot/conversations/DeletePetConversation.ts`
- Modify: `apps/carneloot-bot/src/bot/conversations/InviteCaregiverConversation.ts`
- Modify: `apps/carneloot-bot/src/bot/conversations/ListCaregiversConversation.ts`
- Modify: `apps/carneloot-bot/src/bot/conversations/PetInvitationsConversation.ts`
- Modify: `apps/carneloot-bot/src/bot/conversations/RemoveCaregiverConversation.ts`
- Modify: `apps/carneloot-bot/src/bot/conversations/StopCaringConversation.ts`
- Modify: `apps/carneloot-bot/src/bot/conversations/CorrectFoodConversation.ts`
- Modify: `apps/carneloot-bot/src/bot/conversations/DeleteFoodConversation.ts`
- Modify: `apps/carneloot-bot/test/AddPetConversation.test.ts`
- Modify: `apps/carneloot-bot/test/CancelConversation.test.ts`
- Modify: `apps/carneloot-bot/test/caregivers/CaregiverConversations.test.ts`
- Modify: `apps/carneloot-bot/test/caregivers/CaregiverOwnerConversations.test.ts`
- Modify: `apps/carneloot-bot/test/caregivers/CaregiverInviteeConversations.test.ts`
- Modify: `apps/carneloot-bot/test/pet-food/PetFoodConversations.test.ts`
- Modify: `apps/carneloot-bot/test/pet-food/CorrectFoodConversation.test.ts`
- Modify: `apps/carneloot-bot/test/pet-food/DeleteFoodConversation.test.ts`
- Modify: `apps/carneloot-bot/test/e2e/OwnedPetFoodLoop.e2e.test.ts`
- Modify: `apps/carneloot-bot/test/caregivers/CaregiverCommands.e2e.integration.test.ts`
- Modify: `apps/carneloot-bot/test/pet-food/FoodMutationCommands.e2e.integration.test.ts`

### Task 1: Complete reusable tfx reply-choice rendering

- [ ] **Step 1: Write failing cancellation and constructor tests**

Extend `packages/tfx/test/ConversationChoice.test.ts` to assert:

```ts
const choice = ConversationChoice.reply(
	[
		{ label: 'A', value: 1 },
		{ label: 'B', value: 2 },
	],
	{ columns: 2, cancelLabel: 'Cancelar' },
);

expect(await Effect.runPromise(ConversationPrompt.choice(choice))).toMatchObject({
	keyboard: [
		[{ text: 'A' }, { text: 'B' }],
		[{ text: 'Cancelar' }],
	],
	one_time_keyboard: true,
	resize_keyboard: true,
});

expect(
	await Effect.runPromise(ConversationPrompt.resolve(choice, 'Cancelar')),
).toEqual({ _tag: 'Cancelled' });

const confirmation = ConversationChoice.boolean({ yes: 'Sim', no: 'Não' });
expect(await Effect.runPromise(ConversationPrompt.choice(confirmation))).toMatchObject({
	keyboard: [[{ text: 'Sim' }, { text: 'Não' }]],
});
```

Retain empty-option, duplicate-label, duplicate-callback-value, immutability, acknowledgement, and removal assertions.

- [ ] **Step 2: Run focused tfx tests and verify failure**

Run: `pnpm exec vitest run packages/tfx/test/ConversationChoice.test.ts`

Expected: FAIL because `reply`/`boolean` do not exist and `cancelLabel` is not rendered.

- [ ] **Step 3: Add reply and boolean constructors**

Add these exact public constructors to `packages/tfx/src/ConversationChoice.ts`:

```ts
export interface ReplyConfig {
	readonly cancelLabel?: string;
	readonly columns?: number;
}

export const reply = <A>(
	options: ReadonlyArray<Option<A>>,
	config: ReplyConfig = {},
): Choice<A, never> => make(options, config);

export const boolean = (
	labels: {
		readonly yes: string;
		readonly no: string;
		readonly cancelLabel?: string;
	},
	config: Omit<ReplyConfig, 'cancelLabel'> = {},
): Choice<boolean, never> =>
	reply(
		[
			{ label: labels.yes, value: true },
			{ label: labels.no, value: false },
		],
		{
			...config,
			columns: config.columns ?? 2,
			...(labels.cancelLabel === undefined
				? {}
				: { cancelLabel: labels.cancelLabel }),
		},
	);
```

Add type tests proving branded `PetId` values remain typed through `ConversationInput.choice(ConversationChoice.reply(...))` and boolean input resolves as `ChoiceResult<boolean>`.

- [ ] **Step 4: Render cancellation as a dedicated row**

Update `ConversationPrompt.choice` so both reply and inline rendering append cancellation after normal option rows without changing normal column layout:

```ts
const renderedRows = <A, R>(
	declaration: ConversationChoice.Choice<A, R>,
	values: ReadonlyArray<string>,
) => {
	const rows = ConversationChoice.rows(declaration, values);
	return declaration.cancelLabel === undefined
		? rows
		: [
				...rows,
				[
					{
						label: declaration.cancelLabel,
						value: declaration.cancelLabel,
					},
				],
			];
};
```

Use `renderedRows` in both branches of `ConversationPrompt.choice`. Keep `resolve` cancellation precedence before label/callback decoding.

- [ ] **Step 5: Run tfx gates**

Run: `pnpm --filter tfx check && pnpm exec vitest run packages/tfx/test/ConversationChoice.test.ts`

Expected: PASS with exact cancellation row, boolean layout, branded value inference through the package type-test build, duplicate protection, and callback acknowledgement.

- [ ] **Step 6: Commit tfx primitives**

```bash
git add packages/tfx/src/ConversationChoice.ts packages/tfx/src/ConversationPrompt.ts packages/tfx/test/ConversationChoice.test.ts packages/tfx/type-test/ConversationChoice.tst.ts
git commit -m "fix(tfx): complete reply choice keyboards"
```

### Task 2: Centralize Carneloot conversation UI output

- [ ] **Step 1: Write failing UI helper tests**

Create `apps/carneloot-bot/test/ConversationUi.test.ts` with a recorded `MessageContext` and assert these exact payloads:

```ts
expect(choiceOutput).toEqual({
	text: 'Escolha:',
	options: {
		reply_markup: {
			keyboard: [
				[{ text: 'A' }, { text: 'B' }],
				[{ text: 'Cancelar' }],
			],
			one_time_keyboard: true,
			resize_keyboard: true,
		},
	},
});

expect(textOutput).toEqual({
	text: 'Digite:',
	options: { reply_markup: { remove_keyboard: true } },
});
```

Also assert ordinary `reply('texto')` sends no markup, Telegram failures remain in the typed failure channel, duplicate labels become `Rex (1)`/`Rex (2)`, and an option originally labelled `Cancelar` is disambiguated from the reserved cancellation row.

- [ ] **Step 2: Run helper test and verify failure**

Run: `pnpm exec vitest run apps/carneloot-bot/test/ConversationUi.test.ts`

Expected: FAIL because `ConversationUi.ts` does not exist.

- [ ] **Step 3: Implement shared output helpers**

Create `apps/carneloot-bot/src/bot/conversations/ConversationUi.ts`:

```ts
import * as Effect from 'effect/Effect';
import { ConversationPrompt, MessageContext } from 'tfx';
import type * as ConversationChoice from 'tfx/ConversationChoice';

export const uniqueReplyOptions = <A>(
	options: ReadonlyArray<ConversationChoice.Option<A>>,
): ReadonlyArray<ConversationChoice.Option<A>> => {
	const totals = new Map<string, number>();
	for (const option of options)
		totals.set(option.label, (totals.get(option.label) ?? 0) + 1);
	const seen = new Map<string, number>();
	return options.map((option) => {
		const occurrence = (seen.get(option.label) ?? 0) + 1;
		seen.set(option.label, occurrence);
		return (totals.get(option.label) ?? 0) > 1 || option.label === 'Cancelar'
			? { ...option, label: `${option.label} (${occurrence})` }
			: option;
	});
};

export const reply = (text: string) =>
	Effect.flatMap(MessageContext.MessageContext, (context) =>
		context.reply(text),
	).pipe(Effect.asVoid);

export const replyRemovingKeyboard = (text: string) =>
	Effect.flatMap(MessageContext.MessageContext, (context) =>
		context.reply(text, {
			reply_markup: ConversationPrompt.removeReplyKeyboard,
		}),
	).pipe(Effect.asVoid);

export const promptChoice = <A, R>(
	text: string,
	declaration: ConversationChoice.Choice<A, R>,
) =>
	Effect.gen(function* () {
		const context = yield* MessageContext.MessageContext;
		const markup = yield* ConversationPrompt.choice(declaration).pipe(
			Effect.orDie,
		);
		yield* context.reply(text, { reply_markup: markup });
	}).pipe(Effect.asVoid);
```

Reply choices have already been synchronously validated and have no callback encoder, so rendering cannot produce an expected application error. Callback choices must not use this helper unless their rendering errors are added truthfully to the caller’s error schema.

- [ ] **Step 4: Add one cancellation transition pattern**

Every migrated conversation handles a visible cancellation result with this exact shape rather than treating it as invalid input:

```ts
if (selected._tag === 'Cancelled')
	return ConversationBuilder.cancelled({
		afterCommit: ConversationUi.replyRemovingKeyboard('Operação cancelada.'),
	});
```

Do not create a generic transition helper; keeping transition construction in each conversation preserves concrete Effect error/context inference.

- [ ] **Step 5: Run helper tests and package check**

Run: `pnpm exec vitest run apps/carneloot-bot/test/ConversationUi.test.ts && pnpm --filter carneloot-bot check`

Expected: PASS with one canonical rendering/removal path and no widened conversation error/context.

- [ ] **Step 6: Commit UI helper**

```bash
git add apps/carneloot-bot/src/bot/conversations/ConversationUi.ts apps/carneloot-bot/test/ConversationUi.test.ts
git commit -m "refactor(carneloot): centralize conversation keyboards"
```

### Task 3: Retrofit owned-pet food configuration conversations

- [ ] **Step 1: Add failing transcript markup assertions**

Extend `apps/carneloot-bot/test/pet-food/PetFoodConversations.test.ts` and `apps/carneloot-bot/test/AddPetConversation.test.ts` to record full `reply` options and assert:

- `add-pet` name prompt removes any stale keyboard and still accepts free text;
- `add-pet-food.pet` renders accessible pets plus final `Cancelar` row;
- `add-pet-food.amount` removes the pet keyboard;
- `configure-pet-day-start.pet` renders pets plus `Cancelar`;
- `configure-pet-day-start.confirm` renders `Alterar` plus `Cancelar`;
- `configure-pet-day-start.hour` renders `0h` through `23h` in six four-button rows plus `Cancelar`;
- `configure-pet-day-start.timezone` removes the hour keyboard;
- `configure-reminder-delay.pet` renders pets plus `Cancelar`;
- no existing delay renders `Definir` plus `Cancelar`;
- existing delay renders `Alterar`, `Excluir`, then `Cancelar`;
- `duration` removes the action keyboard;
- `deleteConfirm` renders `Confirmar` plus `Cancelar`;
- invalid choices emit the existing validation reply and then re-enter with the same keyboard;
- cancellation deletes state, sends removal markup once, and performs no domain mutation;
- successful add-pet, add-food, day-start, reminder-set, and reminder-delete terminal replies all include removal markup, even when the preceding free-text prompt already removed the keyboard.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm exec vitest run apps/carneloot-bot/test/AddPetConversation.test.ts apps/carneloot-bot/test/pet-food/PetFoodConversations.test.ts`

Expected: FAIL because older choice steps send text-only prompts and free-text boundaries retain stale keyboards.

- [ ] **Step 3: Migrate add-food pet selection**

In `AddFoodConversation.ts`, build pet choices from persisted state:

```ts
const petChoice = (state: typeof PetState.Type) =>
	ConversationChoice.reply(
		ConversationUi.uniqueReplyOptions(
			state.pets.map((pet) => ({ label: pet.name, value: pet.id })),
		),
		{ cancelLabel: 'Cancelar' },
	);
```

Render with `ConversationUi.promptChoice('Escolha o pet:', petChoice(state))`, resolve the selected label through `ConversationPrompt.resolve`, handle `Cancelled`, then locate the chosen persisted pet by ID before existing authorization/settings logic. Keep the `amount` step as `ConversationInput.text`; its enter reply uses `replyRemovingKeyboard`.

- [ ] **Step 4: Migrate day-start finite choices**

Use these declarations in `ConfigureDayStartConversation.ts`:

```ts
const alterChoice = ConversationChoice.reply(
	[{ label: 'Alterar', value: 'alter' as const }],
	{ cancelLabel: 'Cancelar' },
);

const hourChoice = ConversationChoice.reply(
	Array.from({ length: 24 }, (_, hour) => ({
		label: `${hour}h`,
		value: hour,
	})),
	{ columns: 4, cancelLabel: 'Cancelar' },
);
```

Pet remains a dynamic text-backed choice resolved from state. `confirm` and `hour` may use `ConversationInput.choice` because their declarations are static. Convert selected hour directly to `LocalTime`; remove the regex parser. Keep `timezone` as text and remove the keyboard when prompting.

- [ ] **Step 5: Migrate reminder finite choices**

In `ConfigureReminderDelayConversation.ts`, use a dynamic action declaration so impossible actions are never rendered:

```ts
const actionChoice = (currentDelayMs: number | null) =>
	ConversationChoice.reply(
		currentDelayMs === null
			? [{ label: 'Definir', value: 'define' as const }]
			: [
					{ label: 'Alterar', value: 'change' as const },
					{ label: 'Excluir', value: 'delete' as const },
				],
		{ columns: 2, cancelLabel: 'Cancelar' },
	);

const deleteChoice = ConversationChoice.reply(
	[{ label: 'Confirmar', value: true }],
	{ cancelLabel: 'Cancelar' },
);
```

Pet/action remain dynamic text-backed choices resolved with `ConversationPrompt.resolve`. `deleteConfirm` uses `ConversationInput.choice(deleteChoice)`. Keep duration parsing unchanged and remove the keyboard in its prompt.

- [ ] **Step 6: Preserve access and transaction behavior**

For every migrated pet selection, retain current `authorize(...)` call before protected settings reads. Final configuration services continue locking/rechecking inside their existing PostgreSQL transactions. Button values come only from persisted IDs; never store repository objects in state. Use `ConversationUi.replyRemovingKeyboard` for every successful, cancelled, access-lost, setup-warning terminal exit and for every prompt entering a free-text step.

- [ ] **Step 7: Run focused tests and check**

Run: `pnpm exec vitest run apps/carneloot-bot/test/AddPetConversation.test.ts apps/carneloot-bot/test/pet-food/PetFoodConversations.test.ts apps/carneloot-bot/test/CancelConversation.test.ts`

Run: `pnpm --filter carneloot-bot check`

Expected: PASS for exact keyboard rows, invalid re-entry, cancellation, free-text removal, restart, access loss, output failure, and unchanged mutations.

- [ ] **Step 8: Commit owned-pet keyboard retrofit**

```bash
git add apps/carneloot-bot/src/bot/conversations/AddPetConversation.ts apps/carneloot-bot/src/bot/conversations/AddFoodConversation.ts apps/carneloot-bot/src/bot/conversations/ConfigureDayStartConversation.ts apps/carneloot-bot/src/bot/conversations/ConfigureReminderDelayConversation.ts apps/carneloot-bot/test/AddPetConversation.test.ts apps/carneloot-bot/test/CancelConversation.test.ts apps/carneloot-bot/test/pet-food/PetFoodConversations.test.ts
git commit -m "feat(carneloot): add keyboards to food setup flows"
```

### Task 4: Normalize pet and caregiver conversation keyboards

- [ ] **Step 1: Add failing keyboard contract tests**

Extend caregiver conversation tests to assert exact rows and removal for:

- delete-pet pet selection: one pet per row, final `Cancelar`;
- delete-pet confirmation: one row containing `Sim`, `Não`;
- invite-caregiver pet selection plus `Cancelar`, followed by username prompt with removal;
- list-caregivers pet selection plus `Cancelar`, followed by terminal removal;
- invitation selection plus `Cancelar`, followed by `Sim`/`Não`;
- remove-caregiver pet and caregiver selections, each with `Cancelar`;
- stop-caring pet selection plus `Cancelar`, followed by `Sim`/`Não`;
- every empty/access-lost/success/no/cancel terminal reply removes keyboard;
- invalid forged labels stay and re-render the same keyboard;
- output failure does not roll back the already committed transition or domain mutation.

- [ ] **Step 2: Run caregiver tests and verify failure**

Run: `pnpm exec vitest run apps/carneloot-bot/test/caregivers/CaregiverConversations.test.ts apps/carneloot-bot/test/caregivers/CaregiverOwnerConversations.test.ts apps/carneloot-bot/test/caregivers/CaregiverInviteeConversations.test.ts`

Expected: FAIL because current manual markup omits visible cancellation in several flows and does not consistently remove keyboards before text/terminal output.

- [ ] **Step 3: Replace manual markup with canonical rendering**

In all six caregiver/pet-management conversation files:

- replace object literals containing `keyboard`, `one_time_keyboard`, and `resize_keyboard` with `ConversationUi.promptChoice`;
- pass every dynamic option array through `ConversationUi.uniqueReplyOptions`, then use `ConversationChoice.reply(..., { cancelLabel: 'Cancelar' })`;
- use `ConversationChoice.boolean({ yes: 'Sim', no: 'Não' })` for confirmation;
- use `ConversationPrompt.resolve(choice(state), value)` for dynamic options;
- use `ConversationInput.choice(staticChoice)` for static confirmation;
- map `Cancelled` to `ConversationBuilder.cancelled` with terminal removal;
- preserve each existing `false` confirmation path: delete-pet and stop-caring complete unchanged, while invitation response persists rejection and performs its existing post-commit output;
- keep selected IDs and labels in state and retain all current authorization rechecks.

- [ ] **Step 4: Remove keyboards at free-text and terminal boundaries**

`InviteCaregiverConversation.username.enter` uses `replyRemovingKeyboard`. List completion, empty caregiver/invitation collections, access-loss exits, successful mutations, rejection/no answers, and notification-output attempts all send removal markup. Do not move Telegram DMs into transactions; they remain `afterCommit`.

- [ ] **Step 5: Run caregiver unit and PostgreSQL E2E tests**

Run: `pnpm exec vitest run apps/carneloot-bot/test/caregivers/CaregiverConversations.test.ts apps/carneloot-bot/test/caregivers/CaregiverOwnerConversations.test.ts apps/carneloot-bot/test/caregivers/CaregiverInviteeConversations.test.ts`

Run: `RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts apps/carneloot-bot/test/caregivers/CaregiverCommands.e2e.integration.test.ts`

Expected: PASS with unchanged relationship semantics plus exact keyboard payloads/removal.

- [ ] **Step 6: Commit caregiver keyboard normalization**

```bash
git add apps/carneloot-bot/src/bot/conversations/DeletePetConversation.ts apps/carneloot-bot/src/bot/conversations/InviteCaregiverConversation.ts apps/carneloot-bot/src/bot/conversations/ListCaregiversConversation.ts apps/carneloot-bot/src/bot/conversations/PetInvitationsConversation.ts apps/carneloot-bot/src/bot/conversations/RemoveCaregiverConversation.ts apps/carneloot-bot/src/bot/conversations/StopCaringConversation.ts apps/carneloot-bot/test/caregivers
git commit -m "feat(carneloot): normalize caregiver keyboards"
```

### Task 5: Normalize correction and deletion keyboards

- [ ] **Step 1: Add failing exact-markup tests**

Extend correction/deletion tests to assert:

```text
pet keyboard: one accessible pet per row, then Cancelar
entry keyboard: one localized entry per row, then Cancelar
correction prompt: remove_keyboard = true
all terminal replies: remove_keyboard = true
```

Keep existing empty-day, invalid correction, restart, revocation, transaction rollback, message-date anchor, and output-failure assertions.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm exec vitest run apps/carneloot-bot/test/pet-food/CorrectFoodConversation.test.ts apps/carneloot-bot/test/pet-food/DeleteFoodConversation.test.ts`

Expected: FAIL because current conversations hand-build keyboards and correction does not remove the entry keyboard before free text.

- [ ] **Step 3: Use shared rendering and typed cancellation**

In both conversations, replace local `choice`/`prompt`/keyboard helpers with:

```ts
ConversationChoice.reply(ConversationUi.uniqueReplyOptions(options), {
	cancelLabel: 'Cancelar',
	columns: 1,
});
```

Resolve dynamic choices through `ConversationPrompt.resolve`. Treat `Cancelled` as a cancelled transition, not a selected sentinel string. In correction, prompt the free-text step with `ConversationUi.replyRemovingKeyboard`. In deletion, every success/empty/access-loss/missing-entry terminal path removes keyboard.

- [ ] **Step 4: Run focused and E2E tests**

Run: `pnpm exec vitest run apps/carneloot-bot/test/pet-food/CorrectFoodConversation.test.ts apps/carneloot-bot/test/pet-food/DeleteFoodConversation.test.ts`

Run: `RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts apps/carneloot-bot/test/pet-food/FoodMutationCommands.e2e.integration.test.ts`

Expected: PASS with unchanged mutation/reminder behavior and exact keyboard lifecycle.

- [ ] **Step 5: Commit mutation keyboard normalization**

```bash
git add apps/carneloot-bot/src/bot/conversations/CorrectFoodConversation.ts apps/carneloot-bot/src/bot/conversations/DeleteFoodConversation.ts apps/carneloot-bot/test/pet-food/CorrectFoodConversation.test.ts apps/carneloot-bot/test/pet-food/DeleteFoodConversation.test.ts apps/carneloot-bot/test/pet-food/FoodMutationCommands.e2e.integration.test.ts
git commit -m "refactor(carneloot): normalize food mutation keyboards"
```

### Task 6: Prove keyboard lifecycle through decoded Telegram updates

- [ ] **Step 1: Preserve reply markup in E2E recorders**

Update owned-pet, caregiver, and food-mutation Telegram recorders to store both message text and `reply_markup` rather than flattening requests to text. Keep existing text assertions unchanged by exposing helpers that select recorded text separately.

- [ ] **Step 2: Add representative update-driven keyboard scenarios**

Assert through decoded updates and real conversation storage:

1. `/colocar_racao` sends pet keyboard, selected pet transitions to amount prompt with removal, and final reply remains keyboard-free;
2. `/configurar_inicio_dia` sends pet, action, and 24-hour keyboards, then removes before timezone;
3. caregiver invitation sends pet keyboard, removes before username, and global `/cancelar` removes any active keyboard;
4. food correction sends pet and entry keyboards, removes before correction text, and success removes keyboard;
5. persisted conversation survives Layer rebuild and accepts a valid button label for its current step;
6. forged labels do not mutate state/domain data and re-render the same finite choices;
7. visible `Cancelar` and global `/cancelar` each delete one conversation row and perform no domain write.

- [ ] **Step 3: Run update-driven suites**

Run: `pnpm exec vitest run apps/carneloot-bot/test/e2e/OwnedPetFoodLoop.e2e.test.ts`

Run: `RUN_TESTCONTAINERS=true pnpm exec vitest run --config vitest.integration.config.ts apps/carneloot-bot/test/caregivers/CaregiverCommands.e2e.integration.test.ts apps/carneloot-bot/test/pet-food/FoodMutationCommands.e2e.integration.test.ts`

Expected: PASS with exact Telegram markup and unchanged PostgreSQL state transitions.

- [ ] **Step 4: Commit E2E proof**

```bash
git add apps/carneloot-bot/test/e2e/OwnedPetFoodLoop.e2e.test.ts apps/carneloot-bot/test/caregivers/CaregiverCommands.e2e.integration.test.ts apps/carneloot-bot/test/pet-food/FoodMutationCommands.e2e.integration.test.ts
git commit -m "test(carneloot): prove conversation keyboard lifecycle"
```

### Task 7: Run Slice 2 Plan 7.5 gates

- [ ] **Step 1: Audit every conversation against the matrix**

Run:

```bash
rg "Conversation.make" apps/carneloot-bot/src/bot/conversations
rg "keyboard:|one_time_keyboard|resize_keyboard" apps/carneloot-bot/src/bot/conversations
rg "ConversationUi.promptChoice|replyRemovingKeyboard" apps/carneloot-bot/src/bot/conversations
```

Expected: every finite-choice step in the coverage matrix uses `ConversationUi.promptChoice`; no conversation hand-builds reply-keyboard markup; every free-text boundary after a choice uses removal.

- [ ] **Step 2: Run all conversation tests**

Run:

```bash
pnpm exec vitest run \
  packages/tfx/test/ConversationChoice.test.ts \
  apps/carneloot-bot/test/ConversationUi.test.ts \
  apps/carneloot-bot/test/AddPetConversation.test.ts \
  apps/carneloot-bot/test/CancelConversation.test.ts \
  apps/carneloot-bot/test/caregivers/CaregiverConversations.test.ts \
  apps/carneloot-bot/test/caregivers/CaregiverOwnerConversations.test.ts \
  apps/carneloot-bot/test/caregivers/CaregiverInviteeConversations.test.ts \
  apps/carneloot-bot/test/pet-food/PetFoodConversations.test.ts \
  apps/carneloot-bot/test/pet-food/CorrectFoodConversation.test.ts \
  apps/carneloot-bot/test/pet-food/DeleteFoodConversation.test.ts
```

Expected: PASS for rendering, selection, invalid input, cancellation, restart, access loss, transaction rollback, and output failure.

- [ ] **Step 3: Run PostgreSQL and package gates**

Run:

```bash
RUN_TESTCONTAINERS=true pnpm test:integration
pnpm format
pnpm lint
pnpm check
pnpm test
```

Expected: all integration, formatting, lint, type, and unit gates PASS.

- [ ] **Step 4: Run fresh review**

Review every conversation against the finite-choice rule. Reject any manual Telegram keyboard object, missing visible cancellation on selection/action keyboards, stale keyboard on free-text/terminal output, weakened authorization check, changed transaction boundary, or assertion that inspects text without required markup.

- [ ] **Step 5: Commit final fixes**

```bash
git add packages/tfx apps/carneloot-bot
git commit -m "fix(carneloot): complete conversation keyboard coverage"
```

Skip this commit when review requires no follow-up changes.

## Acceptance criteria

- Every finite-choice conversation step identified in the coverage matrix renders a Telegram reply keyboard.
- Free-form name, username, amount/time, duration, and timezone inputs remain text-based.
- Dynamic selections preserve branded/domain IDs, deterministically disambiguate duplicate/reserved labels, and never replace current authorization rechecks.
- Selection/action keyboards visibly include `Cancelar`; boolean confirmations render `Sim` and `Não` together.
- Day-start hours render `0h` through `23h` in a compact four-column layout.
- Cancellation, completion, empty-result, access-loss, and free-text transitions remove stale reply keyboards.
- Invalid or forged labels perform no mutation and re-render the current keyboard.
- Restarted conversations accept the persisted current step’s valid button labels.
- No Carneloot conversation hand-builds `keyboard`, `one_time_keyboard`, or `resize_keyboard` markup.
- Existing transaction, reminder, caregiver, replay, and output-failure semantics remain unchanged.
- Unit tests assert exact markup; update-driven tests prove keyboard lifecycle; full PostgreSQL and package gates pass.

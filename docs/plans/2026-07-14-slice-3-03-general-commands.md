# Slice 3 General Commands Implementation Plan

**Goal:** Deliver remaining user-facing general commands, cancellation parity, `hello` easter egg, and exact 24-command Portuguese menu.

**Architecture:** Add one `general` TFX group with typed command inputs and one message handler. Keep stateless command calculations in pure helpers; handlers only read TFX context and send replies. `/gerar_chave` stays outside this plan because it depends on API-key persistence in notification plan.

**Tech Stack:** TypeScript, Effect v4, TFX, Vitest.

**Dependency order:** Complete `2026-07-14-slice-3-02-notifications-api-keys.md` Task 3 before this plan's Task 4/final verification, because it adds registered `/gerar_chave`, command number 24.

---

## File map

- Modify: `apps/carneloot-bot/src/bot/Declaration.ts` — General command/message declarations and menu source.
- Create: `apps/carneloot-bot/src/bot/GeneralHandlers.ts` — named Effect workflows plus pure WhatsApp/coffee formatting helpers.
- Modify: `apps/carneloot-bot/src/bot/CancelConversation.ts` — unconditional parity response and keyboard removal.
- Modify: `apps/carneloot-bot/src/Router.ts` — bind `general` group before existing account/pet groups.
- Create: `apps/carneloot-bot/test/GeneralCommands.test.ts` — command/message transcript tests and pure formatter cases.
- Modify: `apps/carneloot-bot/test/CancelConversation.test.ts` — exact cancellation contract outside and inside conversations.
- Modify: `apps/carneloot-bot/test/Router.test.ts` — declaration routing and menu assertions.
- Modify: `apps/carneloot-bot/package.json`, `pnpm-lock.yaml` — add `js-quantities` and `table` only if no local unit/table helper can reproduce legacy accepted syntax/output.

### Task 1: Lock general-command declaration and menu contract

**Files:**
- Modify: `apps/carneloot-bot/src/bot/Declaration.ts`
- Test: `apps/carneloot-bot/test/Router.test.ts`

- [ ] **Step 1: Write failing menu/declaration tests**

Assert `menuCommands` has exactly 24 names including alias `todos`, contains `start`, and contains none of `_`, `__`, `___`. Assert `start`, `cancel`, `ping`, `whats`, `cafe`, `cafeInv`, and `hello` are registered handlers.

```ts
expect(menuCommands.map(({ command }) => command)).toStrictEqual([
  'start', 'cancelar', 'ping', 'whats', 'cafe', 'cafe_inv',
  'cadastrar', 'adicionar_pet', 'listar_pets', 'deletar_pet',
  'adicionar_cuidador', 'remover_cuidador', 'listar_cuidadores',
  'convites_pet', 'parar_de_cuidar_pet', 'configurar_inicio_dia',
  'configurar_atraso_notificacao', 'status_racao', 'colocar_racao',
  'corrigir_racao', 'deletar_racao', 'colocar_racao_todos', 'todos',
  'gerar_chave',
]);
```

If declaration API emits alias only through a command's `aliases`, assert set equality and count `24`, not this ordering.

- [ ] **Step 2: Run focused test**

Run: `pnpm exec vitest run apps/carneloot-bot/test/Router.test.ts`

Expected: FAIL because Slice 3 general declarations do not exist and menu lacks `/start`.

- [ ] **Step 3: Add typed `general` group**

Declare these commands without registration middleware: `start`, `cancel`, `ping`, `whats`, `cafe`, `cafeInv`. Declare `hello` with `MessageInput.text(Schema.String)` and filter case-insensitively in handler. Give every menu command Portuguese descriptions and no synthetic heading commands.

Use optional raw/rest inputs so invalid legacy input reaches handler and produces legacy fallback rather than framework decode failure:

```ts
export const general = BotGroup.make('general')
  .add(Command.make('start', { name: 'start', description: 'Iniciar o bot', error: ApplicationError }))
  .add(Command.make('cancel', { name: 'cancelar', description: 'Cancelar operação atual', error: ApplicationError }))
  .add(Command.make('ping', { name: 'ping', description: 'Verificar resposta do bot', input: CommandInput.optional(CommandInput.argument('milliseconds', Schema.String)), error: ApplicationError }))
  .add(Command.make('whats', { name: 'whats', description: 'Criar link do WhatsApp', input: CommandInput.rest('input', Schema.String), error: ApplicationError }))
  .add(Command.make('cafe', { name: 'cafe', description: 'Calcular receita de café', input: CommandInput.rest('input', Schema.String), error: ApplicationError }))
  .add(Command.make('cafeInv', { name: 'cafe_inv', description: 'Calcular água para café', input: CommandInput.rest('input', Schema.String), error: ApplicationError }))
  .addMessage(MessageHandler.make('hello', { input: MessageInput.text(Schema.String), error: ApplicationError }));
```

Add group to `Carneloot`; preserve `/todos` as `addFoodToAll` alias and add `/gerar_chave` declaration in notification plan before final menu assertion lands.

- [ ] **Step 4: Run declaration test**

Run: `pnpm exec vitest run apps/carneloot-bot/test/Router.test.ts`

Expected: command count remains temporarily 23 until API-key plan adds `/gerar_chave`; all newly declared general names route.

- [ ] **Step 5: Commit**

```bash
git add apps/carneloot-bot/src/bot/Declaration.ts apps/carneloot-bot/test/Router.test.ts
git commit -m "feat(carneloot): declare general commands"
```

### Task 2: Implement start, ping, WhatsApp, and hello

**Files:**
- Create: `apps/carneloot-bot/src/bot/GeneralHandlers.ts`
- Modify: `apps/carneloot-bot/src/Router.ts`
- Test: `apps/carneloot-bot/test/GeneralCommands.test.ts`

- [ ] **Step 1: Write failing handler tests**

Cover exact observable outputs:

```ts
it.each([
  [undefined, 'pong'], ['500', 'pong 500 ms'], ['10000', 'pong 10 s'],
  ['10001', 'pong'], ['nope', 'pong'],
])('/ping %s replies %s', async (milliseconds, expected) => { /* dispatch fixture */ });

it('normalizes Brazilian WhatsApp phone and encodes message', () => {
  expect(whatsUrl('(11) 99999-9999', undefined)).toBe('https://wa.me/5511999999999');
  expect(whatsUrl('+55 11 99999-9999', 'Olá!')).toBe('https://wa.me/5511999999999?text=Ol%C3%A1!');
});
```

Assert `/start` replies `É nóis`; invalid/missing WhatsApp number replies exact legacy help; text `HELLO there` sends photo URL `https://i.kym-cdn.com/photos/images/original/001/475/422/473.jpg`; unrelated text sends nothing.

- [ ] **Step 2: Run test**

Run: `pnpm exec vitest run apps/carneloot-bot/test/GeneralCommands.test.ts`

Expected: FAIL because handlers are absent.

- [ ] **Step 3: Implement named workflows and pure parsing**

Export `Effect.fn` boundaries: `start`, `ping`, `whats`, `hello`. Make `parsePingMilliseconds` accept only finite nonnegative decimal integer `<= 10_000`; use `Effect.sleep(Duration.millis(value))`; only append formatted duration for accepted supplied values. Build WhatsApp URL by splitting first phone-shaped portion from optional message, stripping non-digits, accepting optional `55`/`0055`, validating Brazilian DDD plus 8/9-digit local number, prefixing `55` otherwise, and applying `encodeURIComponent` once to message.

Bind:

```ts
export const generalHandlers = BotBuilder.buildGroup(Carneloot, 'general', (handlers) =>
  handlers
    .handle('start', () => GeneralHandlers.start)
    .handle('cancel', () => CancelConversation.cancelCurrent)
    .handle('ping', GeneralHandlers.ping)
    .handle('whats', GeneralHandlers.whats)
    .handleMessage('hello', GeneralHandlers.hello),
);
```

Bind `cafe` and `cafeInv` in Task 3; add `generalHandlers` first in Router `groups`.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run apps/carneloot-bot/test/GeneralCommands.test.ts apps/carneloot-bot/test/Router.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/carneloot-bot/src/bot/GeneralHandlers.ts apps/carneloot-bot/src/Router.ts apps/carneloot-bot/test/GeneralCommands.test.ts
git commit -m "feat(carneloot): add start ping whats and hello"
```

### Task 3: Implement deterministic V60 commands

**Files:**
- Modify: `apps/carneloot-bot/src/bot/GeneralHandlers.ts`
- Modify: `apps/carneloot-bot/src/Router.ts`
- Test: `apps/carneloot-bot/test/GeneralCommands.test.ts`

- [ ] **Step 1: Write failing coffee cases**

Test water inputs `500`, `500ml`, `0.5L`; ratio `65` and `65g/L`; inverse coffee input `30g`; default ratio `60g/L`; invalid quantity and ratio messages. Assert output has exact headline (`Quantidade de café: …` or `Quantidade de água: …`) and deterministic `<pre>` pour table values. Do not assert random legacy filter reminder; omit it for deterministic behavior.

- [ ] **Step 2: Run test**

Run: `pnpm exec vitest run apps/carneloot-bot/test/GeneralCommands.test.ts`

Expected: FAIL for missing coffee handlers.

- [ ] **Step 3: Implement pure recipe parsing/rendering**

Export `parseWaterMl`, `parseCoffeeGrams`, `parseRatioGramsPerLiter`, `recipeFromWater`, `recipeFromCoffee`, and `renderRecipe`. Parse bare water as ml, `ml`, `L`; parse bare coffee as g, `g`; parse bare ratio or `g/L`; reject zero/negative/non-finite values. Calculate coffee `waterMl * ratio / 1000`, inverse water `coffeeG * 1000 / ratio`; schedule bloom `2–3 × coffee`, first pour `60% water`, final total `100% water`. Reply HTML only for table and use explicit parse mode supported by TFX Telegram output.

Bind `cafe` and `cafeInv` to named `Effect.fn('GeneralHandlers.cafe')` and `Effect.fn('GeneralHandlers.cafeInv')` workflows.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm exec vitest run apps/carneloot-bot/test/GeneralCommands.test.ts && pnpm --filter carneloot-bot check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/carneloot-bot/src/bot/GeneralHandlers.ts apps/carneloot-bot/src/Router.ts apps/carneloot-bot/test/GeneralCommands.test.ts apps/carneloot-bot/package.json pnpm-lock.yaml
git commit -m "feat(carneloot): add coffee recipe commands"
```

### Task 4: Restore `/cancelar` parity and close menu contract

**Files:**
- Modify: `apps/carneloot-bot/src/bot/CancelConversation.ts`
- Modify: `apps/carneloot-bot/src/Router.ts`
- Test: `apps/carneloot-bot/test/CancelConversation.test.ts`
- Test: `apps/carneloot-bot/test/Router.test.ts`

- [ ] **Step 1: Write failing cancellation tests**

Assert `/cancelar` both without active conversation and during active conversation replies `Operação cancelada` and removes reply keyboard. Assert bot-username suffix works only for configured username. Assert it is intercepted before active conversation command routing.

- [ ] **Step 2: Run tests**

Run: `pnpm exec vitest run apps/carneloot-bot/test/CancelConversation.test.ts apps/carneloot-bot/test/Router.test.ts`

Expected: FAIL because current output is `Conversa cancelada.` and may only remove keyboard after cancellation.

- [ ] **Step 3: Make cancellation idempotent**

Keep `beforeConversation` special case. Make `cancelCurrent` always invoke cancellation scope cleanup, reply exactly `Operação cancelada`, and send reply-keyboard removal regardless of active-state result. Route declared `/cancelar` through same effect when no conversation is active; never duplicate output when interception handled it.

- [ ] **Step 4: Run Slice command tests**

Run: `pnpm exec vitest run apps/carneloot-bot/test/GeneralCommands.test.ts apps/carneloot-bot/test/CancelConversation.test.ts apps/carneloot-bot/test/Router.test.ts`

Expected: PASS, provided notification/API-key plan Task 3 is complete; menu assertion then passes all 24 names.

- [ ] **Step 5: Commit**

```bash
git add apps/carneloot-bot/src/bot/CancelConversation.ts apps/carneloot-bot/src/Router.ts apps/carneloot-bot/test/CancelConversation.test.ts apps/carneloot-bot/test/Router.test.ts
git commit -m "fix(carneloot): restore cancel command parity"
```

## Final verification

Prerequisite: notification/API-key plan Task 3 committed; `/gerar_chave` is declared.

```bash
pnpm exec vitest run apps/carneloot-bot/test/GeneralCommands.test.ts apps/carneloot-bot/test/CancelConversation.test.ts apps/carneloot-bot/test/Router.test.ts
pnpm --filter carneloot-bot check
```

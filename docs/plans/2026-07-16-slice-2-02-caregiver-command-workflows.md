# Slice 2 Caregiver Command Workflows Implementation Plan

**Goal:** Deliver `/deletar_pet` and five caregiver invitation/administration commands through durable Portuguese bot conversations.

**Architecture:** Small application services lock and mutate caregiver/pet rows; durable conversations own selection and confirmation UI. Telegram DMs run only through transition `afterCommit`, so invitation/removal decisions remain committed even when notification output fails.

**Tech Stack:** tfx Bot/Conversation/ConversationChoice, Effect, PostgreSQL, Vitest, private Slice 1 update harness.

---

## File map

- Create: `apps/carneloot-bot/src/application/CaregiverResult.ts`
- Create: `apps/carneloot-bot/src/application/DeletePet.ts`
- Create: `apps/carneloot-bot/src/application/InviteCaregiver.ts`
- Create: `apps/carneloot-bot/src/application/RemoveCaregiver.ts`
- Create: `apps/carneloot-bot/src/application/ListCaregivers.ts`
- Create: `apps/carneloot-bot/src/application/ListPetInvitations.ts`
- Create: `apps/carneloot-bot/src/application/RespondPetInvitation.ts`
- Create: `apps/carneloot-bot/src/application/StopCaring.ts`
- Create: `apps/carneloot-bot/src/bot/CaregiverHandlers.ts`
- Create: `apps/carneloot-bot/src/bot/conversations/DeletePetConversation.ts`
- Create: `apps/carneloot-bot/src/bot/conversations/InviteCaregiverConversation.ts`
- Create: `apps/carneloot-bot/src/bot/conversations/RemoveCaregiverConversation.ts`
- Create: `apps/carneloot-bot/src/bot/conversations/ListCaregiversConversation.ts`
- Create: `apps/carneloot-bot/src/bot/conversations/PetInvitationsConversation.ts`
- Create: `apps/carneloot-bot/src/bot/conversations/StopCaringConversation.ts`
- Create: `apps/carneloot-bot/test/caregivers/CaregiverApplication.test.ts`
- Create: `apps/carneloot-bot/test/caregivers/CaregiverConversations.test.ts`
- Create: `apps/carneloot-bot/test/caregivers/CaregiverCommands.e2e.integration.test.ts`
- Modify: `apps/carneloot-bot/src/ports/PetRepository.ts`
- Modify: `apps/carneloot-bot/src/ports/ReminderScheduler.ts`
- Modify: `apps/carneloot-bot/src/postgres/PetRepositoryLive.ts`
- Modify: `apps/carneloot-bot/src/postgres/ReminderSchedulerLive.ts`
- Modify: `apps/carneloot-bot/src/bot/Declaration.ts`
- Modify: `apps/carneloot-bot/src/bot/PetHandlers.ts`
- Modify: `apps/carneloot-bot/src/Router.ts`
- Modify: `apps/carneloot-bot/src/DomainLive.ts`
- Modify: `apps/carneloot-bot/test/BotLayers.test.ts`
- Modify: `apps/carneloot-bot/test/NodeSmoke.test.ts`
- Modify: `apps/carneloot-bot/test/Router.test.ts`
- Modify: `apps/carneloot-bot/test/e2e/OwnedPetFoodLoop.e2e.test.ts`

### Task 1: Add transactional caregiver use cases

- [ ] **Step 1: Write failing application tests**

Use in-memory port stubs to cover: self-invite; username normalization; zero/ambiguous user match; duplicate pending/accepted/rejected relation; invite accept/reject; repeat response; owner removal of any status; caregiver stop only while accepted; owner isolation; and access revocation before commit.

Run: `pnpm --filter carneloot-bot test -- CaregiverApplication.test.ts`
Expected: FAIL because application services do not exist.

- [ ] **Step 2: Define invitation result contracts**

Create `application/CaregiverResult.ts`; application services return domain data plus post-commit notification intent and never send Telegram directly:

```ts
export interface PrivateNotice {
  readonly chatId: TelegramChatId
  readonly text: string
}
export interface MutationResult<A> {
  readonly value: A
  readonly notices: ReadonlyArray<PrivateNotice>
}
export interface CaregiverActor {
  readonly actorId: UserId
  readonly botId: BotId
  readonly telegramUserId: TelegramUserId
}
```

Exact entrypoints are `DeletePet.execute(actor, petId)`, `InviteCaregiver.execute(actor, petId, username)`, `RemoveCaregiver.execute(actor, petId, caregiverUserId)`, `ListCaregivers.execute(actor, petId)`, `ListPetInvitations.execute(actor)`, `RespondPetInvitation.execute(actor, petId, response)`, and `StopCaring.execute(actor, petId)`. `response` is `"accepted" | "rejected"`. Invitation lookup removes one leading `@`, trims, lowercases for query, rejects empty input, and preserves current registered display data for messages.

- [ ] **Step 3: Implement owner services**

`InviteCaregiver.execute` opens one transaction, resolves current owner identity, locks owned pet, resolves exactly one bot-scoped username, rejects self, inserts pending relation, and returns invitee DM:

```text
<owner display> convidou você para cuidar do pet <pet>.
Use /convites_pet para responder.
```

`RemoveCaregiver.execute` locks owned pet and relation, removes pending/accepted/rejected relation, and returns removed-user DM. `ListCaregivers.execute` rechecks ownership and joins current display names with translated statuses.

- [ ] **Step 4: Implement invitee services**

`ListPetInvitations.execute` returns pending invitations with pet and owner display. `RespondPetInvitation.execute` conditionally changes pending to accepted/rejected and returns owner DM. `StopCaring.execute` deletes only caller's accepted relation and returns owner DM.

- [ ] **Step 5: Run application tests**

Run: `pnpm --filter carneloot-bot test -- CaregiverApplication.test.ts`
Expected: PASS with no Telegram dependency required by application services.

- [ ] **Step 6: Commit application services**

```bash
git add apps/carneloot-bot/src/application apps/carneloot-bot/test/caregivers/CaregiverApplication.test.ts
git commit -m "feat(carneloot): implement caregiver lifecycle services"
```

### Task 2: Add safe pet deletion

- [ ] **Step 1: Write failing deletion integration tests**

Cover owner deletion, non-owner denial, concurrent caregiver revocation, active reminder cancellation, cascading food/settings/caregivers/notification events, and no orphan scheduled tfx job.

- [ ] **Step 2: Extend persistence ports**

Add:

```ts
readonly deleteOwned: (
  ownerId: UserId,
  petId: PetId
) => Effect.Effect<boolean, DomainPersistenceError>
```

`PetRepositoryLive.deleteOwned` uses `DELETE ... WHERE id = $petId AND owner_id = $ownerId RETURNING id`. `DeletePet.execute` resolves identity, locks owned pet, then calls `ReminderScheduler.cancelForPet({ botId, petId })` before deleting pet. Lock order is pet row → reminder advisory/event rows → tfx job row. Event cancellation, `JobRuntime.cancel`, and pet deletion use same ambient `PgClient` transaction; rollback restores all three. Pet cascade removes cancelled event/delivery audit rows after matching job row is durably cancelled, so no scheduled orphan can claim missing event. Missing/changed ownership returns `PetAccessDenied` and rolls back cancellation.

- [ ] **Step 3: Run deletion integration tests**

Run: `pnpm --filter carneloot-bot test:integration -- CaregiverCommands.e2e.integration.test.ts -t "delete pet persistence"`
Expected: PASS with no active reminder/event/job orphan.

- [ ] **Step 4: Commit deletion service**

```bash
git add apps/carneloot-bot/src/application/DeletePet.ts apps/carneloot-bot/src/ports apps/carneloot-bot/src/postgres apps/carneloot-bot/test/caregivers/CaregiverCommands.e2e.integration.test.ts
git commit -m "feat(carneloot): delete pets transactionally"
```

### Task 3: Declare commands and exhaustive handlers

- [ ] **Step 1: Make builder type test fail**

Add command declarations without handlers and run:

Run: `pnpm --filter carneloot-bot check`
Expected: FAIL with builder diagnostic showing unimplemented `pets` command IDs.

Keep `pnpm --filter carneloot-bot test -- BotLayers.test.ts` for runtime builder assertions after handlers exist.

- [ ] **Step 2: Extend `pets` declaration**

Declare exactly these command IDs/names, all with `RegisteredUser` and `ApplicationError`:

```text
deletePet       → deletar_pet          → Deletar um pet
inviteCaregiver → adicionar_cuidador   → Convidar cuidador
removeCaregiver → remover_cuidador     → Remover cuidador
listCaregivers  → listar_cuidadores    → Listar cuidadores
petInvitations  → convites_pet         → Responder convites de pets
stopCaring      → parar_de_cuidar_pet  → Parar de cuidar de um pet
```

- [ ] **Step 3: Bind exhaustive handlers**

Create `CaregiverHandlers.ts` startup functions and extend `Router.petHandlers` with five caregiver IDs plus `deletePet`. Each startup reads `CurrentUser`, normalized update scope, and current options. Empty collections reply immediately and do not create conversation.

- [ ] **Step 4: Register conversations**

Append all six built conversations to `Router.conversations`. Keep one active conversation conflict policy consistent with Slice 1 (`conflict: "replace"`). Add caregiver application errors to `classifyError` as `PermanentInvalid`; retain persistence retry/fatal classification.

- [ ] **Step 5: Run builder/router tests**

Run: `pnpm --filter carneloot-bot test -- BotLayers.test.ts Router.test.ts NodeSmoke.test.ts`
Expected: PASS with exhaustive declarations, 13 command names at this point (7 Slice 1 plus 6 from this plan), and closed error mapping.

### Task 4: Implement owner-side conversations

- [ ] **Step 1: Write failing transcripts**

Cover:

- `/deletar_pet`: no pets; pet selection; `Sim` deletes; `Não` completes unchanged.
- `/adicionar_cuidador`: no pets; pet selection; `@name`/`name`; self, unknown, ambiguous, duplicate status; successful pending invitation.
- `/remover_cuidador`: no pets; no caregivers; status-labelled caregiver selection; removal.
- `/listar_cuidadores`: no pets; empty caregivers; translated status list.

Every invalid input stays on same step; `/cancelar` removes reply keyboard; restart resumes current step.

- [ ] **Step 2: Implement typed choices**

Use `ConversationChoice.reply` with branded `PetId`/`UserId` codecs and non-empty option checks. State stores IDs and labels, never repository objects. Confirmation uses `ConversationChoice.boolean({ yes: "Sim", no: "Não" })`.

- [ ] **Step 3: Recheck protected reads**

Pet selection handlers rerun owner authorization before listing caregivers. Final mutation handlers call application service, which locks/rechecks again. Lost access completes with `Este pet não está mais disponível para você.` and performs no write.

- [ ] **Step 4: Attach post-commit output**

Success responses and private notices run in `transition.complete({ afterCommit })`. DM failure maps to `HandledWithOutputFailure`; committed relation/deletion remains unchanged and invitee can still discover pending invitation.

- [ ] **Step 5: Run owner conversation tests**

Run: `pnpm --filter carneloot-bot test -- CaregiverConversations.test.ts -t "owner workflows"`
Expected: PASS for empty, invalid, restart, cancel, output-failure, and revocation cases.

- [ ] **Step 6: Commit owner workflows**

```bash
git add apps/carneloot-bot/src/bot apps/carneloot-bot/src/Router.ts apps/carneloot-bot/test/caregivers/CaregiverConversations.test.ts apps/carneloot-bot/test/BotLayers.test.ts apps/carneloot-bot/test/Router.test.ts apps/carneloot-bot/test/NodeSmoke.test.ts
git commit -m "feat(carneloot): add owner caregiver commands"
```

### Task 5: Implement invitee conversations

- [ ] **Step 1: Write failing transcripts**

Cover `/convites_pet` no-pending message, `<pet> (<owner>)` selection, `Sim` acceptance, `Não` rejection, concurrent owner removal, and owner DM. Cover `/parar_de_cuidar_pet` no accepted pets, selection, confirmation yes/no, concurrent revocation, and owner DM.

- [ ] **Step 2: Implement invitation response machine**

Use ID `pet-caregiver-invitations`, version `1`, steps `invitation` and `confirm`. Final response conditionally updates only pending row. Messages:

```text
accepted: Convite aceito! Você agora cuida de <pet>.
rejected: Convite recusado.
none: Você não tem convites pendentes.
```

- [ ] **Step 3: Implement stop-caring machine**

Use ID `stop-caring-for-pet`, version `1`, steps `pet` and `confirm`. Delete only accepted caller relation. Messages:

```text
none: Você não está cuidando de nenhum pet.
success: Você parou de cuidar deste pet.
```

- [ ] **Step 4: Run invitee conversation tests**

Run: `pnpm --filter carneloot-bot test -- CaregiverConversations.test.ts -t "invitee workflows"`
Expected: PASS for accept/reject/stop/cancel/restart/concurrency.

- [ ] **Step 5: Commit invitee workflows**

```bash
git add apps/carneloot-bot/src/bot/conversations apps/carneloot-bot/src/bot/CaregiverHandlers.ts apps/carneloot-bot/test/caregivers/CaregiverConversations.test.ts
git commit -m "feat(carneloot): add caregiver invitation commands"
```

### Task 6: Prove command flows against PostgreSQL

- [ ] **Step 1: Add update-driven E2E fixture**

Use existing private Telegram recorder and real PostgreSQL. Scenario: register owner/caregiver; add pet; invite; duplicate invite; accept; list; remove; reinvite/reject; remove rejected; accept again; stop caring; delete pet. Assert database state and outbound DMs after every update.

- [ ] **Step 2: Add interrupted/concurrent cases**

Persist conversation, rebuild Layer, resume it, then remove relation/pet in another transaction before final input. Assert final mutation rejects stale selection. Redeliver same update and assert one transition/write/DM attempt.

- [ ] **Step 3: Run E2E tests**

Run: `pnpm --filter carneloot-bot test:integration -- CaregiverCommands.e2e.integration.test.ts`
Expected: all lifecycle, restart, duplicate-update, and access-change scenarios PASS.

- [ ] **Step 4: Run package gate and commit**

Run: `pnpm format && pnpm lint && pnpm --filter carneloot-bot check && pnpm --filter carneloot-bot test`
Expected: PASS.

```bash
git add apps/carneloot-bot/test/caregivers apps/carneloot-bot/test/e2e/OwnedPetFoodLoop.e2e.test.ts apps/carneloot-bot/src/DomainLive.ts
git commit -m "test(carneloot): prove caregiver command lifecycle"
```

## Acceptance criteria

- `/deletar_pet` cancels reminder and deletes only currently owned pet after confirmation.
- Invitation lifecycle supports pending, accepted, rejected, owner removal, and caregiver stop.
- Empty option sets never start stuck conversations.
- Duplicate/self/unknown/ambiguous invitations perform no write.
- Every final mutation rechecks access under lock.
- Telegram notices are best-effort post-commit outputs.
- Portuguese command set is exactly `/deletar_pet`, `/adicionar_cuidador`, `/remover_cuidador`, `/listar_cuidadores`, `/convites_pet`, and `/parar_de_cuidar_pet`; `/cancelar` remains lifecycle-only until Slice 3 declaration.
- Portuguese command names and recognizable messages match approved behavior.

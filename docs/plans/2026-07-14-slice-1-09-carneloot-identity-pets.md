# Slice 1 Carneloot Identity and Owned Pets Implementation Plan

**Goal:** Add Carneloot PostgreSQL identity/pet domain and deliver `/cadastrar`, `/adicionar_pet`, and `/listar_pets` through public tfx APIs.

**Architecture:** Application services own use cases; repository interfaces are Effect services; PostgreSQL Layers implement them with ambient PgClient. Telegram handlers only orchestrate services and conversations. Registration upserts Telegram profile by bot/user identity while preserving domain user ID.

**Tech Stack:** tfx public APIs, Effect Schema/Layer, `@effect/sql-pg`, PostgreSQL, Bun.

---

## File map

- Create: `apps/carneloot-bot/migrations/0001_identity_pets.sql`
- Create: `apps/carneloot-bot/src/domain/{Ids.ts,User.ts,Pet.ts,DomainError.ts}`
- Create: `apps/carneloot-bot/src/ports/{UserRepository.ts,PetRepository.ts}`
- Create: `apps/carneloot-bot/src/postgres/{UserRepositoryLive.ts,PetRepositoryLive.ts,AppMigrator.ts}`
- Create: `apps/carneloot-bot/src/application/{RegisterUser.ts,AddPet.ts,ListPets.ts}`
- Create: `apps/carneloot-bot/src/bot/{Declaration.ts,AccountHandlers.ts,PetHandlers.ts,RegisteredUser.ts,CurrentUser.ts,AddPetConversation.ts}`
- Create: `apps/carneloot-bot/test/{Identity.integration.test.ts,Pets.integration.test.ts,IdentityPets.e2e.test.ts}`

### Task 1: Identity/pet schema and domain codecs

- [ ] **Step 1: Write migration/repository failing tests**

Cases: Telegram bigint beyond JS safe integer round-trips as string/branded bigint; username nullable/non-unique; pet name unique per owner; timestamps update; FK/cascade policy is explicit.

- [ ] **Step 2: Create fixed application schema**

Carneloot domain migrations and repositories use explicitly qualified fixed schema `carneloot`; tfx schema/prefix options do not apply to application tables.

```text
schema carneloot
carneloot.users(id uuid primary key, created_at timestamptz not null, updated_at timestamptz not null)
carneloot.telegram_identities(bot_id text not null, telegram_user_id bigint not null, user_id uuid not null references carneloot.users, username text null, first_name text not null, last_name text null, private_chat_id bigint not null, created_at timestamptz not null, updated_at timestamptz not null, primary key(bot_id,telegram_user_id), unique(bot_id,user_id))
carneloot.pets(id uuid primary key, owner_id uuid not null references carneloot.users, name text not null, name_key text not null, created_at timestamptz not null, updated_at timestamptz not null, unique(owner_id,name_key))
```

Do not make username unique. `name_key` is trimmed, collapsed-whitespace, locale-independent lowercase; display name preserves normalized casing.

- [ ] **Step 3: Implement schemas/validation**

Pet name: trim/collapse whitespace, 1–80 UTF-8 bytes, reject control characters. User profile accepts absent username/last name as null. IDs are branded.

- [ ] **Step 4: Run and commit**

Run: `pnpm --filter carneloot-bot test -- Identity.integration.test.ts Pets.integration.test.ts`
Expected: migration and constraints PASS.

```bash
git add apps/carneloot-bot/migrations/0001_identity_pets.sql apps/carneloot-bot/src/domain apps/carneloot-bot/test/Identity.integration.test.ts apps/carneloot-bot/test/Pets.integration.test.ts
git commit -m "feat(carneloot): add identity and pet schema"
```

### Task 2: Repositories and use cases

- [ ] **Step 1: Define ports and failing use-case tests**

`UserRepository.registerTelegramProfile`, `findByTelegram`, `PetRepository.addOwned`, `listOwned`. Test repeat registration keeps same user ID/relationships and refreshes first/last/username/private chat; removed username becomes null.

- [ ] **Step 2: Implement transactional registration upsert**

Insert user+identity for first registration. On `(bot_id,telegram_user_id)` conflict update mutable profile fields only and return existing user. Concurrent first registration produces one user (delete unused speculative row or use locked two-step transaction).

- [ ] **Step 3: Implement pet use cases**

`AddPet` maps unique violation to typed `PetNameAlreadyExists`; `ListPets` returns alphabetically sorted owned pets. Interface leaves room for cared pets later without adding caregiver SQL now.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter carneloot-bot test -- Identity.integration.test.ts Pets.integration.test.ts`
Expected: repeat/concurrent registration and pet validation PASS.

```bash
git add apps/carneloot-bot/src/ports apps/carneloot-bot/src/postgres apps/carneloot-bot/src/application apps/carneloot-bot/test/*.integration.test.ts
git commit -m "feat(carneloot): implement identity and pet services"
```

### Task 3: Registration middleware and bot declarations

- [ ] **Step 1: Write compile-time declaration tests**

Declare account/pets groups and commands. `/cadastrar` has no registration middleware; add/list use `RegisteredUser` providing `CurrentUser`. Missing middleware or implementation must fail type check.

- [ ] **Step 2: Implement registration handler**

If sender absent reply `Não foi possível identificar o usuário.`. Otherwise persist sender profile and use Telegram user ID as private-delivery chat identity, matching Telegram private-chat addressing; registration remains valid when command arrives from another chat. Success calls use case then replies `Usuário cadastrado com sucesso!` in invoking chat.

- [ ] **Step 3: Implement middleware**

Lookup by bot/user; absent account replies `Por favor cadastre-se primeiro utilizando /cadastrar` and returns handled domain rejection. Declaration has no infrastructure requirement; Live Layer requires `UserRepository`.

- [ ] **Step 4: Run and commit**

Run: `pnpm --filter carneloot-bot check && pnpm --filter carneloot-bot test -- IdentityPets.e2e.test.ts`
Expected: registration/access scenarios PASS.

```bash
git add apps/carneloot-bot/src/bot/Declaration.ts apps/carneloot-bot/src/bot/AccountHandlers.ts apps/carneloot-bot/src/bot/RegisteredUser.ts apps/carneloot-bot/src/bot/CurrentUser.ts apps/carneloot-bot/test/IdentityPets.e2e.test.ts
git commit -m "feat(carneloot): register Telegram users"
```

### Task 4: Add/list pet handlers and conversation

- [ ] **Step 1: Write E2E transcripts**

New owner: `/adicionar_pet` → `Qual o nome do seu pet?` → `Rex` → `Pet cadastrado com sucesso!`. Invalid/duplicate name re-prompts with Portuguese reason. `/listar_pets` returns sorted numbered list; no pets returns `Você não tem pets`. Duplicate update creates one pet.

- [ ] **Step 2: Declare/implement AddPet conversation**

Single `name` step uses message-text PetName codec. Handler rechecks CurrentUser, writes through use case inside storage-controlled transaction, completes with post-commit success reply. `/cancelar` exits/removes keyboard.

- [ ] **Step 3: Implement list handler**

Format deterministic numbered Portuguese list. Future cared-pet label seam belongs in application projection, not handler SQL.

- [ ] **Step 4: Run and commit**

Run: `pnpm --filter carneloot-bot test -- IdentityPets.e2e.test.ts`
Expected: all transcripts, restart, cancellation, and duplicate update PASS against PostgreSQL conversation/dedup Layers.

```bash
git add apps/carneloot-bot/src/bot/AddPetConversation.ts apps/carneloot-bot/src/bot/PetHandlers.ts apps/carneloot-bot/test/IdentityPets.e2e.test.ts
git commit -m "feat(carneloot): add and list owned pets"
```

## Acceptance criteria

- Repeat `/cadastrar` refreshes profile and preserves user/pets.
- Telegram IDs are PostgreSQL bigint; username nullable/non-unique.
- Pet names are safely normalized and unique per owner.
- Unregistered access receives exact registration guidance.
- Handlers contain no SQL and import only public tfx APIs.
- Add-pet conversation survives restart, cancels cleanly, and duplicate update creates one row.

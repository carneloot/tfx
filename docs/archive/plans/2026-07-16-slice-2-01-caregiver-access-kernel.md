# Slice 2 Caregiver Access Kernel Implementation Plan

**Goal:** Add durable caregiver invitations and one authoritative owner/accepted-caregiver authorization model used by all pet-food workflows.

**Architecture:** `PetCaregiverRepository` owns relationship persistence while `PetFoodAccess` resolves current Telegram identity and locks pet access inside ambient PostgreSQL transactions. Relationship state never becomes authority by itself: only pet ownership or an `accepted` row grants food access.

**Tech Stack:** Effect Schema/Context, @effect/sql-pg, PostgreSQL, Vitest, Testcontainers.

---

## File map

- Create: `apps/carneloot-bot/scripts/generate-migration-artifacts.ts`
- Create: `apps/carneloot-bot/test/MigrationArtifactGenerator.test.ts`
- Create: `apps/carneloot-bot/migrations/0006_pet_caregivers.sql`
- Create: `apps/carneloot-bot/src/postgres/Migration0006Sql.ts`
- Create: `apps/carneloot-bot/src/domain/caregivers/PetCaregiver.ts`
- Create: `apps/carneloot-bot/src/ports/PetCaregiverRepository.ts`
- Create: `apps/carneloot-bot/src/postgres/PetCaregiverRepositoryLive.ts`
- Create: `apps/carneloot-bot/test/caregivers/PetCaregiverDomain.test.ts`
- Create: `apps/carneloot-bot/test/caregivers/PetCaregiverRepository.integration.test.ts`
- Modify: `apps/carneloot-bot/package.json`
- Modify: `apps/carneloot-bot/src/domain/DomainError.ts`
- Modify: `apps/carneloot-bot/src/domain/ApplicationError.ts`
- Modify: `apps/carneloot-bot/src/ports/UserRepository.ts`
- Modify: `apps/carneloot-bot/src/ports/PetRepository.ts`
- Modify: `apps/carneloot-bot/src/postgres/UserRepositoryLive.ts`
- Modify: `apps/carneloot-bot/src/postgres/PetRepositoryLive.ts`
- Modify: `apps/carneloot-bot/src/postgres/AppMigrator.ts`
- Modify: `apps/carneloot-bot/src/postgres/RepositoriesLive.ts`
- Modify: `apps/carneloot-bot/src/application/PetFoodAccess.ts`
- Modify: `apps/carneloot-bot/src/application/AddFood.ts`
- Modify: `apps/carneloot-bot/src/application/GetFoodStatus.ts`
- Modify: `apps/carneloot-bot/src/bot/PetFoodHandlers.ts`
- Modify: `apps/carneloot-bot/src/bot/conversations/AddFoodConversation.ts`
- Modify: `apps/carneloot-bot/src/bot/conversations/ConfigureDayStartConversation.ts`
- Modify: `apps/carneloot-bot/src/bot/conversations/ConfigureReminderDelayConversation.ts`
- Modify: `apps/carneloot-bot/src/main.ts`
- Modify: `apps/carneloot-bot/test/MigrationArtifact.test.ts`
- Modify: `apps/carneloot-bot/test/IdentityPets.test.ts`
- Modify: `apps/carneloot-bot/test/pet-food/PetFoodApplication.test.ts`
- Modify: `apps/carneloot-bot/test/pet-food/PetFoodCommands.test.ts`
- Modify: `apps/carneloot-bot/test/pet-food/PetFoodConversations.test.ts`

### Task 1: Add Effect migration-artifact generator

- [x] **Step 1: Write failing generator tests**

Create `MigrationArtifactGenerator.test.ts`. Test `renderMigrationArtifact` with SQL containing quotes/newlines and assert exact TypeScript source, lowercase SHA-256, stable output, sorted migration processing, and `--check` failure when generated file differs from SQL. Use a temporary directory through Effect `FileSystem` test services; never modify committed migrations from test.

Run: `pnpm --filter carneloot-bot test -- MigrationArtifactGenerator.test.ts`
Expected: FAIL because generator script does not exist.

- [x] **Step 2: Create Effect-based generator**

Create `apps/carneloot-bot/scripts/generate-migration-artifacts.ts`:

```ts
#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

const migrationPattern = /^(\d{4})_[a-z0-9_]+\.sql$/u

export const renderMigrationArtifact = (
  fileName: string,
  sql: string,
  checksum: string
): string => {
  const match = migrationPattern.exec(fileName)
  if (match === null) throw new Error(`Invalid migration filename: ${fileName}`)
  const version = match[1]
  return `// Generated from migrations/${fileName}; do not edit.\nexport const migration${version}Sql = ${JSON.stringify(sql)};\nexport const migration${version}Checksum = ${JSON.stringify(checksum)};\n`
}

export const generateMigrationArtifacts = (options: {
  readonly appDirectory: string
  readonly check: boolean
}) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const migrationsDirectory = path.join(options.appDirectory, "migrations")
  const outputDirectory = path.join(options.appDirectory, "src", "postgres")
  const files = (yield* fs.readDirectory(migrationsDirectory))
    .filter((file) => migrationPattern.test(file))
    .sort()

  if (files.length === 0) {
    return yield* Effect.fail(new Error("No application migrations found"))
  }

  yield* Effect.forEach(
    files,
    (fileName) => Effect.gen(function* () {
      const version = migrationPattern.exec(fileName)![1]
      const sourcePath = path.join(migrationsDirectory, fileName)
      const outputPath = path.join(outputDirectory, `Migration${version}Sql.ts`)
      const sql = yield* fs.readFileString(sourcePath)
      const digest = yield* crypto.digest(
        "SHA-256",
        new TextEncoder().encode(sql)
      )
      const rendered = renderMigrationArtifact(
        fileName,
        sql,
        Encoding.encodeHex(digest)
      )

      if (options.check) {
        const exists = yield* fs.exists(outputPath)
        const actual = exists ? yield* fs.readFileString(outputPath) : ""
        if (actual !== rendered) {
          return yield* Effect.fail(
            new Error(
              `${outputPath} differs; run pnpm --filter carneloot-bot migrations:generate`
            )
          )
        }
        return
      }

      yield* fs.writeFileString(outputPath, rendered)
      yield* Effect.logInfo("generated migration artifact").pipe(
        Effect.annotateLogs({ migration: fileName, outputPath })
      )
    }),
    { concurrency: 'unbounded', discard: true }
  )
})

const main = Effect.gen(function* () {
  const path = yield* Path.Path
  const appDirectory = path.resolve(import.meta.dirname, "..")
  yield* generateMigrationArtifacts({
    appDirectory,
    check: process.argv.includes("--check")
  })
})

if (import.meta.main) {
  main.pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain
  )
}
```

Generator treats committed `.sql` files as canonical, processes every matching migration in version order, computes checksums through yieldable `effect/Crypto`, and performs filesystem work through yieldable `effect/FileSystem`/`effect/Path`.

- [x] **Step 3: Add package commands**

Add to `apps/carneloot-bot/package.json`:

```json
"migrations:generate": "node scripts/generate-migration-artifacts.ts",
"migrations:check": "node scripts/generate-migration-artifacts.ts --check"
```

- [x] **Step 4: Generate existing artifacts and verify no drift**

Run: `pnpm --filter carneloot-bot migrations:generate`
Expected: `Migration0001Sql.ts` through `Migration0005Sql.ts` are regenerated byte-for-byte with no Git diff.

Run: `pnpm --filter carneloot-bot migrations:check`
Expected: exits 0.

- [x] **Step 5: Run generator tests and type-check**

Run: `pnpm --filter carneloot-bot test -- MigrationArtifactGenerator.test.ts MigrationArtifact.test.ts`
Expected: PASS for rendering, generation order, drift detection, and committed SQL parity.

Run: `pnpm --filter carneloot-bot check`
Expected: PASS with script included in TypeScript project.

- [x] **Step 6: Commit generator**

```bash
git add apps/carneloot-bot/scripts/generate-migration-artifacts.ts apps/carneloot-bot/test/MigrationArtifactGenerator.test.ts apps/carneloot-bot/package.json
git commit -m "build(carneloot): generate migration artifacts with Effect"
```

### Task 2: Model caregiver status and errors

- [x] **Step 1: Write failing schema tests**

Create `PetCaregiverDomain.test.ts` proving only `pending`, `accepted`, and `rejected` decode; relationship timestamps decode as `DateTime.Utc`; translated labels are `pendente`, `aceito`, and `rejeitado`.

Run: `pnpm --filter carneloot-bot test -- PetCaregiverDomain.test.ts`
Expected: FAIL because caregiver domain module does not exist.

- [x] **Step 2: Add domain schemas**

Implement this public shape in `PetCaregiver.ts`:

```ts
export const CaregiverStatus = Schema.Literals([
  "pending",
  "accepted",
  "rejected"
])
export type CaregiverStatus = typeof CaregiverStatus.Type

export const PetCaregiver = Schema.Struct({
  petId: PetId,
  caregiverUserId: UserId,
  status: CaregiverStatus,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
})
export type PetCaregiver = typeof PetCaregiver.Type

export const statusLabel = (status: CaregiverStatus): string =>
  status === "pending" ? "pendente" :
  status === "accepted" ? "aceito" : "rejeitado"
```

Add tagged application errors for ambiguous username, self-invitation, existing relationship, missing invitation, invalid invitation transition, and caregiver access loss. Include them in `ApplicationError` and classify them as expected domain failures in later router work.

- [x] **Step 3: Run schema tests**

Run: `pnpm --filter carneloot-bot test -- PetCaregiverDomain.test.ts`
Expected: PASS for accepted values, rejected values, and Portuguese labels.

- [x] **Step 4: Commit domain model**

```bash
git add apps/carneloot-bot/src/domain apps/carneloot-bot/test/caregivers/PetCaregiverDomain.test.ts
git commit -m "feat(carneloot): model caregiver relationships"
```

### Task 3: Add caregiver migration and migration artifact

- [x] **Step 1: Write failing migration assertions**

Extend `MigrationArtifact.test.ts` to require migration version `6`, exact SQL artifact parity, primary key `(pet_id, caregiver_user_id)`, status check, foreign keys, timestamps, and caregiver lookup index. Self-invitation remains an application-transaction assertion because owner ID lives on referenced pet row.

Run: `pnpm --filter carneloot-bot test -- MigrationArtifact.test.ts`
Expected: FAIL because migration 0006 is absent.

- [x] **Step 2: Add SQL migration**

Create `0006_pet_caregivers.sql` with:

```sql
CREATE TABLE carneloot.pet_caregivers (
  pet_id uuid NOT NULL,
  caregiver_user_id uuid NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT pet_caregivers_pk PRIMARY KEY (pet_id, caregiver_user_id),
  CONSTRAINT pet_caregivers_pet_fk FOREIGN KEY (pet_id)
    REFERENCES carneloot.pets(id) ON DELETE CASCADE,
  CONSTRAINT pet_caregivers_user_fk FOREIGN KEY (caregiver_user_id)
    REFERENCES carneloot.users(id) ON DELETE RESTRICT,
  CONSTRAINT pet_caregivers_status_check
    CHECK (status IN ('pending', 'accepted', 'rejected'))
);
CREATE INDEX pet_caregivers_user_status_pet_idx
  ON carneloot.pet_caregivers (caregiver_user_id, status, pet_id);
```

Self-invitation is rejected transactionally by application service after locking pet; do not add a denormalized owner column or trigger.

- [x] **Step 3: Generate and register SQL artifact**

Run: `pnpm --filter carneloot-bot migrations:generate`
Expected: generator creates `Migration0006Sql.ts` from canonical `0006_pet_caregivers.sql` with exact SQL bytes and SHA-256 checksum.

Run: `pnpm --filter carneloot-bot migrations:check`
Expected: exits 0 with all migration artifacts current.

Register version `6` in `AppMigrator.ts`. Merge `PetCaregiverRepositoryLive.layer` in `RepositoriesLive.ts` only after Task 5 creates it.

- [x] **Step 4: Run migration tests**

Run: `pnpm --filter carneloot-bot test -- MigrationArtifact.test.ts`
Expected: PASS with versions 1–6 in ascending order and artifact parity.

- [x] **Step 5: Commit migration**

```bash
git add apps/carneloot-bot/migrations/0006_pet_caregivers.sql apps/carneloot-bot/src/postgres/Migration0006Sql.ts apps/carneloot-bot/src/postgres/AppMigrator.ts apps/carneloot-bot/test/MigrationArtifact.test.ts
git commit -m "feat(carneloot): add caregiver persistence schema"
```

### Task 4: Define repository contracts

- [x] **Step 1: Write compile-time contract fixture**

In `PetCaregiverRepository.integration.test.ts`, define a test implementation with every required method so TypeScript fails until contract exists.

- [x] **Step 2: Add bot-scoped username lookup**

Extend `UserRepositoryService` with:

```ts
readonly findByUsername: (
  botId: BotId,
  username: string
) => Effect.Effect<ReadonlyArray<RegisteredUser>, DomainPersistenceError>
```

Contract normalizes caller input before query; adapter compares `lower(username)` within `bot_id`, orders by user ID, and returns all matches so application layer can reject ambiguity.

- [x] **Step 3: Add pet lookup contracts**

Extend `PetRepositoryService` with:

```ts
readonly lockById: (
  petId: PetId
) => Effect.Effect<Pet | undefined, DomainPersistenceError>
readonly listAccessible: (
  userId: UserId
) => Effect.Effect<ReadonlyArray<Pet>, DomainPersistenceError | UserNotRegistered>
```

`listAccessible` returns owned pets plus pets with accepted caregiver relation, deduplicated and ordered by `name_key, id`.

- [x] **Step 4: Define caregiver repository**

Use this contract:

```ts
export interface PetCaregiverRepositoryService {
  readonly find: (petId: PetId, caregiverUserId: UserId) =>
    Effect.Effect<PetCaregiver | undefined, DomainPersistenceError>
  readonly lock: (petId: PetId, caregiverUserId: UserId) =>
    Effect.Effect<PetCaregiver | undefined, DomainPersistenceError>
  readonly insertPending: (petId: PetId, caregiverUserId: UserId, now: DateTime.Utc) =>
    Effect.Effect<PetCaregiver, DomainPersistenceError | CaregiverRelationshipExists>
  readonly setPendingResponse: (
    petId: PetId,
    caregiverUserId: UserId,
    status: "accepted" | "rejected",
    now: DateTime.Utc
  ) => Effect.Effect<PetCaregiver, DomainPersistenceError | CaregiverInvitationNotPending>
  readonly remove: (petId: PetId, caregiverUserId: UserId) =>
    Effect.Effect<boolean, DomainPersistenceError>
  readonly listForPet: (petId: PetId) =>
    Effect.Effect<ReadonlyArray<PetCaregiver>, DomainPersistenceError>
  readonly listPendingForUser: (caregiverUserId: UserId) =>
    Effect.Effect<ReadonlyArray<PetCaregiver>, DomainPersistenceError>
  readonly listAcceptedForUser: (caregiverUserId: UserId) =>
    Effect.Effect<ReadonlyArray<PetCaregiver>, DomainPersistenceError>
}
```

All mutation methods participate in ambient `PgClient` transaction and never send Telegram output.

- [x] **Step 5: Type-check contracts**

Run: `pnpm --filter carneloot-bot check`
Expected: contract fixture compiles; production adapter remains missing until next task.

### Task 5: Implement PostgreSQL repositories

- [x] **Step 1: Write failing real-PostgreSQL cases**

Cover pending insertion, duplicate relation, legal response, repeated response rejection, removal of each status, cascade on pet deletion, accepted-only accessible listing, pending/rejected exclusion, owner deduplication, deterministic ordering, bot-scoped case-insensitive username lookup, zero matches, and multiple matches.

Run: `pnpm --filter carneloot-bot test:integration -- PetCaregiverRepository.integration.test.ts`
Expected: FAIL because live methods/layer are absent.

- [x] **Step 2: Implement user and pet queries**

Use parameterized `@effect/sql-pg` templates. `lockById` uses `FOR UPDATE`. `listAccessible` joins accepted caregiver rows and never grants access from pending/rejected rows.

- [x] **Step 3: Implement caregiver adapter**

Decode complete rows through `PetCaregiver` schema, map SQL uniqueness to `CaregiverRelationshipExists`, and map malformed rows to non-retryable `DomainPersistenceError`. `setPendingResponse` uses one conditional `UPDATE ... WHERE status = 'pending' RETURNING ...`.

- [x] **Step 4: Compose and export layer**

Merge live adapter in `RepositoriesLive.ts`; export contract and adapter from `main.ts`. Do not export test fakes.

- [x] **Step 5: Run integration tests**

Run: `pnpm --filter carneloot-bot test:integration -- PetCaregiverRepository.integration.test.ts IdentityPets.integration.test.ts`
Expected: PASS with real PostgreSQL and no existing identity/pet regression.

- [x] **Step 6: Commit repositories**

```bash
git add apps/carneloot-bot/src/ports apps/carneloot-bot/src/postgres apps/carneloot-bot/src/main.ts apps/carneloot-bot/test/caregivers apps/carneloot-bot/test/IdentityPets.integration.test.ts
git commit -m "feat(carneloot): persist caregiver access"
```

### Task 6: Generalize transactional food authorization

- [x] **Step 1: Write failing authorization tests**

Extend `PetFoodApplication.test.ts` and integration coverage for owner access, accepted-caregiver access, pending/rejected denial, actor attribution, identity reassignment denial, and revocation between selection and mutation.

- [x] **Step 2: Replace owner-shaped access input**

Change `PetFoodAccess` to:

```ts
export interface PetFoodAccess {
  readonly actorId: UserId
  readonly botId: BotId
  readonly telegramUserId: TelegramUserId
  readonly petId: PetId
}
export interface AuthorizedPetFoodAccess {
  readonly actorId: UserId
  readonly ownerId: UserId
  readonly pet: Pet
  readonly role: "owner" | "caregiver"
}
```

`authorize` resolves current Telegram identity, verifies it still maps to `actorId`, locks pet, and accepts only owner or accepted caregiver. It returns actual owner separately from actor.

- [x] **Step 3: Update food services**

`AddFood` persists `recordedBy: authorized.actorId` and schedules reminder with `ownerUserId: authorized.ownerId`. `GetFoodStatus` resolves accessible pets and reauthorizes each under transaction. Owner-only day-start and delay services continue requiring owner role.

- [x] **Step 4: Update conversation startup state**

Replace persisted `ownerId` fields used as caller identity with `actorId`; keep pet owner only as display data when needed. Final input handlers pass current transition update/message IDs, preserving existing source semantics until Plan 3 strengthens them.

- [x] **Step 5: Run focused tests**

Run: `pnpm --filter carneloot-bot test -- PetFoodApplication.test.ts PetFoodCommands.test.ts PetFoodConversations.test.ts`
Expected: PASS for existing owner behavior plus new caregiver authorization cases.

Run: `pnpm --filter carneloot-bot test:integration -- PetFood.integration.test.ts PetCaregiverRepository.integration.test.ts`
Expected: PASS with revocation rollback and correct `recorded_by`.

- [x] **Step 6: Commit access integration**

```bash
git add apps/carneloot-bot/src/application apps/carneloot-bot/src/bot apps/carneloot-bot/test/pet-food
git commit -m "feat(carneloot): authorize accepted caregivers for food"
```

### Task 7: Validate plan outcome

- [x] **Step 1: Run package gate**

Run: `pnpm format && pnpm lint && pnpm --filter carneloot-bot check && pnpm --filter carneloot-bot test`
Expected: formatting/lint/type-check and all Carneloot unit tests PASS.

- [x] **Step 2: Run PostgreSQL gate**

Run: `pnpm --filter carneloot-bot test:integration -- PetCaregiverRepository.integration.test.ts PetFood.integration.test.ts IdentityPets.integration.test.ts`
Expected: all caregiver/access SQL cases PASS.

- [x] **Step 3: Review**

Review migration constraints, SQL parameterization, accepted-only access, actor/owner separation, and absence of Telegram calls inside transactions. Record review findings before Plan 2 or 3 starts.

## Acceptance criteria

- Caregiver status is database- and schema-constrained to pending/accepted/rejected.
- Duplicate/self invitation cannot create a second relation.
- Only owner and accepted caregiver pass food authorization.
- Actual actor is stored in `pet_food_entries.recorded_by`; owner remains reminder owner.
- Username lookup is bot-scoped, case-insensitive, and ambiguity-safe.
- Revocation between UI selection and mutation rolls back mutation.
- Existing owner food loop remains green.

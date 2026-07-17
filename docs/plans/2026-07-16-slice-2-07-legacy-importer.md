# Slice 2 Legacy SQLite/libSQL Importer Implementation Plan

**Goal:** Provide standalone dry-run-capable importer that validates legacy Carneloot data, deterministically promotes safe rows to PostgreSQL, and rebuilds reminders without duplication.

**Architecture:** Import pipeline has read-only source, pure decode/map/verify, serializable target promotion, and post-commit reminder rebuild phases. Deterministic UUIDv5 IDs plus source ledger make reruns auditable and idempotent; unsafe records are explicit report entries, never guessed.

**Tech Stack:** Effect Config/Schema/Crypto, @libsql/client 0.15.15, @effect/sql-pg, PostgreSQL, Bun/Node, Vitest.

---

## File map

- Create: `apps/carneloot-bot/migrations/0009_import_targets.sql`
- Create: `apps/carneloot-bot/src/postgres/Migration0009Sql.ts`
- Create: `apps/carneloot-bot/src/importer/LegacyImportConfig.ts`
- Create: `apps/carneloot-bot/src/importer/LegacyImportError.ts`
- Create: `apps/carneloot-bot/src/importer/LegacySource.ts`
- Create: `apps/carneloot-bot/src/importer/LegacySourceLive.ts`
- Create: `apps/carneloot-bot/src/importer/LegacySchemas.ts`
- Create: `apps/carneloot-bot/src/importer/LegacyId.ts`
- Create: `apps/carneloot-bot/src/importer/LegacyMapping.ts`
- Create: `apps/carneloot-bot/src/importer/LegacyVerification.ts`
- Create: `apps/carneloot-bot/src/importer/LegacyReport.ts`
- Create: `apps/carneloot-bot/src/importer/LegacyTarget.ts`
- Create: `apps/carneloot-bot/src/importer/LegacyTargetLive.ts`
- Create: `apps/carneloot-bot/src/importer/LegacyImporter.ts`
- Create: `apps/carneloot-bot/src/importer/RebuildFeedingReminders.ts`
- Create: `apps/carneloot-bot/src/importer/Cli.ts`
- Create: `apps/carneloot-bot/src/importer-bin.ts`
- Create: `apps/carneloot-bot/test/importer/LegacyId.test.ts`
- Create: `apps/carneloot-bot/test/importer/LegacyMapping.test.ts`
- Create: `apps/carneloot-bot/test/importer/LegacyVerification.test.ts`
- Create: `apps/carneloot-bot/test/importer/LegacyImporter.integration.test.ts`
- Create: `apps/carneloot-bot/test/importer/LegacyImporterCli.test.ts`
- Create: `apps/carneloot-bot/test/importer/fixtures/valid.sql`
- Create: `apps/carneloot-bot/test/importer/fixtures/unsafe.sql`
- Modify: `apps/carneloot-bot/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/carneloot-bot/src/postgres/AppMigrator.ts`
- Modify: `apps/carneloot-bot/src/main.ts`
- Modify: `apps/carneloot-bot/test/MigrationArtifact.test.ts`
- Modify: `apps/carneloot-bot/test/Config.test.ts`

### Task 1: Add dormant target schema for preserved Slice 3 data

- [ ] **Step 1: Write failing migration assertions**

Require migration version 9 and exact constraints for API key hashes, owner-scoped template keywords, subscriptions, and import ledger.

- [ ] **Step 2: Create target migration**

```sql
CREATE TABLE carneloot.api_keys (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES carneloot.users(id) ON DELETE CASCADE,
  key_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT api_keys_sha256_check CHECK (key_hash ~ '^[0-9a-f]{64}$')
);
CREATE TABLE carneloot.notification_templates (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES carneloot.users(id) ON DELETE CASCADE,
  keyword text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT notification_templates_keyword_nonempty CHECK (octet_length(keyword) BETWEEN 1 AND 128),
  CONSTRAINT notification_templates_message_nonempty CHECK (octet_length(message) BETWEEN 1 AND 4096),
  CONSTRAINT notification_templates_owner_keyword_key UNIQUE (owner_user_id, keyword)
);
CREATE TABLE carneloot.notification_subscriptions (
  template_id uuid NOT NULL REFERENCES carneloot.notification_templates(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES carneloot.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (template_id, user_id)
);
CREATE TABLE carneloot.legacy_import_ledger (
  source_fingerprint text NOT NULL,
  source_table text NOT NULL,
  source_key text NOT NULL,
  target_table text NOT NULL,
  target_key text NOT NULL,
  row_digest text NOT NULL,
  imported_at timestamptz NOT NULL,
  PRIMARY KEY (source_fingerprint, source_table, source_key),
  CONSTRAINT legacy_import_ledger_fingerprint_nonempty CHECK (octet_length(source_fingerprint) BETWEEN 1 AND 128),
  CONSTRAINT legacy_import_ledger_digest_check CHECK (row_digest ~ '^[0-9a-f]{64}$')
);
```

Tables are persistence-only in Slice 2; no command/API reads them.

- [ ] **Step 3: Generate/register artifact**

Generate exact SQL bytes/checksum:

```bash
node --input-type=module <<'NODE'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
const sql = readFileSync('apps/carneloot-bot/migrations/0009_import_targets.sql', 'utf8')
const checksum = createHash('sha256').update(sql).digest('hex')
writeFileSync(
  'apps/carneloot-bot/src/postgres/Migration0009Sql.ts',
  `// Generated from migrations/0009_import_targets.sql; do not edit.\nexport const migration0009Sql = ${JSON.stringify(sql)};\nexport const migration0009Checksum = ${JSON.stringify(checksum)};\n`
)
NODE
```

Register version 9 and extend artifact test.

- [ ] **Step 4: Run migration tests**

Run: `pnpm --filter carneloot-bot test -- MigrationArtifact.test.ts`
Expected: PASS for versions 1–9 and exact checksums.

- [ ] **Step 5: Commit target schema**

```bash
git add apps/carneloot-bot/migrations/0009_import_targets.sql apps/carneloot-bot/src/postgres/Migration0009Sql.ts apps/carneloot-bot/src/postgres/AppMigrator.ts apps/carneloot-bot/test/MigrationArtifact.test.ts
git commit -m "feat(carneloot): add legacy import target tables"
```

### Task 2: Add importer-only config and read-only source service

- [ ] **Step 1: Write failing config/CLI tests**

Cover required source URL/source ID/bot ID/target database, redacted source token, `--dry-run`, `--report`, unknown flag, missing value, and no legacy config requirement during normal bot startup.

Run: `pnpm --filter carneloot-bot test -- LegacyImporterCli.test.ts`
Expected: FAIL because importer config/CLI and libSQL source module do not exist.

- [ ] **Step 2: Add pinned dependency/script**

Add `"@libsql/client": "0.15.15"` to app dependencies and script:

```json
"import:legacy": "bun src/importer-bin.ts"
```

Run: `pnpm install`
Expected: lockfile updates with pinned libSQL client.

- [ ] **Step 3: Define separate config**

`LegacyImportConfig` reads:

```text
LEGACY_DATABASE_URL
LEGACY_DATABASE_AUTH_TOKEN (optional Redacted)
LEGACY_SOURCE_ID
DATABASE_URL (Redacted)
BOT_ID
```

CLI flags `--source-url`, `--source-auth-token`, `--source-id`, `--bot-id`, `--database-url`, `--dry-run`, and `--report <path>` override environment. Help exits 0; invalid args exit 2. Importer config is never merged into production `Config`.

- [ ] **Step 4: Implement read-only source port**

`LegacySource` exposes typed `readSnapshot`, not arbitrary SQL. Live acquisition creates libSQL client, executes `PRAGMA query_only = ON`, verifies it reports enabled, and reads every table in deterministic primary-key order. File URLs retain/read with read-only mode; remote clients still expose only select statements through this service. Scope closes client.

- [ ] **Step 5: Verify source remains unchanged**

Fixture test hashes every source table before/after dry-run/import. A test-only attempted write after `PRAGMA query_only` must fail.

- [ ] **Step 6: Run config/source tests**

Run: `pnpm --filter carneloot-bot test -- Config.test.ts LegacyImporterCli.test.ts`
Expected: PASS; normal bot config remains independent.

- [ ] **Step 7: Commit source/config**

```bash
git add apps/carneloot-bot/package.json pnpm-lock.yaml apps/carneloot-bot/src/importer apps/carneloot-bot/src/importer-bin.ts apps/carneloot-bot/test/importer apps/carneloot-bot/test/Config.test.ts
git commit -m "feat(carneloot): read legacy database safely"
```

### Task 3: Schema-decode complete legacy snapshot

- [ ] **Step 1: Write failing source-schema tests**

Decode valid and malformed rows for all tables: `users`, `pets`, `pet_carers`, `pet_food`, `configs`, `api_keys`, `notifications`, `users_to_notify`, `notification_history`, and `sessions`. Validate non-empty IDs, finite quantity, safe integer Telegram/message/timestamps, nullable FKs, status literals, and JSON config values.

- [ ] **Step 2: Implement Effect schemas**

Define one schema per raw table and one `LegacySnapshot` struct. Convert libSQL integers/strings through explicit codecs; malformed rows become report entries containing table, source key, and schema issue path. Never include API-key hash, template body, auth token, or raw private payload in report/logs.

- [ ] **Step 3: Mark excluded state**

`sessions` rows are counted as excluded with reason `conversation-state-not-migrated`. Report also states `bullmq-jobs-not-migrated`; importer never connects to Redis.

- [ ] **Step 4: Run schema tests**

Run: `pnpm --filter carneloot-bot test -- LegacyVerification.test.ts -t "source schema"`
Expected: PASS with sanitized failures and excluded-state counts.

- [ ] **Step 5: Commit schemas**

```bash
git add apps/carneloot-bot/src/importer/LegacySchemas.ts apps/carneloot-bot/src/importer/LegacySource.ts apps/carneloot-bot/test/importer/LegacyVerification.test.ts
git commit -m "feat(carneloot): decode legacy source rows"
```

### Task 4: Implement deterministic IDs and row mapping

- [ ] **Step 1: Write UUIDv5 test vectors**

Test fixed namespace/name vectors, same-input stability, table separation, source-fingerprint separation, valid UUID version/variant bits, and Node/Bun Crypto Layers.

- [ ] **Step 2: Implement UUIDv5 through `effect/Crypto`**

Use fixed committed namespace UUID. Hash namespace bytes plus UTF-8 `${sourceFingerprint}:${table}:${legacyId}` with `Crypto.digest("SHA-1", ...)`; use first 16 bytes, set RFC 4122 version 5 and variant bits, format lowercase UUID, decode through existing `Uuid` schema. No random ID generation occurs.

- [ ] **Step 3: Define source fingerprint**

Identity fingerprint is SHA-256 of `legacy-source-v1\0${sourceId}` only. Explicit source ID is stable when same database moves to another URL; changing source ID intentionally creates distinct import namespace. Record sanitized source URL separately as non-identity provenance. Report only `sha256:<hex>` plus sanitized provenance; never credentials/query auth token.

- [ ] **Step 4: Map identity/pet/caregiver rows**

- user ID from legacy user ID;
- Telegram identity uses configured bot ID and safe numeric `telegram_id`;
- private chat equals Telegram user ID only because legacy bot conversations were private; unsafe/nonpositive IDs block user and dependents;
- pet ID/caregiver relation map FKs and preserve statuses;
- missing timestamps use one import-run `DateTime.Utc` value.

- [ ] **Step 5: Map food/settings rows**

- food ID deterministic from legacy food ID;
- grams convert with `Math.round(quantity * 1000)`;
- report rounding whenever exact product is non-integer, including source grams, result mg, and signed delta but no user text;
- preserve `time` instant;
- source bot is configured bot ID;
- source update ID derives from first safe 53 digest bits and collision validation blocks promotion;
- source message chat is recording user's reconstructed private chat only when message ID is safe; otherwise both message fields become null and warning is emitted;
- `pet:<id>/dayStart` maps legacy hour/timezone to typed local time/IANA zone;
- `notificationDelay` duration parts map to checked milliseconds;
- incomplete/invalid pair blocks that pet settings promotion rather than writing partial settings.

- [ ] **Step 6: Map keys/templates/subscriptions/history**

Preserve lowercase SHA-256 key hashes unchanged. Map notifications to templates and `users_to_notify` to subscriptions. Convert safe history to completed legacy events plus sent deliveries using reconstructed recipient private chat and exact bot/chat/message identity; choose role owner/caregiver/subscriber from referenced pet/template and current relation. Unsafe history is skipped and reported, never assigned guessed chat.

- [ ] **Step 7: Run mapping tests**

Run: `pnpm --filter carneloot-bot test -- LegacyId.test.ts LegacyMapping.test.ts`
Expected: PASS for stable IDs, rounding, settings, hash preservation, timestamp preservation, and history correlation.

- [ ] **Step 8: Commit mapping**

```bash
git add apps/carneloot-bot/src/importer/LegacyId.ts apps/carneloot-bot/src/importer/LegacyMapping.ts apps/carneloot-bot/test/importer/LegacyId.test.ts apps/carneloot-bot/test/importer/LegacyMapping.test.ts
git commit -m "feat(carneloot): map legacy data deterministically"
```

### Task 5: Verify graph and build sanitized report

- [ ] **Step 1: Write failing graph-verification tests**

Cover missing owner/caregiver/food actor/template/subscription FKs, duplicate owner pet names after normalization, self caregiver, source-update collision, duplicate API key hash, duplicate exact sent message identity, unknown config context/key, unsupported user `showNotifications`, and count accounting.

- [ ] **Step 2: Define report schema**

```ts
export interface LegacyImportReport {
  readonly mode: "dry-run" | "import"
  readonly sourceFingerprint: string
  readonly counts: Readonly<Record<string, {
    readonly source: number
    readonly accepted: number
    readonly skipped: number
    readonly existing: number
    readonly inserted: number
  }>>
  readonly rounding: ReadonlyArray<RoundingNotice>
  readonly warnings: ReadonlyArray<ImportIssue>
  readonly blockers: ReadonlyArray<ImportIssue>
  readonly reminderRebuild: "not-run" | "completed" | "failed"
}
```

Issues contain stable code/table/sourceKey/sanitized message. Sort by table/source key/code for deterministic JSON.

- [ ] **Step 3: Implement pre-promotion verification**

Verify every accepted FK, unique target key, row count equation `source = accepted + skipped`, and all blocking constraints before opening target transaction. Unknown config is warning/skipped; invalid known pet config is blocker. `showNotifications` is warning/skipped because no Slice 2 target preference exists.

- [ ] **Step 4: Write report atomically**

When `--report` is supplied, write temporary sibling file then rename. Always print one-line count summary; never print hashes/template bodies/private payloads. Blockers produce exit 1 after report and before target write.

- [ ] **Step 5: Run verification tests**

Run: `pnpm --filter carneloot-bot test -- LegacyVerification.test.ts LegacyImporterCli.test.ts`
Expected: PASS for deterministic counts/issues and secret sanitization.

- [ ] **Step 6: Commit verifier/report**

```bash
git add apps/carneloot-bot/src/importer/LegacyVerification.ts apps/carneloot-bot/src/importer/LegacyReport.ts apps/carneloot-bot/src/importer/Cli.ts apps/carneloot-bot/test/importer
git commit -m "feat(carneloot): verify and report legacy imports"
```

### Task 6: Promote verified rows idempotently

- [ ] **Step 1: Write failing PostgreSQL promotion tests**

Cover dry-run zero writes, full import, exact rerun, incompatible preexisting row, changed source row under same ledger key, FK/count verification, transaction rollback, and concurrent importer advisory lock.

- [ ] **Step 2: Implement target port**

`LegacyTarget.promote(mapped, report)` calls `sql.withTransaction`, executes `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` as first statement, acquires `pg_advisory_xact_lock(hashtextextended('carneloot:legacy-import:' || fingerprint, 0))`, and inserts in dependency order: users, identities, pets, caregivers, settings, food, keys, templates, subscriptions, imported history events/deliveries, ledger. Retry SQLSTATE `40001` with an Effect schedule capped at three attempts before reporting target-unavailable; no other SQL failure is retried.

- [ ] **Step 3: Enforce ledger semantics**

For every mapped row compute SHA-256 canonical JSON digest. Existing ledger with same digest requires canonical target row match and increments `existing`. Different digest/missing target aborts. No ledger plus exact deterministic target row may be adopted by inserting ledger; incompatible target row aborts. New row and ledger insert share transaction.

- [ ] **Step 4: Verify after writes before commit**

Query target counts and every imported FK/unique key inside same transaction. Any mismatch fails and rolls back entire promotion. Dry-run never calls `promote`.

- [ ] **Step 5: Run promotion integration tests**

Run: `pnpm --filter carneloot-bot test:integration -- LegacyImporter.integration.test.ts -t "promotion"`
Expected: first run inserts, rerun inserts zero, conflicts/verification failures leave zero partial writes.

- [ ] **Step 6: Commit promotion**

```bash
git add apps/carneloot-bot/src/importer/LegacyTarget.ts apps/carneloot-bot/src/importer/LegacyTargetLive.ts apps/carneloot-bot/test/importer/LegacyImporter.integration.test.ts
git commit -m "feat(carneloot): promote legacy data idempotently"
```

### Task 7: Rebuild reminders and wire standalone program

- [ ] **Step 1: Write failing rebuild tests**

For imported pets: latest food+valid delay schedules one reminder; no food/delay schedules none; backdated entries choose latest; repeated rebuild leaves one stable job; failure reports nonzero exit while imported data remains committed.

- [ ] **Step 2: Implement rebuild service**

List imported pets with complete settings and latest food in deterministic order. Call `ReminderScheduler.replaceForLatest` per pet using configured bot/owner and `fedAt + delay`. Stable conflict key makes rerun idempotent. Run only after successful promotion; dry-run reports `not-run`.

- [ ] **Step 3: Compose importer program**

`LegacyImporter.run` executes acquire/read/decode/map/verify/report; exits before target for dry-run/blockers; otherwise migrates target schema, promotes, rebuilds reminders, verifies final counts, writes report. `importer-bin.ts` supplies Bun platform HTTP/Crypto/filesystem and PostgreSQL Layers. Node test entry supplies Node Layers.

- [ ] **Step 4: Export importer API without startup coupling**

Export importer modules from app `main.ts` for tests/administration. Do not import `LegacyImporter`, libSQL, or importer config from `Program.ts`, `Production.ts`, `AppLive.ts`, or normal `bin.ts`.

- [ ] **Step 5: Run complete fixture tests**

Run: `pnpm --filter carneloot-bot test:integration -- LegacyImporter.integration.test.ts`
Expected: valid fixture imports all mapped tables, preserves timestamps/hashes, reports rounding/skips, rebuilds reminders, and exact rerun inserts nothing.

Run: `pnpm --filter carneloot-bot test -- LegacyImporterCli.test.ts LegacyMapping.test.ts LegacyVerification.test.ts`
Expected: dry-run/CLI/unit cases PASS.

- [ ] **Step 6: Smoke both runtimes**

Run importer tests through existing Vitest Node runtime, then:

```bash
bun test apps/carneloot-bot/test/importer/LegacyId.test.ts apps/carneloot-bot/test/importer/LegacyMapping.test.ts
```

Expected: deterministic mapping tests PASS under Bun 1.3.x.

- [ ] **Step 7: Run package gate and commit**

Run: `pnpm format && pnpm lint && pnpm --filter carneloot-bot check && pnpm --filter carneloot-bot test`
Expected: PASS.

```bash
git add apps/carneloot-bot/src/importer apps/carneloot-bot/src/importer-bin.ts apps/carneloot-bot/src/main.ts apps/carneloot-bot/package.json pnpm-lock.yaml apps/carneloot-bot/test/importer
git commit -m "feat(carneloot): import legacy data safely"
```

## Acceptance criteria

- Importer is separate from bot startup and source remains read-only.
- Dry-run performs full decode/map/verification and writes zero target rows/jobs.
- IDs, source update IDs, and ledger keys are deterministic.
- Row counts and FKs verify before and after promotion.
- Gram rounding, unsafe records, excluded Redis/session/jobs, and unsupported config are reported.
- Food timestamps and API-key hashes are preserved.
- Private message identity is reconstructed only from safe related Telegram user.
- Exact rerun creates no duplicate rows or reminders.
- Generic notification/API behavior remains unimplemented despite preserved data tables.

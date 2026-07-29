# Slice 2 shared pet-food runbook

## Safe local setup

Use local disposable PostgreSQL and encrypted local Telegram configuration. Do not paste tokens, database URLs, API hashes, chat IDs, or report identifiers into this document or shell history.

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
docker compose -f apps/carneloot-bot/compose.yaml up -d --wait
cp apps/carneloot-bot/.env.example apps/carneloot-bot/.env
export FNOX_AGE_KEY_FILE="$HOME/.config/fnox/age.txt"
# Set TEST_DATABASE_URL through approved environment loader to an empty disposable database.
mise exec -- pnpm --filter carneloot-bot demo:test
mise exec -- pnpm --filter carneloot-bot demo
```

`demo:test` never drops schemas. Reuse requires another fresh disposable database, or opt into Testcontainers with `RUN_TESTCONTAINERS=true`. Start one polling replica only. Stop it before schema recovery, importer cutover, rollback, or replacement deployment.

## Two-user Telegram transcript

Use owner and caregiver test accounts. Replace names with local test values.

1. Owner: `/cadastrar`, `/adicionar_pet`, then pet name.
2. Caregiver: `/cadastrar`.
3. Owner: `/adicionar_cuidador`, choose pet, then caregiver username.
4. Caregiver: `/convites_pet`, choose invitation, then accept.
5. Owner: `/listar_cuidadores`; caregiver: `/listar_pets`.
6. Caregiver: `/colocar_racao`, choose shared pet, enter amount.
7. Owner: `/colocar_racao_todos <amount>`; repeat through `/todos <amount>`.
8. Owner: `/corrigir_racao` and `/deletar_racao`; follow selection keyboards.
9. Caregiver: `/parar_de_cuidar_pet`; owner confirms with `/listar_cuidadores`.

Finite selections show `Cancelar`. Send `/cancelar` to exit active conversation. Free-text and terminal replies remove keyboard. Reply to feeding reminder to record food; reply to source food message to start safe correction/deletion. Pending, rejected, or removed caregivers cannot mutate shared food or use reply shortcut.

## Database and reminder checks

Use approved read-only local tooling to verify one owner, accepted caregiver relation before leave, food rows keyed by Telegram update/pet, notification event, recipient deliveries, and scheduled jobs. Do not copy query output containing identifiers into this runbook.

Reminder run uses normal clock: configure reminder delay, wait through delay, then verify owner and accepted caregiver delivery. Delivery is at-least-once: `sent` is definitive; `unknown` means do not blindly resend. Food-added notifications exclude actor and recheck recipient access before sending.

For deterministic local proof, `demo:test` advances scheduled job row after its single-owner transcript and prints only sanitized counts, delivery mode, durable deduplication, and declared jobs. It does not claim shared-food capability; complete two-user transcript above to verify caregiver access and food mutation.

## Legacy importer fixture

Create backup before importer promotion. Dry-run fixture first; report path must be local and sanitized.

```sh
mise exec -- pnpm --filter carneloot-bot import:legacy -- migrate --database-url "$DATABASE_URL"
mise exec -- pnpm --filter carneloot-bot import:legacy -- import --dry-run --source-url file:./fixture.db --source-id fixture --bot-id carneloot --database-url "$DATABASE_URL" --report ./legacy-report.json
mise exec -- pnpm --filter carneloot-bot import:legacy -- import --source-url file:./fixture.db --source-id fixture --bot-id carneloot --database-url "$DATABASE_URL" --report ./legacy-report.json
```

Promote only zero-blocker dry-run. Import rerun is ledgered. Cutover rollback requires stopped polling and verified backup restore; never mix old and new writers.

## Cleanup

Stop bot, remove disposable database volume, delete fixture/report files, and unset temporary environment variables. Preserve encrypted key outside repository.

## Validation record

2026-07-28 focused release validation used Node 24.18.0, Bun 1.3.14, and disposable PostgreSQL 17 Testcontainers. Output contains no token, URL, API hash, private identifier, or message payload.

| Command | Outcome |
| --- | --- |
| `mise exec -- pnpm check` | passed |
| `mise exec -- pnpm exec vitest run apps/carneloot-bot/test/DemoSummary.test.ts packages/tfx/test/package-exports.test.ts` | passed (2 tests) |
| `mise exec -- pnpm check:tfx:package` | passed |
| `mise exec -- pnpm check:packed` | passed (argumentless archive proof) |
| `mise exec -- pnpm check:packed:consumers` | passed (Node and Bun packed consumers) |
| `RUN_TESTCONTAINERS=true mise exec -- pnpm --filter carneloot-bot demo:test` | passed (sanitized Slice 2 summary) |

Full Node/Bun suites remain release gate work; run them before promotion.

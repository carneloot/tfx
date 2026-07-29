# Slice 2 Complete Shared Pet-Food System Implementation Plan Roadmap

**Goal:** Deliver complete caregiver lifecycle, shared pet-food mutations, safe reply workflows, caregiver notifications, validated legacy import, and consistent conversation keyboards through nine dependency-ordered plans.

**Architecture:** Slice 2 extends completed Slice 1 without duplicating tfx, PostgreSQL, or test infrastructure. Portable message-handler declarations belong in `tfx`; all caregiver, food, notification, and import behavior remains owned by `apps/carneloot-bot`, with domain writes sharing one `PgClient` transaction and Telegram output occurring after commit.

**Tech Stack:** TypeScript 7, Effect 4.0.0-beta.98, tfx, @tfx/postgres, pnpm 10.17.1, Node 24.18.0, Bun 1.3.14, Vitest 4.1.10, PostgreSQL, libSQL.

---

## Locked planning resolutions

1. **Caregiver relationship and transitions.** `pet_caregivers` uses `(pet_id, caregiver_user_id)` as primary key and status `pending | accepted | rejected`. An absent relation may become pending; invitee alone may change pending to accepted/rejected; owner may remove any status; accepted caregiver may remove their own relation. Reinviting an existing relation reports translated current status without changing it.
2. **Username lookup is bot-scoped and ambiguity-safe.** Invitations normalize one optional leading `@` and compare case-insensitively against refreshed `telegram_identities.username` for the current bot. Zero matches reports unregistered; more than one match reports ambiguity and performs no write. Username remains nullable and non-unique in storage.
3. **Selections never authorize.** Conversation state stores IDs and display snapshots only. Every protected read and final mutation resolves current Telegram identity and rechecks owner or accepted-caregiver access. Pet deletion or revocation during a conversation ends without mutation, removes keyboards, and reports lost access.
4. **Accessible pets have one ordering.** Owned and accepted-caregiver pets are returned once, alphabetically by normalized pet name and then pet ID. Pending/rejected relations grant no food access. Owner-only settings and caregiver administration remain owner-only.
5. **`/todos` permits explicit partial domain success.** Amount syntax is decoded once; optional local date/time text is interpreted independently per accessible pet timezone and anchored to Telegram message instant, never delayed processing clock. Each pet runs in its own bounded transaction, concurrently with a fixed limit of four. Setup, duplicate, or access failures are reported by pet while valid pets commit. Infrastructure failure remains retryable; `(source_bot_id, source_update_id, pet_id)` replays completed pets on redelivery. Zero successful/replayed pets never emits a success reaction.
6. **Food correction/deletion reconciles one stable reminder.** Every mutation locks pet and selected entries, computes previous and resulting latest entry, then atomically replaces `feeding-reminder:<petId>` from resulting latest entry or cancels it when none/config disabled. Backdated changes leave the latest reminder unchanged. Deleting a pet cancels its active reminder before cascade deletion in the same transaction.
7. **Reply correlation is exact and precedence is fixed.** Existing lifecycle/cancel/conversation/command routing retains priority. Remaining registered-user message handling checks sent notification identity `(bot_id, recipient_chat_id, telegram_message_id)` first, then food source identity `(source_bot_id, source_message_chat_id, source_message_id)`. No global message-ID query exists. Feeding-reminder replies add food to event pet. Food-source replies correct only currently accessible correlated entries; zero accessible matches behaves as unrelated input and reveals no records.
8. **Notification recipient sets freeze once.** Reminder recipient materialization resolves owner plus currently accepted caregivers at dispatch time under event lock. Food-added events create actor-excluded owner/caregiver deliveries and immediate delivery job inside food transaction. `recipients_materialized_at` prevents retries from adding newly accepted caregivers. Before a caregiver send, access is rechecked; revoked recipients become permanent failed without Telegram call. Food-added sends use `disable_notification: true`.
9. **Notification outcome semantics stay unchanged.** Each delivery remains independently fenced `pending → sending → sent | failed | unknown`; expired `sending` becomes `unknown`; `sent` and `unknown` never auto-retry. Telegram calls remain outside SQL transactions.
10. **Reply-based multi-entry correction is atomic and replay-safe for visible matches.** One `/todos` source message may correlate several entries. Query joins current access, locks all visible rows, applies one parsed amount/time independently per pet timezone using reply message instant, and commits all visible corrections plus reminder reconciliation together. `food_reply_operations` records sanitized result by `(bot_id, update_id)` in same transaction so output failure/redelivery cannot repeat mutation.
11. **Importer validates before promotion.** Standalone CLI opens legacy libSQL read-only, schema-decodes every source row, builds deterministic records, and writes nothing during validation. Unsafe records are reported with table/key/reason; required-parent or invalid-config failures block promotion. Optional history rows lacking safe chat identity are skipped and counted.
12. **Importer promotion is repeatable.** One PostgreSQL serializable transaction, guarded by an advisory lock, upserts deterministic UUIDv5-mapped rows and a ledger keyed by `(source_fingerprint, source_table, source_key)`. Exact rerun is a no-op; incompatible existing target data aborts promotion. Dry-run performs source read, mapping, verification, and report only. Post-commit reminder rebuild is separately idempotent through stable per-pet conflict keys.
13. **Importer prepares Slice 3 data, not behavior.** Slice 2 creates and imports `api_keys`, `notification_templates`, and `notification_subscriptions` because hashes/templates/subscriptions must survive cutover. It adds no API-key command, external notification endpoint, template-management API, or subscriber reply forwarding.
14. **Finite choices use keyboards.** Every conversation step whose valid responses form a finite rendered set uses one typed reply keyboard. Open-ended names, usernames, amounts/timestamps, durations, and timezones remain text input. Selection/action keyboards expose `Cancelar`; free-text and terminal boundaries remove stale keyboards. Button selection never replaces current access rechecks.
15. **No parallel test framework.** All plans extend Slice 1 helpers under `apps/carneloot-bot/test` and `packages/tfx/test/internal`. Public `@tfx/testing*` extraction remains Slice 4.

## Plans and dependency order

| Order | Plan | Status | Depends on | Verifiable outcome |
|---:|---|---|---|---|
| 1 | [`slice-2-01-caregiver-access-kernel`](./2026-07-16-slice-2-01-caregiver-access-kernel.md) | Complete | Slice 1 | Effect-based migration artifact generator plus persisted caregiver access kernel |
| 2 | [`slice-2-02-caregiver-command-workflows`](./2026-07-16-slice-2-02-caregiver-command-workflows.md) | Complete | 1 | Pet deletion and five caregiver commands with durable conversations |
| 3 | [`slice-2-03-shared-food-and-todos`](./2026-07-16-slice-2-03-shared-food-and-todos.md) | Complete | 1 | Shared pet listing/status/addition plus replay-safe `/colocar_racao_todos` and `/todos` |
| 4 | [`slice-2-04-food-correction-deletion`](./2026-07-16-slice-2-04-food-correction-deletion.md) | Complete | 1, 3 | Correct/delete food workflows with atomic reminder repair |
| 5 | [`slice-2-05-caregiver-notifications`](./2026-07-16-slice-2-05-caregiver-notifications.md) | Complete | 1, 3 | Frozen owner/caregiver reminder recipients and silent food-added deliveries |
| 6 | [`slice-2-06-message-reply-routing`](./2026-07-16-slice-2-06-message-reply-routing.md) | Pending | 3–5 | Typed tfx message handlers plus durable, safe reminder/source reply mutations |
| 7 | [`slice-2-07-legacy-importer`](./2026-07-16-slice-2-07-legacy-importer.md) | Pending | 1, 4, 5 | Dry-run-capable, deterministic, verified SQLite/libSQL-to-PostgreSQL importer |
| 7.5 | [`slice-2-07-5-conversation-keyboards`](./2026-07-16-slice-2-07-5-conversation-keyboards.md) | Pending | 2–4 | Every finite conversation choice rendered through a typed reply keyboard with complete removal/cancellation proof |
| 8 | [`slice-2-08-integration-release`](./2026-07-16-slice-2-08-integration-release.md) | Pending | 1–7.5 | Real-PostgreSQL end-to-end milestone proof under Node and Bun |

```text
01 ─┬→ 02
    └→ 03 ─┬→ 04 ─┬→ 06
            └→ 05 ─┘
01, 04, 05 ───────→ 07
02, 03, 04 ───────→ 07.5
02, 03, 04, 05, 06, 07, 07.5 → 08
```

Plans 2 and 3 may proceed independently after Plan 1. Plan 5 needs shared actor/owner semantics from Plan 3. Plan 7 targets final Slice 2 schema and therefore follows Plans 1, 4, and 5. Plan 7.5 normalizes conversation UX after the relevant workflows exist and must finish before Plan 8 release proof.

## Cross-plan invariants

- `packages/tfx` imports no PostgreSQL, Carneloot, Node-only, Bun-only, or libSQL module.
- Carneloot imports only public `tfx/*` and `@tfx/postgres/*` exports.
- Handlers contain no SQL; application services orchestrate ports and PostgreSQL adapters implement persistence.
- All application repositories use one provided `PgClient.PgClient`, preserving ambient conversation transactions.
- Every owner/caregiver mutation rechecks access inside transaction after row lock.
- Every food source uses actual update/message that caused mutation, not conversation-start update.
- PostgreSQL stores Telegram numeric IDs as `bigint`, food as integer milligrams, and instants as `timestamptz`.
- Application `.sql` migrations are canonical; every `MigrationNNNNSql.ts` artifact is generated or checked through `pnpm --filter carneloot-bot migrations:generate|check`, never hand-copied.
- Tests use `TestClock`; SQL semantics use real PostgreSQL.
- Each plan receives fresh review before dependent implementation starts.
- Each commit leaves owned focused tests and `pnpm check` green.

## Primary references

- Approved design: `docs/specs/2026-07-14-tfx-carneloot-design.md`, sections 7, 9, 10, 12, 14, and Slice 2 in section 15.
- Legacy behavior: `CARNELOOT_BOT_FEATURES.md`, pet management, pet-food tracking, reply-driven features, notifications, and data model sections.
- Completed baseline: `docs/archive/plans/2026-07-14-slice-1-roadmap.md` and current `apps/carneloot-bot` implementation.
- Legacy source schema: `.repos/carneloot-bot/src/lib/database/schema.ts`.

## Slice 2 exclusions

`/start`, `/ping`, `/whats`, `/cafe`, `/cafe_inv`, `/gerar_chave`, hello easter egg, generic external notification delivery, subscriber reply forwarding, authenticated `/api/notify`, webhook transport/CLI, final 24-command menu, production tracing/deployment, production UUID refactor, public testing packages, and npm publication remain later slices.

# Slice 1 Owned-Pet Food Loop Implementation Plan Roadmap

**Goal:** Deliver smallest complete tfx-backed Carneloot owned-pet food loop through twelve bounded, dependency-ordered plans.

**Architecture:** Portable Telegram, declaration, conversation, job, deduplication, and polling contracts live in `tfx`; PostgreSQL implementations live in `@tfx/postgres`; Carneloot owns domain and notification persistence. Every plan ends with focused tests and a commit; final plan validates whole slice under Node 24.18.0, Bun 1.3.14, and real PostgreSQL.

**Tech Stack:** TypeScript 7, Effect 4.0.0-beta.98, pnpm 10.17.1, Node 24.18.0, Bun 1.3.14, Vitest 4.1.10, PostgreSQL, Changesets.

---

## Locked planning resolutions

1. **Job migration uses two fenced phases.** Claim writes a migration lease (`lease_phase = 'migration'`) and generation without incrementing `attempts`. A matching token atomically persists migrated payload/version and promotes row to `running`, switches phase to `execution`, and increments `attempts`. Migration failure quarantines through same token. Expired migration leases can be reclaimed without consuming attempts. Expired execution leases close prior attempt as `LeaseLost`, increment generation, return to migration validation without consuming another attempt, then consume exactly one new attempt on fenced promotion.
2. **Notification recipient role is extensible.** `notification_deliveries.recipient_role` is validated text, not a PostgreSQL enum/check union. Domain constructors initially expose `owner`, `caregiver`, and `subscriber`; Slice 1 emits `owner`, Slice 2 can emit `caregiver` without schema migration, and Slice 3 can emit `subscriber`.
3. **Slice 1 owns minimum notification persistence.** `notification_events` and `notification_deliveries` plus fenced `pending → sending → sent|failed|unknown` transitions ship now. Expired `sending` becomes `unknown`; `sent` and `unknown` never auto-retry. Reminder replies, generic templates/subscriptions, and HTTP response matrix remain later slices.
4. **Reminder recipients resolve at send time.** This respects later caregiver revocation/preferences. Unique `(event_id, recipient_user_id, channel)` rows make materialization idempotent.
5. **Conversation cancellation kernel ships now.** Slice 1 intercepts `/cancelar` as lifecycle behavior so no conversation is inescapable; Slice 3 owns public general-command declaration, complete menu placement, and parity acceptance.
6. **No reminder delay means reminders disabled, not failed food insertion.** Configuring delay schedules/reschedules from latest feeding; deleting delay cancels pending reminder. Food mutation remains successful without delay.
7. **Photon source pin:** `.repos/telegram-api` at `80e0bd5d3d3155985c1a4281aec729b73e294055` (`specs/telegram-bot-api.openapi.json`). Root licensing absence must be recorded before redistribution; generated output provenance is documented.
8. **Slice 1 release means runnable demonstration plus package dry-run.** No npm publish or production deployment occurs without separate approval.

## Plans and dependency order

| Order | Plan | Depends on | Verifiable outcome |
|---:|---|---|---|
| 1 | [`slice-1-01-workspace-toolchain`](./2026-07-14-slice-1-01-workspace-toolchain.md) | — | Reproducible pnpm/mise workspace and dual-runtime CI |
| 2 | [`slice-1-02-telegram-generation-facade`](./2026-07-14-slice-1-02-telegram-generation-facade.md) | 1 | Reproducible generated Telegram types/raw client and yieldable facade |
| 3 | [`slice-1-03-typed-bot-kernel`](./2026-07-14-slice-1-03-typed-bot-kernel.md) | 2 | Immutable declarations, exhaustive builders, middleware, contexts, keyboards |
| 4 | [`slice-1-04-conversation-kernel`](./2026-07-14-slice-1-04-conversation-kernel.md) | 3 | Typed persistent state machines and explicit memory storage |
| 5 | [`slice-1-05-jobs-dedup-memory`](./2026-07-14-slice-1-05-jobs-dedup-memory.md) | 4 | Versioned jobs, two-phase claims, dedup contracts, memory Layers |
| 6 | [`slice-1-06-polling-runtime`](./2026-07-14-slice-1-06-polling-runtime.md) | 2–5 | Exactly-one delivery, normalized routing, keyed concurrency, polling |
| 7 | [`slice-1-07-private-testing`](./2026-07-14-slice-1-07-private-testing.md) | 2–6 | One private reusable harness and storage conformance suites |
| 8 | [`slice-1-08-postgres-adapters`](./2026-07-14-slice-1-08-postgres-adapters.md) | 4, 5, 7 | Durable conversation/job/dedup Layers and coordinated migration |
| 9 | [`slice-1-09-carneloot-identity-pets`](./2026-07-14-slice-1-09-carneloot-identity-pets.md) | 1, 8 | PostgreSQL identity and owned-pet domain, `/cadastrar`, add/list pets |
| 10 | [`slice-1-10-pet-food-loop`](./2026-07-14-slice-1-10-pet-food-loop.md) | 4, 8, 9 | Food settings/status/insertion commands and transactional scheduling |
| 11 | [`slice-1-11-durable-reminders`](./2026-07-14-slice-1-11-durable-reminders.md) | 5, 8–10 | Persisted notification events/deliveries and fenced reminder sends |
| 12 | [`slice-1-12-integration-release`](./2026-07-14-slice-1-12-integration-release.md) | 1–11 | Bun application, E2E slice proof, dual-runtime gate, dry-run release |

```text
01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09 → 10 → 11 → 12
```

Plan 5 consumes `VersionedSchema` established by Plan 4. Keep one writer per working tree; review each plan before starting dependent work.

## Cross-plan invariants

- `packages/tfx` imports no PostgreSQL, Carneloot, Node-only, or Bun-only module.
- Carneloot imports only exported `tfx/*` and `@tfx/postgres/*` subpaths.
- All SQL services share application-provided `PgClient.PgClient` and ambient transactions.
- Telegram sends occur outside SQL transactions and are never blindly retried after ambiguous outcomes.
- Update processing acknowledges only `Handled`, `HandledWithOutputFailure`, `PermanentInvalid`, or already-completed dedup claims.
- Private helpers remain under `packages/tfx/test/internal` and `packages/postgres/test/internal`; package export tests prove they cannot be imported.
- Tests use `TestClock`; SQL semantics use real PostgreSQL.
- Each commit leaves `pnpm check` and owned focused tests green.

## Primary implementation references

- Design: `docs/specs/2026-07-14-tfx-carneloot-design.md`, especially sections 4–10, 14, and 15.
- Legacy behavior: `CARNELOOT_BOT_FEATURES.md` and `.repos/carneloot-bot/src/modules/{auth,pet,pet-food}`.
- Effect patterns: `.repos/effect/packages/effect/src/unstable/httpapi`, `Schema.ts`, `Context.ts`, `Stream.ts`, `unstable/sql/SqlClient.ts`, `unstable/ai/AiError.ts`, and `packages/tools/openapi-generator`.
- Telegram behavior: `.repos/grammy/src/bot.ts`, `context/composer/keyboard` tests, and `.repos/grammy-conversations/src`/tests.
- Telegram source: `photon-hq/telegram-api` commit `80e0bd5d3d3155985c1a4281aec729b73e294055`, file `specs/telegram-bot-api.openapi.json`.

## Slice 1 exclusions

Webhook transport/server, caregiver lifecycle, `/todos`, correction/deletion, reminder replies, food-added caregiver notifications, generic notifications/API keys, importer, tracing/deployment, public `@tfx/testing*`, and npm publication remain later slices. Type seams may support these capabilities, but Slice 1 adds no unused implementation.

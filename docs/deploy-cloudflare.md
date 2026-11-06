# Deploy Carneloot to Cloudflare

Use this procedure after local validation and approval for the named external actions. The implementation does not deploy, register a webhook, change secrets, or migrate a live database automatically. Read the [native runtime and scheduling semantics](cloudflare-runtime.md) before cutover.

## Validate without cloud access

Use the repository's pinned runtimes and install the lockfile:

```sh
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm check
mise exec -- pnpm exec tsc -p apps/carneloot-bot/tsconfig.cloudflare.json --pretty false
mise exec -- pnpm exec vitest run packages/tfx/test/RequestDispatch.test.ts
RUN_TESTCONTAINERS=true mise exec -- pnpm exec vitest run --config vitest.integration.config.ts apps/carneloot-bot/test/cloudflare/Worker.integration.test.ts
```

Alternatively, set `TEST_DATABASE_URL` to a **disposable** local PostgreSQL database for the integration command. The suite drops the `carnebot` schema and creates a temporary restricted runtime login. The test administrator needs permission to create roles and grant table access; the Worker role has neither DDL privileges nor migration-ledger access. Never point the suite at production. It uses no Cloudflare account or Telegram token.

Do not use `alchemy dev` as a cloud-free emulator. With this stack's `Cloudflare.state()`, even the first `plan`, `dev`, or dry run can bootstrap remote state resources.

## Prepare the target

1. Obtain approval for Cloudflare provisioning, deployment, application-secret writes, SQL migrations, and Telegram webhook registration separately from local implementation.
2. Verify that the Cloudflare account supports Hyperdrive, Durable Objects with alarms, and the configured Worker limits. Create or select an existing **PlanetScale Postgres** database and branch. Hyperdrive uses the Alchemy-managed role's direct TLS origin and its own pooling; do not configure PlanetScale's PgBouncer endpoint as the origin.
3. Back up PostgreSQL and verify restoration. Keep PlanetScale's default `postgres` role only for migrations and import. The migration command creates one `carnebot` schema containing the application tables, TFX tables, and both migration ledgers. Alchemy creates the rotating Worker login role with PlanetScale's `pg_read_all_data` and `pg_write_all_data` permissions; it cannot perform DDL, but PlanetScale's managed role API does not support narrowing access to individual tables or excluding migration ledgers.
4. Copy `apps/carneloot-bot/cloudflare.env.example` to its gitignored `.env.cloudflare`. Fill non-secret values, including `PLANETSCALE_DATABASE` and optionally `PLANETSCALE_BRANCH`. Supply `BOT_TOKEN` and `WEBHOOK_SECRET` through the approved secret manager or protected environment file. Keep the direct default-role `DATABASE_URL` for the migration operator only. Generate a separate webhook secret with at least 32 URL-safe characters.
5. From the app directory, configure a saved Alchemy credential profile with both Cloudflare and PlanetScale credentials using the [official Cloudflare setup](https://alchemy.run/cloudflare/setup) and [PlanetScale setup](https://alchemy.run/planetscale/setup):

```sh
pnpm exec alchemy profile create carneloot
pnpm exec alchemy profile edit --profile carneloot
pnpm exec alchemy profile edit --profile carneloot --add Planetscale
```

Alchemy stores deployment credentials in the profile, not Worker bindings. It creates the PlanetScale `carneloot-worker` role and stores its redacted credentials in deployment state; Hyperdrive receives that role's direct origin. Protect the local environment file and Alchemy profile directory; neither belongs in Git.

## Cut over after approval

1. Stop the existing Bun poller and its continuous job worker. Do not run them alongside the webhook runtime.
2. Export the approved operator environment, including the direct PlanetScale default-role `DATABASE_URL` on port 5432, `TFX_POSTGRES_SCHEMA=carnebot`, and `TFX_POSTGRES_TABLE_PREFIX=carneloot_`. Apply the checksummed migrations, including tfx migration 5 for the transactional wakeup outbox:

```sh
mise exec -- pnpm --filter carneloot-bot cloudflare:migrate
```

3. From `apps/carneloot-bot`, deploy with the reviewed profile, environment file, and fixed production stage:

```sh
pnpm exec alchemy deploy --stage production --profile carneloot --env-file .env.cloudflare
```

On first use, approve the state-store bootstrap only after reviewing its resources. `Cloudflare.state()` creates an account-level Worker, SQLite-backed Durable Object, and Secrets Store entries for its bearer token and encryption key. Resource state is encrypted and shared across deploy machines through this store. Keep the same stack name, stage, profile, and resource logical IDs for later deploys. Do not destroy the stack as a rollback procedure.

4. Verify the returned public URL's `/health` response. This route proves only that the entrypoint is loaded; it does not probe the database or Telegram.
5. Export that HTTPS origin as `WORKER_URL`. After checking the poller is stopped, register the webhook and Portuguese command menu:

```sh
mise exec -- pnpm --filter carneloot-bot cloudflare:webhook
```

The registration command enforces `max_connections=1` and `drop_pending_updates=false`. Registration is an explicit Telegram write, not part of Alchemy deployment.

6. Inspect Telegram's `getWebhookInfo` through your approved API tooling. Check the URL, pending count, and last delivery error without putting the bot token in shell history or logs.
7. Exercise registration, a persisted pet conversation, food recording, and a reminder with a test user. Check SQL food identities and message-time timestamps. Verify that the reminder executes from an alarm without waiting for cron. Inspect SQL job outcomes, wakeup intents, failed or quarantined jobs, and unknown deliveries. Do not manually resend unknown deliveries without reconciliation.

## Roll back transport after approval

1. Stop webhook admission using Telegram's `deleteWebhook` with `drop_pending_updates=false` through approved API tooling.
2. Drain accepted requests, then disable the Cloudflare cron, Worker route, and `JobWakeup` alarms with an approved deployment. Disabling cron alone does not stop native execution. Do not start a second scheduler before the first has stopped.
3. Restart the previous Bun polling runtime against the same database and tfx namespace. Preserve completed deduplication rows, conversation state, and notification-delivery outcomes.

Do not restore an old database snapshot merely to change transports. Do not remove the Alchemy state store, Hyperdrive, or Durable Object namespace while the Worker still handles traffic.

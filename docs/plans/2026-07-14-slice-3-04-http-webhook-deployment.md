# Slice 3 HTTP API, Webhook, and Deployment CLI Implementation Plan

**Goal:** Expose authenticated notification HTTP endpoint, secret-validated Telegram webhook receiver, and explicit webhook set/info/delete CLI without HTTP management routes.

**Architecture:** Keep notification delivery domain in prior plan. HttpApi maps its closed errors/results to contract statuses. Implement required reusable TFX `Webhook.make(options)` descriptor (source, control service, mountable HttpApi endpoint); app selects polling or that descriptor, never both. Webhook registration is explicit CLI action, never Layer acquisition/startup side effect; TFX receiver validates Telegram secret header before decode/claim/dispatch.

**Tech Stack:** Effect HttpApi, `@effect/platform-bun`, `@effect/platform-node`, TFX, Vitest.

---

## File map

- Create: `apps/carneloot-bot/src/http/Api.ts`, `ApiLive.ts` — Effect HttpApi declaration and handlers.
- Create/modify: `packages/tfx/src/Webhook.ts`, `packages/tfx/src/internal/update-source/WebhookSource.ts`, package exports, and focused TFX tests — reusable `Webhook.make` descriptor, receiver, control operations, bounded intake, claims, and shutdown.
- Create: `apps/carneloot-bot/src/webhook/Cli.ts` — `webhook:set`, `webhook:info`, `webhook:delete` programs.
- Modify: `Config.ts`, `Production.ts`, `bin.ts`, `Program.ts`, `main.ts` — validated mode/server config and scoped composition.
- Modify: `package.json`, lockfile — add only public Effect HTTP dependencies not already declared.
- Create: `test/http/Api.test.ts`, `test/http/Api.integration.test.ts`, `test/webhook/WebhookCli.test.ts`; modify/add TFX webhook unit/integration tests under `packages/tfx/test/`.
- Modify: `test/Config.test.ts`, `test/AppLive.integration.test.ts`, `type-test/Production.tst.ts`, `test/NodeSmoke.test.ts`.

### Task 1: Add mode and HTTP/webhook configuration

**Files:**
- Modify: `apps/carneloot-bot/src/Config.ts`
- Test: `apps/carneloot-bot/test/Config.test.ts`

- [ ] **Step 1: Write failing config tests**

Test polling config needs no webhook URL/secret; webhook config requires absolute HTTPS `WEBHOOK_PUBLIC_URL`, nonempty redacted `WEBHOOK_SECRET`, valid port `1..65535`; invalid `RUN_MODE`, URL, secret, or port produces `AppConfigValidationError`. Assert config inspection does not expose secret text.

- [ ] **Step 2: Run test**

Run: `pnpm exec vitest run apps/carneloot-bot/test/Config.test.ts`

Expected: FAIL because current config has polling-only fields.

- [ ] **Step 3: Add discriminated runtime mode config**

Add `runMode: 'polling' | 'webhook'`, `httpPort`, `webhookPublicUrl`, and redacted `webhookSecret` to `AppConfigService`. Decode mode with literal union. Validate webhook-only requirements in `load`; retain all existing duration/identifier validation. Do not include bot token in webhook URL.

- [ ] **Step 4: Run test**

Run: `pnpm exec vitest run apps/carneloot-bot/test/Config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/carneloot-bot/src/Config.ts apps/carneloot-bot/test/Config.test.ts
git commit -m "feat(carneloot): configure webhook mode"
```

### Task 2: Implement notification HttpApi contract

**Files:**
- Create: `apps/carneloot-bot/src/http/Api.ts`, `apps/carneloot-bot/src/http/ApiLive.ts`
- Test: `apps/carneloot-bot/test/http/Api.test.ts`

- [ ] **Step 1: Write failing API contract tests**

Use in-memory application service fake and HTTP test client. Assert `POST /api/notify` accepts legacy JSON:

```json
{"apiKey":"key","keyword":"feeding","variables":{"pet":"Milo","amount":20}}
```

Assert response body has event ID, status, counts, sanitized failures. Assert statuses: `200 sent`, `207 partial`, `502 failed`, `202 indeterminate`, `404` invalid key, `404` missing template, `422` missing variables, `503` initial pre-send DB failure, `500` defect, `400` decode failure. Assert route list excludes set/info/delete webhook routes.

- [ ] **Step 2: Run test**

Run: `pnpm exec vitest run apps/carneloot-bot/test/http/Api.test.ts`

Expected: FAIL because HttpApi modules do not exist.

- [ ] **Step 3: Declare and implement HttpApi**

Use Effect HttpApi schemas for request and response. Handler calls only `SendExternalNotification.execute`. Map tagged errors explicitly; no catch-all turns post-send uncertainty into `503`.

```ts
export const Notify = HttpApiEndpoint.post('notify', '/api/notify')
  .setPayload(NotifyRequest)
  .addSuccess(NotifySent, { status: 200 })
  .addSuccess(NotifyPartial, { status: 207 })
  .addSuccess(NotifyFailed, { status: 502 })
  .addSuccess(NotifyIndeterminate, { status: 202 });
```

Add declared error schemas/statuses for `404`, `422`, `503`; let unexpected defects use server `500`. Do not add template/subscription management and do not add webhook deployment endpoints.

- [ ] **Step 4: Run test**

Run: `pnpm exec vitest run apps/carneloot-bot/test/http/Api.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/carneloot-bot/src/http apps/carneloot-bot/test/http/Api.test.ts apps/carneloot-bot/package.json pnpm-lock.yaml
git commit -m "feat(carneloot): add notification http api"
```

### Task 3: Mount scoped Bun server and preserve Node type closure

**Files:**
- Modify: `apps/carneloot-bot/src/Production.ts`, `src/Program.ts`, `src/bin.ts`, `src/main.ts`
- Test: `apps/carneloot-bot/test/http/Api.integration.test.ts`, `test/AppLive.integration.test.ts`, `type-test/Production.tst.ts`, `test/NodeSmoke.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Assert production HTTP server acquires within same `Effect.scoped` program as bot/database/worker and closes listener on interruption. Assert server layer is Bun runtime edge, not imported by Node-compatible package barrel. Assert no implicit Telegram `setWebhook` happens when acquiring production graph.

- [ ] **Step 2: Run tests**

Run: `pnpm exec vitest run apps/carneloot-bot/test/http/Api.integration.test.ts apps/carneloot-bot/test/AppLive.integration.test.ts apps/carneloot-bot/test/NodeSmoke.test.ts`

Expected: FAIL because no HTTP server is composed.

- [ ] **Step 3: Compose server explicitly**

Use Bun HTTP server layer at Bun executable edge, mount `ApiLive`, and merge it with app resources before `Program.run`. Preserve generic `AppLive.layer(delivery)` portability. Keep server `Layer.scoped`; `Program.fromLayer` remains sole scope owner. Export platform-neutral contracts from `main.ts`; do not export Bun-only module through Node-consumed barrel.

- [ ] **Step 4: Run tests and checks**

Run: `pnpm exec vitest run apps/carneloot-bot/test/http/Api.integration.test.ts apps/carneloot-bot/test/AppLive.integration.test.ts apps/carneloot-bot/test/NodeSmoke.test.ts && pnpm --filter carneloot-bot check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/carneloot-bot/src/{Production.ts,Program.ts,bin.ts,main.ts} apps/carneloot-bot/test apps/carneloot-bot/type-test
git commit -m "feat(carneloot): run scoped http server"
```

### Task 4: Implement reusable TFX webhook descriptor and exclusive app mode

**Files:**
- Create/modify: `packages/tfx/src/Webhook.ts`, `packages/tfx/src/internal/update-source/WebhookSource.ts`, `packages/tfx/package.json`, `packages/tfx/test/Webhook.test.ts`
- Modify: `apps/carneloot-bot/src/Production.ts`, `apps/carneloot-bot/test/AppLive.integration.test.ts`

- [ ] **Step 1: Write failing TFX webhook contract tests**

Assert missing/wrong `X-Telegram-Bot-Api-Secret-Token` is `401` before decode/dispatch; malformed JSON/schema-invalid update is `400`; saturation, request deadline, processing timeout, and retryable dispatch are `503`; handled/permanent-invalid are `2xx`; fatal is `500`, marks runtime unhealthy, and remains unacknowledged. Assert bounded intake, completion acknowledgement, duplicate claim waiting, heartbeat/fencing, expired claim takeover, detached claimed processing after client disconnect, shutdown grace/release, and no handler duplicate. Assert descriptor exports source, webhook-control service, and mountable `POST /api/webhook` HttpApi endpoint.

- [ ] **Step 2: Run tests**

Run: `pnpm exec vitest run packages/tfx/test/Webhook.test.ts apps/carneloot-bot/test/AppLive.integration.test.ts`

Expected: FAIL because TFX has no public webhook descriptor.

- [ ] **Step 3: Implement `Webhook.make(options)` in TFX**

Implement descriptor with `UpdateDelivery` internals plus a mountable Effect HttpApi endpoint and control service. Validate secret header with timing-safe comparison before decoding. Durable dedup claim owns processing; HTTP waits only bounded request deadline, then returns `503` without cancelling claim; claim execution has independent processing timeout/heartbeat and completion fence. Map outcomes exactly: handled/permanent-invalid `2xx`, retryable/timeout/saturation `503`, fatal `500` and unhealthy state. Release or complete claims during scoped graceful shutdown.

- [ ] **Step 4: Select descriptor in Carneloot**

In `Production`, construct `Webhook.make` from config and mount its endpoint beside notification HttpApi only when `runMode === 'webhook'`; polling uses `Polling.make` only. Neither app acquisition nor startup calls Telegram webhook-control methods.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm exec vitest run packages/tfx/test/Webhook.test.ts apps/carneloot-bot/test/http/Api.test.ts apps/carneloot-bot/test/AppLive.integration.test.ts`

Expected: PASS.

```bash
git add packages/tfx apps/carneloot-bot/src/Production.ts apps/carneloot-bot/test/AppLive.integration.test.ts
git commit -m "feat(tfx): add authenticated webhook delivery"
```

### Task 5: Add explicit set/info/delete webhook CLI

**Files:**
- Create: `apps/carneloot-bot/src/webhook/Cli.ts`
- Modify: `apps/carneloot-bot/src/bin.ts`
- Test: `apps/carneloot-bot/test/webhook/WebhookCli.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Assert `webhook:set` deploys/starts and health-checks application before it sends `Telegram.setWebhook` with `${WEBHOOK_PUBLIC_URL}/api/webhook`, secret token, inferred allowed updates, Portuguese menu commands, and `language_code: 'pt'`. Assert `webhook:info` calls `getWebhookInfo`. Assert `webhook:delete` requires explicit `--drop-pending-updates`; plain delete fails typed validation. Assert all Telegram/config failures cause nonzero typed CLI exit. Assert no HTTP route exposes these operations.

- [ ] **Step 2: Run test**

Run: `pnpm exec vitest run apps/carneloot-bot/test/webhook/WebhookCli.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement subcommands**

Parse `webhook:set|webhook:info|webhook:delete [--drop-pending-updates]` before normal `Program.run`. `webhook:set` explicitly starts deployment, waits for health check, then calls TFX webhook-control `set`, then Telegram menu publication; it must not run during Layer acquisition. `webhook:delete` calls control `delete` only after flag validation. Use named `Effect.fn` boundaries and structured sanitized output; never print bot token/secret URL query.

- [ ] **Step 4: Run test and checks**

Run: `pnpm exec vitest run apps/carneloot-bot/test/webhook/WebhookCli.test.ts apps/carneloot-bot/test/http/Api.test.ts && pnpm --filter carneloot-bot check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/carneloot-bot/src/{webhook/Cli.ts,bin.ts} apps/carneloot-bot/test/webhook/WebhookCli.test.ts
git commit -m "feat(carneloot): add webhook deployment cli"
```

## Final verification

```bash
pnpm exec vitest run apps/carneloot-bot/test/http apps/carneloot-bot/test/webhook
pnpm --filter carneloot-bot check
pnpm check
```

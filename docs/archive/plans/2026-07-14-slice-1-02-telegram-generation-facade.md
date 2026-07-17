# Slice 1 Telegram Generation and Facade Implementation Plan

**Goal:** Generate checked-in Telegram schemas/raw client from pinned Photon OpenAPI and expose sanitized yieldable `Telegram.Telegram` with structured `TelegramError`.

**Architecture:** Pinned upstream spec passes checked-in JSON Patch normalization into Effect OpenAPI generator. Generated source remains internal; handwritten facade injects token, handles JSON/multipart, decodes Telegram envelopes, and maps all failures into schema-backed reasons.

**Tech Stack:** Effect 4.0.0-beta.98, `@effect/openapi-generator` 4.0.0-beta.98, platform-neutral Effect HttpClient, Photon Telegram OpenAPI commit `80e0bd5…`.

---

## File map

- Modify: `.gitmodules`, `packages/tfx/package.json`, `packages/tfx/tsconfig.json`
- Add submodule: `.repos/telegram-api`
- Create: `packages/tfx/openapi/patches/{001-server.json,002-default-responses.json,003-input-files.json}`
- Create: `packages/tfx/scripts/{generate-telegram.ts,check-generated.ts}`
- Create: `packages/tfx/src/internal/telegram/generated/TelegramApi.ts`
- Create: `packages/tfx/src/internal/telegram/{RawClient.ts,Envelope.ts,Sanitize.ts,Multipart.ts}`
- Create: `packages/tfx/src/{Telegram.ts,TelegramError.ts,TelegramSchemas.ts}`
- Create: `packages/tfx/test/{Telegram.test.ts,TelegramError.test.ts,TelegramGeneration.test.ts}`

### Task 1: Pin source and prove reproducible generation

- [ ] **Step 1: Add and pin submodule**

```bash
git submodule add https://github.com/photon-hq/telegram-api .repos/telegram-api
git -C .repos/telegram-api checkout 80e0bd5d3d3155985c1a4281aec729b73e294055
test -f .repos/telegram-api/specs/telegram-bot-api.openapi.json
```

Expected: detached HEAD at approved SHA and OpenAPI 3.0.3 source exists.

- [ ] **Step 2: Record provenance and licensing gate**

Add README section with source SHA/path, Telegram review requirement, and fact repository lacks root license while generated package says MIT. Require maintainer approval before npm distribution of derived generated output; this blocks publication, not local Slice 1 implementation/demo.

- [ ] **Step 3: Write failing generator snapshot test**

Test invokes generation into temp directory, compares bytes to committed `generated/TelegramApi.ts`, and reports first changed path. Before output exists:

Run: `pnpm --filter tfx test -- TelegramGeneration.test.ts`
Expected: FAIL with committed output missing.

- [ ] **Step 4: Add deterministic patch pipeline**

Apply ordered JSON Patch files. Normalize server/token handling for handwritten base URL, preserve default error response, and split multipart binary upload from string file-ID/URL alternatives. Assert required operations `getMe`, `deleteWebhook`, `setMyCommands`, `getUpdates`, `sendMessage`, and `sendDocument` survive patches. Fail generation on unreviewed warnings except recorded `default-response-remapped`.

- [ ] **Step 5: Generate and check output**

Run: `pnpm --filter tfx telegram:generate && pnpm --filter tfx telegram:check`
Expected: generated file committed and second generation produces zero diff.

- [ ] **Step 6: Commit source pipeline**

```bash
git add .gitmodules .repos/telegram-api packages/tfx/openapi packages/tfx/scripts packages/tfx/src/internal/telegram/generated packages/tfx/package.json packages/tfx/test/TelegramGeneration.test.ts README.md
git commit -m "build(tfx): generate Telegram API client"
```

### Task 2: Implement `TelegramError`

- [ ] **Step 1: Write table-driven failing tests**

Cover network, 429/retry-after, 401, 403, 400, 409, `migrate_to_chat_id`, 5xx, invalid envelope, and unknown failures. Assert wrapper fields and redaction.

```ts
expect(error).toMatchObject({
  _tag: "TelegramError",
  module: "Telegram",
  method: "sendMessage",
  reason: { _tag: "RateLimitError", errorCode: 429 },
  isRetryable: true,
  retryAfter: Duration.seconds(12)
})
expect(String(error.cause)).not.toContain("123456:secret")
```

Run: `pnpm --filter tfx test -- TelegramError.test.ts`
Expected: FAIL because module does not exist.

- [ ] **Step 2: Define schema-backed reason union**

Create `Schema.ErrorClass` reasons named in design and wrapper:

```ts
export class TelegramError extends Schema.ErrorClass<TelegramError>("TelegramError")({
  module: Schema.String,
  method: Schema.String,
  reason: TelegramErrorReason
}) {
  get isRetryable(): boolean { return this.reason.isRetryable }
  get retryAfter(): Duration.Duration | undefined { return this.reason.retryAfter }
}
```

Each reason owns safe message/cause metadata; no token-bearing URL, authorization header, raw body, or private message text enters encoded error.

- [ ] **Step 3: Implement mapping and run tests**

Run: `pnpm --filter tfx test -- TelegramError.test.ts`
Expected: all reason/mapping/redaction cases PASS.

- [ ] **Step 4: Commit errors**

```bash
git add packages/tfx/src/TelegramError.ts packages/tfx/src/internal/telegram/Sanitize.ts packages/tfx/test/TelegramError.test.ts
git commit -m "feat(tfx): model Telegram failures"
```

### Task 3: Implement yieldable Telegram facade

- [ ] **Step 1: Write fake-HttpClient tests**

Assert token URL injection, envelope stripping, schema decoding, JSON request, multipart upload, file ID, URL input, migration/rate-limit parameters, malformed JSON, and generated result types.

```ts
const telegram = yield* Telegram.Telegram
const result = yield* telegram.sendMessage({ chat_id: 42, text: "oi" })
expect(result.message_id).toBe(7)
expect(recorded.url).toBe("https://api.telegram.org/bot123456:secret/sendMessage")
expect(recorded.diagnostics).not.toContain("123456:secret")
```

- [ ] **Step 2: Define service contract**

Expose methods used by Slice 1 plus generated complete-method shape without static accessors. Constructor accepts `Redacted<string>` token and requires platform-neutral `HttpClient.HttpClient`.

- [ ] **Step 3: Implement raw transport and envelope decoder**

`RawClient` chooses JSON unless upload values require multipart, applies generated request/response schemas, and returns raw response. `Envelope` returns `result` only when `ok: true`; all other forms map through `TelegramError`.

- [ ] **Step 4: Export only public facade and schema types**

Add package exports `tfx/Telegram`, `tfx/TelegramError`, `tfx/TelegramSchemas`. Add negative import test proving `tfx/internal/telegram/RawClient` is blocked.

- [ ] **Step 5: Validate both runtimes**

Run: `pnpm --filter tfx check && pnpm --filter tfx test -- Telegram.test.ts TelegramError.test.ts TelegramGeneration.test.ts`
Expected: PASS.

Run: `bun x vitest run packages/tfx/test/Telegram.test.ts packages/tfx/test/TelegramError.test.ts`
Expected: PASS without Node-only import.

- [ ] **Step 6: Commit facade**

```bash
git add packages/tfx/src packages/tfx/test packages/tfx/package.json
git commit -m "feat(tfx): add yieldable Telegram facade"
```

## Acceptance criteria

- Pinned generation produces clean diff.
- Generated raw client is not publicly importable.
- Public methods return decoded `result`, never Telegram envelope.
- JSON, file ID/URL, and uploaded-file paths are tested.
- Error reasons preserve typed retry/migration data while sanitizing secrets.
- Core uses platform-neutral HttpClient and passes Node/Bun tests.
- Root-license concern is documented and blocks publication pending maintainer resolution.

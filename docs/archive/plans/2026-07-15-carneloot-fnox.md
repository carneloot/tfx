# Carneloot fnox Integration Implementation Plan

**Goal:** Manage Carneloot's Telegram token with fnox and provide its local PostgreSQL URL from an app-local Docker Compose setup.

**Architecture:** Commit the age-encrypted `BOT_TOKEN` and a non-secret local `DATABASE_URL` default in an app-local `fnox.toml`; keep the age private key outside the repository. `fnox exec` injects both into the Bun subprocess environment, so `apps/carneloot-bot/src/Config.ts` requires no changes. A production fnox profile removes the localhost fallback and requires externally supplied `DATABASE_URL`; other non-secret settings continue through the existing environment loader.

**Tech Stack:** fnox 1.30.0, age 1.3.1, mise, Bun, pnpm, Effect.

---

## Assumptions

- Encrypted secret values may be committed; plaintext Telegram tokens and the age private key may not.
- Local PostgreSQL credentials are development-only and match `apps/carneloot-bot/compose.yaml`; production overrides `DATABASE_URL`.
- Reuse the existing, valid age key at `~/.config/fnox/age.txt`; it already has mode `0600`.
- This plan covers local/runtime integration only. No deployment workflow exists yet, so production key delivery remains deployment-specific.
- CI does not need Telegram or production database secrets and will not decrypt `fnox.toml`.

### Task 1: Add pinned tooling and encrypted secret manifest

**Files:**
- Modify: `.mise.toml`
- Create: `apps/carneloot-bot/fnox.toml`
- Create: `apps/carneloot-bot/compose.yaml`

- [ ] **Step 1: Pin fnox and age in `.mise.toml`**

```toml
[tools]
node = "24.18.0"
bun = "1.3.14"
pnpm = "10.17.1"
age = "1.3.1"
fnox = "1.30.0"
```

- [ ] **Step 2: Install tools and verify the existing private key**

```sh
mise install
test -f ~/.config/fnox/age.txt
test "$(stat -c %a ~/.config/fnox/age.txt)" = "600"
age-keygen -y ~/.config/fnox/age.txt >/dev/null
```

Expected: existing key parses successfully, remains outside Git, and keeps mode `0600`.

- [ ] **Step 3: Create app-local fnox configuration from the generated public recipient**

```sh
AGE_RECIPIENT="$(age-keygen -y ~/.config/fnox/age.txt)"
cat > apps/carneloot-bot/fnox.toml <<EOF
env = "exec"

[providers.age]
type = "age"
recipients = ["${AGE_RECIPIENT}"]
EOF
```

`env = "exec"` prevents interactive-shell export; secrets remain available to commands launched through `fnox exec`.

- [ ] **Step 4: Add local PostgreSQL and prompt securely for the Telegram token**

Create `apps/carneloot-bot/compose.yaml` with PostgreSQL 17 exposed only on `127.0.0.1:5432`, database/user/password `carneloot`/`postgres`/`postgres`, a named data volume, and a `pg_isready` healthcheck. Add this fnox default:

```toml
DATABASE_URL = { default = "postgres://postgres:postgres@localhost:5432/carneloot" }

[profiles.production.secrets]
DATABASE_URL = { if_missing = "error" }
```

Then store the token:

```sh
cd apps/carneloot-bot
export FNOX_AGE_KEY_FILE="$HOME/.config/fnox/age.txt"
mise exec -- fnox set BOT_TOKEN --provider age
cd ../..
```

Expected: hidden prompt accepts the token; `fnox.toml` contains ciphertext for `BOT_TOKEN` and a plaintext localhost-only default for `DATABASE_URL`. No plaintext token appears in shell history or file.

- [ ] **Step 5: Verify injection without printing values**

```sh
cd apps/carneloot-bot
FNOX_AGE_KEY_FILE="$HOME/.config/fnox/age.txt" \
  fnox exec -- sh -eu -c 'test -n "$BOT_TOKEN"; test "$DATABASE_URL" = "postgres://postgres:postgres@localhost:5432/carneloot"'
cd ../..
```

Expected: exit code `0` and no secret output.

- [ ] **Step 6: Commit tooling and encrypted manifest**

```sh
git add .mise.toml apps/carneloot-bot/fnox.toml apps/carneloot-bot/compose.yaml
git commit -m "build(carneloot): configure fnox secrets"
```

### Task 2: Route bot startup through fnox and document operation

**Files:**
- Modify: `apps/carneloot-bot/package.json`
- Modify: `apps/carneloot-bot/.env.example`
- Modify: `apps/carneloot-bot/README.md`

- [ ] **Step 1: Wrap production/demo startup in fnox**

Change the package script to:

```json
"demo": "fnox exec -- bun src/bin.ts"
```

Keep `"start": "pnpm demo"`; both commands then use the same fnox-backed production graph. Do not modify `demo:test`, because it uses fake Telegram and test database configuration.

- [ ] **Step 2: Remove secret-value placeholders from `.env.example`**

Replace its first three lines with:

```dotenv
# BOT_TOKEN and DATABASE_URL are managed by fnox; see README.md.
```

Keep the blank line and all remaining non-secret keys unchanged. This prevents setup instructions from encouraging duplicate plaintext secret storage.

- [ ] **Step 3: Update README setup and run instructions**

Document these exact operational rules:

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
export FNOX_AGE_KEY_FILE="$HOME/.config/fnox/age.txt"
cp apps/carneloot-bot/.env.example apps/carneloot-bot/.env
mise exec -- pnpm --filter carneloot-bot demo
```

State that:

- `.env` contains only non-secret configuration and still needs a shell/environment loader.
- `BOT_TOKEN` comes from the encrypted `apps/carneloot-bot/fnox.toml` entry.
- Local `DATABASE_URL` defaults to the PostgreSQL service in `apps/carneloot-bot/compose.yaml`.
- `~/.config/fnox/age.txt` must be backed up securely and never committed.
- Production must provide `FNOX_AGE_KEY_FILE`, `FNOX_PROFILE=production`, and `DATABASE_URL`; its fnox profile removes the localhost fallback and fails when the URL is absent. The private key must not be copied into a container image.
- The token is updated with `cd apps/carneloot-bot && mise exec -- fnox set BOT_TOKEN --provider age`.

- [ ] **Step 4: Run focused validation**

```sh
mise exec -- pnpm --filter carneloot-bot check
mise exec -- pnpm --filter carneloot-bot test
mise exec -- pnpm format
mise exec -- pnpm lint
git diff --check
```

Expected: all commands pass. TypeScript application code and Effect config tests remain unchanged because fnox preserves the environment-variable boundary.

- [ ] **Step 5: Re-run secret injection smoke check**

```sh
cd apps/carneloot-bot
FNOX_AGE_KEY_FILE="$HOME/.config/fnox/age.txt" \
  fnox exec -- sh -eu -c 'test -n "$BOT_TOKEN"; test "$DATABASE_URL" = "postgres://postgres:postgres@localhost:5432/carneloot"'
cd ../..
```

Expected: exit code `0`, no secret output, and `git diff` contains only ciphertext/configuration/documentation.

- [ ] **Step 6: Commit runtime and documentation changes**

```sh
git add apps/carneloot-bot/package.json \
  apps/carneloot-bot/.env.example \
  apps/carneloot-bot/README.md
git commit -m "docs(carneloot): use fnox for runtime secrets"
```

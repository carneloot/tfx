# Slice 1 Workspace and Toolchain Implementation Plan

**Goal:** Bootstrap reproducible monorepo, package graph, build graph, checks, release metadata, and Node/Bun CI baseline.

**Architecture:** Root pnpm workspace owns dependency resolution and TypeScript solution references. `tfx` stays portable, `@tfx/postgres` depends on tfx plus Effect SQL, and Bun Carneloot app consumes both; private test code is not exported.

**Tech Stack:** pnpm 10.17.1, Node 24.18.0, Bun 1.3.14, TypeScript 7, Effect 4.0.0-beta.98, Vitest 4.1.10, Changesets 2.31.0, GitHub Actions.

---

## File map

- Create: `.mise.toml`, `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`
- Create: `tsconfig.base.json`, `tsconfig.packages.json`, `tsconfig.json`, `vitest.config.ts`, `vitest.integration.config.ts`
- Create: `.changeset/config.json`, `.changeset/README.md`, `.github/workflows/ci.yml`
- Create: `packages/tfx/{package.json,tsconfig.json,src/index.ts,test/smoke.test.ts}`
- Create: `packages/postgres/{package.json,tsconfig.json,src/index.ts,test/smoke.test.ts}`
- Create: `apps/carneloot-bot/{package.json,tsconfig.json,src/main.ts,test/smoke.test.ts}`
- Create: `README.md`, `.gitignore`

### Task 1: Pin tools and workspace

- [ ] **Step 1: Write root tool files**

```toml
# .mise.toml
[tools]
node = "24.18.0"
bun = "1.3.14"
pnpm = "10.17.1"
```

```yaml
# pnpm-workspace.yaml
packages:
  - packages/*
  - apps/*
```

- [ ] **Step 2: Write root manifest with exact platform/library baseline**

Use `packageManager: pnpm@10.17.1`; pin `effect`, `@effect/platform-node`, `@effect/platform-bun`, `@effect/sql-pg`, and `@effect/openapi-generator` to `4.0.0-beta.98`. Pin Vitest `4.1.10` and Changesets `2.31.0`; allow only `@types/node` 24.x. Scripts:

```json
{
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.17.1",
  "engines": { "node": ">=24 <25", "pnpm": "10.17.1" },
  "scripts": {
    "build": "tsc -b tsconfig.packages.json",
    "check": "tsc -b tsconfig.json --pretty false",
    "test": "vitest run",
    "test:unit": "vitest run --exclude '**/*.integration.test.ts' --exclude '**/*.e2e.test.ts'",
    "test:integration": "vitest run --config vitest.integration.config.ts --reporter verbose",
    "clean": "tsc -b tsconfig.json --clean",
    "changeset": "changeset",
    "release:version": "changeset version",
    "release:publish": "changeset publish"
  }
}
```

- [ ] **Step 3: Install and verify lockfile**

Run: `mise exec -- pnpm install`
Expected: `pnpm-lock.yaml` created; no Bun lockfile.

Run: `mise exec -- pnpm --version && mise exec -- node --version && mise exec -- bun --version`
Expected: `10.17.1`, `v24.18.0`, `1.3.14`.

- [ ] **Step 4: Commit foundation**

```bash
git add .mise.toml package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "build: initialize pnpm workspace"
```

### Task 2: Add TypeScript package graph

- [ ] **Step 1: Write failing solution references**

`tsconfig.packages.json` references `packages/tfx`, `packages/postgres`, and `apps/carneloot-bot`; root `tsconfig.json` references package graph and includes test/type-test config. Running before package configs must fail with missing referenced project.

Run: `mise exec -- pnpm exec tsc -b tsconfig.packages.json`
Expected: FAIL naming missing package `tsconfig.json` files.

- [ ] **Step 2: Add strict shared compiler policy**

```jsonc
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "skipLibCheck": false
  }
}
```

Each package config sets `rootDir: src`, `outDir: dist`; Postgres references tfx; Carneloot references both. Tests are checked by root config and excluded from emitted builds. `vitest.integration.config.ts` sets `test.include` to `packages/**/*.integration.test.ts` and `apps/**/*.integration.test.ts`; its config test asserts named PostgreSQL suites are collected so an empty integration run fails.

- [ ] **Step 3: Define package boundaries and exports**

`tfx/package.json` exports `.` now and allows later explicit subpaths. `@tfx/postgres` uses `workspace:^` for tfx and peers on Effect/SQL. Carneloot is `private: true` and directly depends on `@effect/platform-bun`; no tfx platform wrapper.

- [ ] **Step 4: Add smoke exports and tests**

```ts
// packages/tfx/src/index.ts
export const packageName = "tfx" as const
```

```ts
// packages/tfx/test/smoke.test.ts
import { describe, expect, it } from "vitest"
import { packageName } from "../src/index.js"
describe("tfx package", () => it("loads", () => expect(packageName).toBe("tfx")))
```

Equivalent smoke assertions load `@tfx/postgres` and Carneloot package entry.

- [ ] **Step 5: Run build and tests**

Run: `mise exec -- pnpm build && mise exec -- pnpm check && mise exec -- pnpm test:unit`
Expected: all commands PASS.

- [ ] **Step 6: Commit package graph**

```bash
git add tsconfig*.json vitest.config.ts packages apps
git commit -m "build: add TypeScript workspace packages"
```

### Task 3: Add Changesets, docs, and CI

- [ ] **Step 1: Configure Changesets**

Set `access: public`, `baseBranch: main`, and `privatePackages.version: false`; ignore private `carneloot-bot`. Document that Slice 1 only performs `pnpm pack` dry runs.

- [ ] **Step 2: Add dual-runtime workflow**

CI installs mise, runs `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm check`, and `pnpm test:unit` under Node 24.18.0. Separate Bun job runs package check/tests through `bun x vitest run` and Carneloot smoke via Bun 1.3.14. PostgreSQL service job is added in Plan 8.

- [ ] **Step 3: Add architecture README**

Document package boundaries, tool commands, no Turbo, Bun-as-runtime-not-package-manager, direct Effect platform Layers, and private-test policy.

- [ ] **Step 4: Validate clean checkout commands**

Run: `mise install && mise exec -- pnpm install --frozen-lockfile && mise exec -- pnpm build && mise exec -- pnpm check && mise exec -- pnpm test:unit`
Expected: PASS from clean workspace.

Run: `mise exec -- bun x vitest run packages/tfx/test/smoke.test.ts apps/carneloot-bot/test/smoke.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit CI/release baseline**

```bash
git add .changeset .github README.md .gitignore
git commit -m "ci: validate workspace on Node and Bun"
```

## Acceptance criteria

- Exact mise and package-manager pins match approved design.
- `pnpm-lock.yaml` is only package-manager lockfile.
- TypeScript references build in dependency order.
- Package metadata declares Node 24 and Bun 1.3 validation policy.
- Core package has no Node/Bun/PostgreSQL dependency.
- Changesets excludes private app and no publication occurs.
- Node and Bun smoke checks pass.

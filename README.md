# effectloot-bot

Effect-based TypeScript workspace for portable Telegram bot infrastructure and Carneloot.

## Workspace boundaries

- `packages/tfx`: portable core. It may depend on Effect, but not Node, Bun, or PostgreSQL implementations.
- `packages/postgres`: `@tfx/postgres` adapters. It depends on `tfx` and peers on Effect SQL.
- `apps/carneloot-bot`: private Bun application consuming both public packages.

Runtime integrations use Effect platform Layers directly. `tfx` does not wrap Node or Bun platform packages. Tests remain private workspace files and are not package exports.

## Toolchain

mise pins Node 24.18.0, Bun 1.3.14, and pnpm 10.17.1. pnpm is the sole package manager; Bun is an application runtime and validation runtime. TypeScript project references provide the build graph, so no Turbo layer is needed.

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm build
mise exec -- pnpm check
mise exec -- pnpm test:unit
mise exec -- pnpm test:integration
```

Slice 1 release validation uses `pnpm pack` dry runs only. Changesets version and publish public packages in later release work; the private application is excluded.

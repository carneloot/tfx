#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PACKDIR=$(mktemp -d "${TMPDIR:-/tmp}/effectloot-packs-XXXXXX")
CONSUMER=$(mktemp -d "${TMPDIR:-/tmp}/effectloot-consumer-XXXXXX")
trap 'rm -rf "$PACKDIR" "$CONSUMER"' EXIT
PNPM_CONFIG_IGNORE_SCRIPTS=true pnpm --filter tfx pack --pack-destination "$PACKDIR"
PNPM_CONFIG_IGNORE_SCRIPTS=true pnpm --filter @tfx/postgres pack --pack-destination "$PACKDIR"
for archive in "$PACKDIR"/*.tgz; do
  node "$ROOT/scripts/check-packed-package.ts" "$archive"
done
TFX_ARCHIVE=$(find "$PACKDIR" -maxdepth 1 -name 'tfx-[0-9]*.tgz' -print -quit)
POSTGRES_ARCHIVE=$(find "$PACKDIR" -maxdepth 1 -name 'tfx-postgres-*.tgz' -print -quit)
cat > "$CONSUMER/package.json" <<JSON
{"private":true,"type":"module","dependencies":{"tfx":"file:$TFX_ARCHIVE","@tfx/postgres":"file:$POSTGRES_ARCHIVE","effect":"4.0.0-beta.98","@effect/sql-pg":"4.0.0-beta.98","pg":"8.16.3"}}
JSON
cat > "$CONSUMER/pnpm-workspace.yaml" <<YAML
packages:
  - .
overrides:
  tfx: file:$TFX_ARCHIVE
YAML
cp "$ROOT/scripts/check-packed-consumer.ts" "$CONSUMER/"
(
  cd "$CONSUMER"
  pnpm install --ignore-scripts
  node check-packed-consumer.ts
  bun check-packed-consumer.ts
)

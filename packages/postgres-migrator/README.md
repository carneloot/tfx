# @tfx/postgres-migrator

Strict PostgreSQL migration runner shared by TFX and Carneloot.

## Guarantees

- SHA-256 identity for every migration.
- Applied ledger must be an exact contiguous prefix of source migrations.
- Unknown future rows, gaps, reordered rows, renamed migrations, and checksum drift fail startup.
- Transaction-scoped PostgreSQL advisory lock is acquired before schema or ledger creation.
- Schema bootstrap, migrations, and ledger inserts commit or roll back together.
- Structured startup, application, completion, and failure logs.

## Why not effect/unstable/sql/Migrator?

The Effect 4.0.0-beta.98 migrator records only migration ID, name, and timestamp; skips everything at or below the highest applied ID; creates its PostgreSQL ledger before entering the migration transaction; and exposes an unstable API. Those semantics do not provide checksum validation, exact-prefix validation, or serialized first-time bootstrap required by this workspace.

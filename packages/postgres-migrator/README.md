# @tfx/postgres-migrator

Strict PostgreSQL migration runner shared by TFX and Carneloot.

## Guarantees

- SHA-256 identity for every migration.
- Applied ledger must be an exact contiguous prefix of source migrations.
- Unknown future rows, gaps, reordered rows, renamed migrations, and checksum drift fail startup.
- Transaction-scoped PostgreSQL advisory lock is acquired before schema or ledger creation.
- Schema bootstrap, migrations, and ledger inserts commit or roll back together.
- Structured startup, application, completion, and failure logs.

## SQL scripts

Effect SQL's native PostgreSQL driver uses the extended protocol, which accepts
one statement per query. Use `PostgresMigrator.executeSql(sql, source)` in a
migration's `up` function for trusted multi-statement SQL. Statements run
sequentially in the caller's transaction; quoted identifiers, strings, comments,
and dollar-quoted procedural bodies stay intact. The helper does not create or
commit a transaction of its own.

## Why not effect/sql/Migrator?

The Effect 4.0.6 migrator records only migration ID, name, and timestamp; skips
everything at or below the highest applied ID; and creates its PostgreSQL ledger
before entering the migration transaction. Those semantics do not provide
checksum validation, exact-prefix validation, or serialized first-time bootstrap
required by this workspace. The module remains marked unstable despite the stable
Effect release.

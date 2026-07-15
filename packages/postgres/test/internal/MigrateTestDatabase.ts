import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
export const migrate = Effect.flatMap(PgClient.PgClient, (sql) =>
	sql.unsafe(`
	CREATE TABLE IF NOT EXISTS tfx_test_marker (
		id text PRIMARY KEY,
		created_at timestamptz NOT NULL DEFAULT now()
	)
`),
).pipe(Effect.asVoid);

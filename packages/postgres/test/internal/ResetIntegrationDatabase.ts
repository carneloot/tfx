import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';

export const resetIntegrationDatabase = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const rows = yield* sql<{
		readonly database: string;
	}>`SELECT current_database() AS database`;
	const database = rows[0]?.database;
	if (
		database === undefined ||
		(database !== 'test' && !database.endsWith('_test'))
	)
		return yield* Effect.die(
			new Error(`Integration database must end in _test; received ${database}`),
		);
	yield* sql.unsafe(`
		DO $$ DECLARE schema_name text;
		BEGIN
			FOR schema_name IN
				SELECT nspname
				FROM pg_namespace
				WHERE nspname = 'carneloot' OR left(nspname, 4) = 'tfx_'
			LOOP
				EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', schema_name);
			END LOOP;
		END $$
	`);
}).pipe(Effect.asVoid);

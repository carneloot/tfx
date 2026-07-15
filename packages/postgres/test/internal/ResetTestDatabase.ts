import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
export const reset = Effect.flatMap(PgClient.PgClient, (sql) =>
	sql.unsafe(`
	DO $$ DECLARE row record;
	BEGIN
		FOR row IN SELECT tablename FROM pg_tables WHERE schemaname = current_schema() LOOP
			EXECUTE format('TRUNCATE TABLE %I RESTART IDENTITY CASCADE', row.tablename);
		END LOOP;
	END $$
`),
).pipe(Effect.asVoid);

import type * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';

import type { Tables } from './Tables.js';

export const up = (sql: PgClient.PgClient, tables: Tables) =>
	Effect.gen(function* () {
		const schema = sql(tables.schema);
		const outbox = sql(tables.jobWakeups);
		const jobs = sql(tables.jobs);
		const notify = sql(tables.jobWakeupFunction);
		// One coalesced intent per job. Acknowledging an old revision cannot erase
		// a concurrent replacement, retry, heartbeat or cancellation.
		yield* sql`CREATE TABLE ${schema}.${outbox} (id uuid PRIMARY KEY, revision uuid NOT NULL DEFAULT gen_random_uuid())`;
		yield* sql`CREATE FUNCTION ${schema}.${notify}() RETURNS trigger LANGUAGE plpgsql AS $$
	BEGIN
		EXECUTE format('INSERT INTO %I.%I (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET revision=gen_random_uuid()', TG_TABLE_SCHEMA, TG_ARGV[0]) USING COALESCE(NEW.id, OLD.id);
		RETURN NULL;
	END $$`;
		yield* sql.unsafe(
			`CREATE TRIGGER job_wakeup AFTER INSERT OR UPDATE OR DELETE ON "${tables.schema}"."${tables.jobs}" FOR EACH ROW EXECUTE FUNCTION "${tables.schema}"."${tables.jobWakeupFunction}"('${tables.jobWakeups}')`,
		);
		yield* sql`INSERT INTO ${schema}.${outbox} (id) SELECT id FROM ${schema}.${jobs} WHERE status IN ('scheduled','running')`;
	});

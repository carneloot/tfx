import type * as PgClient from '@effect/sql-pg/PgClient';

import type { Tables } from './Tables.js';

export const up = (sql: PgClient.PgClient, tables: Tables) => {
	const schema = sql(tables.schema);
	const dedup = sql(tables.deduplication);
	const constraint = sql(tables.dedupOutcomeConstraint);
	return sql`ALTER TABLE ${schema}.${dedup} ADD CONSTRAINT ${constraint} CHECK (
		(status = 'completed' AND outcome_json IS NOT NULL AND completed_at IS NOT NULL)
		OR (status <> 'completed' AND outcome_json IS NULL AND completed_at IS NULL)
	)`;
};

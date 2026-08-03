import type * as PgClient from '@effect/sql-pg/PgClient';

import type { Tables } from './Tables.js';

export const up = (sql: PgClient.PgClient, tables: Tables) => {
	const schema = sql(tables.schema);
	const conversations = sql(tables.conversations);
	return sql`ALTER TABLE ${schema}.${conversations}
		ADD COLUMN instance_id uuid NOT NULL DEFAULT gen_random_uuid(),
		ADD COLUMN origin_trace_id text,
		ADD COLUMN origin_span_id text,
		ADD COLUMN origin_span_sampled boolean`;
};

import type * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';

import type { Tables } from './Tables.js';

export const up = (sql: PgClient.PgClient, tables: Tables) => {
	const schema = sql(tables.schema);
	const jobs = sql(tables.jobs);
	const constraint = sql(tables.jobStateConstraint);
	return Effect.gen(function* () {
		yield* sql`UPDATE ${schema}.${jobs} SET outcome_json=NULL WHERE status='running'`;
		yield* sql`UPDATE ${schema}.${jobs} SET outcome_json=NULL WHERE status='quarantined' AND outcome_json IS NOT NULL AND outcome_json->>'_tag' <> 'FatalFailure'`;
		yield* sql`ALTER TABLE ${schema}.${jobs} ADD CONSTRAINT ${constraint} CHECK (
			(
				status='scheduled'
				AND (
					(lease_phase IS NULL AND lease_expires_at IS NULL)
					OR (lease_phase='migration' AND lease_expires_at IS NOT NULL)
				)
				AND (
					outcome_json IS NULL
					OR COALESCE(outcome_json->>'_tag' IN ('RetryableFailure','LeaseLost'), false)
				)
			)
			OR (
				status='running'
				AND lease_phase='execution'
				AND lease_expires_at IS NOT NULL
				AND outcome_json IS NULL
			)
			OR (
				status='completed'
				AND lease_phase IS NULL
				AND lease_expires_at IS NULL
				AND COALESCE(outcome_json->>'_tag'='Succeeded', false)
			)
			OR (
				status='failed'
				AND lease_phase IS NULL
				AND lease_expires_at IS NULL
				AND COALESCE(outcome_json->>'_tag' IN ('RetryableFailure','PermanentFailure','LeaseLost'), false)
			)
			OR (
				status='quarantined'
				AND lease_phase IS NULL
				AND lease_expires_at IS NULL
				AND (
					outcome_json IS NULL
					OR COALESCE(outcome_json->>'_tag'='FatalFailure', false)
				)
			)
			OR (
				status='cancelled'
				AND lease_phase IS NULL
				AND lease_expires_at IS NULL
				AND COALESCE(outcome_json->>'_tag'='Cancelled', false)
			)
		)`;
	});
};

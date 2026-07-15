import * as Effect from 'effect/Effect';
export const up = (sql, tables) =>
	Effect.gen(function* () {
		const schema = sql(tables.schema);
		const conversations = sql(tables.conversations);
		const jobs = sql(tables.jobs);
		const attempts = sql(tables.jobAttempts);
		const dedup = sql(tables.deduplication);
		const activeConflict = sql(tables.activeConflictIndex);
		yield* sql`CREATE SCHEMA IF NOT EXISTS ${schema}`;
		yield* sql`CREATE TABLE IF NOT EXISTS ${schema}.${conversations} (
		bot_id text NOT NULL, chat_id bigint NOT NULL, user_id bigint NOT NULL, conversation_id text NOT NULL,
		version integer NOT NULL, step text NOT NULL, state_json jsonb NOT NULL, revision bigint NOT NULL DEFAULT 0,
		last_update_id bigint, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
		PRIMARY KEY (bot_id, chat_id, user_id)
	)`;
		yield* sql`CREATE TABLE IF NOT EXISTS ${schema}.${jobs} (
		id uuid PRIMARY KEY, declaration text NOT NULL, payload_version integer NOT NULL, payload_json jsonb NOT NULL,
		status text NOT NULL CHECK (status IN ('scheduled','running','completed','failed','quarantined','cancelled')),
		conflict_key text, attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL, run_at timestamptz NOT NULL,
		lease_generation bigint NOT NULL DEFAULT 0, lease_phase text CHECK (lease_phase IS NULL OR lease_phase IN ('migration','execution')),
		lease_expires_at timestamptz, cancellation_requested boolean NOT NULL DEFAULT false, quarantine_json jsonb,
		last_error_json jsonb, outcome_json jsonb, completed_at timestamptz, failed_at timestamptz,
		created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
	)`;
		yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS ${activeConflict} ON ${schema}.${jobs} (declaration, conflict_key) WHERE conflict_key IS NOT NULL AND status IN ('scheduled','running')`;
		yield* sql`CREATE TABLE IF NOT EXISTS ${schema}.${attempts} (
		job_id uuid NOT NULL REFERENCES ${schema}.${jobs}(id) ON DELETE CASCADE, attempt integer NOT NULL,
		lease_generation bigint NOT NULL, started_at timestamptz NOT NULL, finished_at timestamptz,
		outcome text, error_json jsonb, PRIMARY KEY (job_id, attempt)
	)`;
		yield* sql`CREATE TABLE IF NOT EXISTS ${schema}.${dedup} (
		bot_id text NOT NULL, update_id bigint NOT NULL, status text NOT NULL CHECK (status IN ('processing','completed','released')),
		lease_generation bigint NOT NULL DEFAULT 0, lease_expires_at timestamptz NOT NULL, outcome_json jsonb,
		attempts integer NOT NULL DEFAULT 0, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
		PRIMARY KEY (bot_id, update_id)
	)`;
	});
//# sourceMappingURL=0001_tfx_core.js.map

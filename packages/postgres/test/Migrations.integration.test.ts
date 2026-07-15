import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import { describe, expect, it } from 'vitest';

import { migrate } from '../src/internal/Migrator.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';
const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
describe.skipIf(!enabled)('PostgreSQL migrations', () => {
	it('is identifier-safe, configurable, coordinated, and idempotent', async () => {
		const options = { schema: 'tfx_test', tablePrefix: 'case_' };
		const program = Effect.gen(function* () {
			yield* Effect.all([migrate(options), migrate(options)], {
				concurrency: 'unbounded',
			});
			yield* migrate(options);
			const sql = yield* PgClient.PgClient;
			const tables = yield* sql<{
				table_name: string;
			}>`SELECT table_name FROM information_schema.tables WHERE table_schema=${options.schema} ORDER BY table_name`;
			const ledger = yield* sql<{
				version: number;
				name: string;
			}>`SELECT version,name FROM tfx_test.case_migrations ORDER BY version`;
			return { tables, ledger };
		});
		const rows = await Effect.runPromise(
			Effect.provide(program, PostgresTestLayer.layer),
		);
		expect(rows.tables.map((row) => row.table_name)).toEqual([
			'case_conversations',
			'case_job_attempts',
			'case_jobs',
			'case_migrations',
			'case_update_deduplication',
		]);
		expect(rows.ledger).toEqual([
			{ version: 1, name: 'tfx-core' },
			{ version: 2, name: 'dedup-outcome-invariant' },
		]);
	});
});

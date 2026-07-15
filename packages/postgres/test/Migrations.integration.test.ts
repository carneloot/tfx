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
			yield* migrate(options);
			yield* migrate(options);
			const sql = yield* PgClient.PgClient;
			return yield* sql<{
				table_name: string;
			}>`SELECT table_name FROM information_schema.tables WHERE table_schema=${options.schema} ORDER BY table_name`;
		});
		const rows = await Effect.runPromise(
			Effect.provide(program, PostgresTestLayer.layer),
		);
		expect(rows.map((row) => row.table_name)).toEqual([
			'case_conversations',
			'case_job_attempts',
			'case_jobs',
			'case_update_deduplication',
		]);
	});
});

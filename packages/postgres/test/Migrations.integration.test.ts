import * as PgClient from '@effect/sql-pg/PgClient';
import { Deferred, Effect, Fiber } from 'effect';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { migrate } from '../src/internal/Migrator.js';
import * as PostgresTestLayer from './internal/PostgresTestLayer.js';
const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const sourceChecksum = (name: string) =>
	createHash('sha256')
		.update(readFileSync(new URL(`../src/internal/${name}`, import.meta.url)))
		.digest('hex');
describe.skipIf(!enabled)('PostgreSQL migrations', () => {
	it('is identifier-safe, configurable, coordinated, and idempotent', async () => {
		const options = { schema: 'tfx_test', tablePrefix: 'case_' };
		const program = Effect.gen(function* () {
			const readyA = yield* Deferred.make<void>();
			const readyB = yield* Deferred.make<void>();
			const go = yield* Deferred.make<void>();
			const run = (ready: Deferred.Deferred<void>) =>
				Effect.andThen(
					Deferred.succeed(ready, undefined),
					Effect.andThen(Deferred.await(go), migrate(options)),
				);
			const a = yield* Effect.forkChild(run(readyA));
			const b = yield* Effect.forkChild(run(readyB));
			yield* Deferred.await(readyA);
			yield* Deferred.await(readyB);
			yield* Deferred.succeed(go, undefined);
			yield* Fiber.join(a);
			yield* Fiber.join(b);
			yield* migrate(options);
			const sql = yield* PgClient.PgClient;
			const tables = yield* sql<{
				table_name: string;
			}>`SELECT table_name FROM information_schema.tables WHERE table_schema=${options.schema} ORDER BY table_name`;
			const ledger = yield* sql<{
				version: number;
				name: string;
				checksum: string;
			}>`SELECT version,name,checksum FROM tfx_test.case_migrations ORDER BY version`;
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
			{
				version: 1,
				name: 'tfx-core',
				checksum: sourceChecksum('Migration0001.ts'),
			},
			{
				version: 2,
				name: 'dedup-outcome-invariant',
				checksum: sourceChecksum('Migration0002.ts'),
			},
		]);
		expect(
			rows.ledger.every((row) => /^[0-9a-f]{64}$/u.test(row.checksum)),
		).toBe(true);
	});

	it('rejects ledger checksum drift without applying work', async () => {
		const options = { schema: 'tfx_checksum_test', tablePrefix: 'case_' };
		const program = Effect.gen(function* () {
			yield* migrate(options);
			const sql = yield* PgClient.PgClient;
			yield* sql`UPDATE tfx_checksum_test.case_migrations SET checksum='bad' WHERE version=1`;
			const result = yield* Effect.result(migrate(options));
			const count = yield* sql<{
				count: string;
			}>`SELECT count(*)::text AS count FROM tfx_checksum_test.case_migrations`;
			yield* sql`UPDATE tfx_checksum_test.case_migrations SET checksum=${sourceChecksum('Migration0001.ts')} WHERE version=1`;
			return { result, count: count[0]?.count };
		});
		const result = await Effect.runPromise(
			Effect.provide(program, PostgresTestLayer.layer),
		);
		expect(result.result).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'MigrationChecksumMismatchError', version: 1 },
		});
		expect(result.count).toBe('2');
	});
});

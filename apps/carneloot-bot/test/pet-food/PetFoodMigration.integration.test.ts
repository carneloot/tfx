import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { migrate } from '../../src/postgres/AppMigrator.js';
import { migration0001Checksum } from '../../src/postgres/Migration0001Sql.js';
import { migration0002Checksum } from '../../src/postgres/Migration0002Sql.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';
const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
describe.skipIf(!enabled)('pet food migration', () => {
	it('applies immutable migrations in order under concurrent startup', async () => {
		const program = Effect.gen(function* () {
			yield* Effect.all([migrate, migrate], { concurrency: 'unbounded' });
			const sql = yield* PgClient.PgClient;
			const ledger = yield* sql<{
				version: number;
				name: string;
				checksum: string;
			}>`SELECT version,name,checksum FROM carneloot.app_migrations ORDER BY version`;
			const constraints = yield* sql<{
				constraint_name: string;
			}>`SELECT constraint_name FROM information_schema.table_constraints WHERE table_schema='carneloot' AND table_name IN ('pet_food_settings','pet_food_entries') ORDER BY constraint_name`;
			const indexes = yield* sql<{
				indexname: string;
			}>`SELECT indexname FROM pg_indexes WHERE schemaname='carneloot' AND tablename='pet_food_entries'`;
			return { ledger, constraints, indexes };
		});
		const result = await Effect.runPromise(
			Effect.provide(program, PostgresTestLayer.layer),
		);
		expect(result.ledger).toEqual([
			{ version: 1, name: 'identity-pets', checksum: migration0001Checksum },
			{ version: 2, name: 'pet-food', checksum: migration0002Checksum },
		]);
		expect(result.constraints.map((row) => row.constraint_name)).toEqual(
			expect.arrayContaining([
				'pet_food_entries_amount_range',
				'pet_food_entries_source_key',
				'pet_food_settings_day_start_timezone_pair',
				'pet_food_settings_reminder_delay_range',
			]),
		);
		expect(result.indexes.map((row) => row.indexname)).toContain(
			'pet_food_entries_latest_idx',
		);
	});
});

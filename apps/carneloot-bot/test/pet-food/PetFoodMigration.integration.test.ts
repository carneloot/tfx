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
	it('rejects unknown future versions and a missing applied prefix', async () => {
		const program = Effect.gen(function* () {
			yield* migrate;
			const sql = yield* PgClient.PgClient;
			return yield* sql.withTransaction(
				Effect.gen(function* () {
					yield* sql`SELECT pg_advisory_xact_lock(hashtextextended('carneloot:app_migrations', 0))`;
					yield* sql`INSERT INTO carneloot.app_migrations (version,name,checksum) VALUES (99,'future','future')`;
					const unknown = yield* Effect.result(migrate);
					yield* sql`DELETE FROM carneloot.app_migrations WHERE version=99`;
					yield* sql`DELETE FROM carneloot.app_migrations WHERE version=1`;
					const gap = yield* Effect.result(migrate);
					yield* sql`INSERT INTO carneloot.app_migrations (version,name,checksum) VALUES (1,'identity-pets',${migration0001Checksum})`;
					return { unknown, gap };
				}),
			);
		});
		const result = await Effect.runPromise(
			Effect.provide(program, PostgresTestLayer.layer),
		);
		for (const failure of [result.unknown, result.gap])
			expect(failure).toMatchObject({
				_tag: 'Failure',
				failure: { _tag: 'DomainPersistenceError' },
			});
	});
	it('executes FK, range, null-pair, uniqueness, and cascade constraints', async () => {
		const userId = crypto.randomUUID();
		const petId = crypto.randomUUID();
		const missingPetId = crypto.randomUUID();
		const missingUserId = crypto.randomUUID();
		const program = Effect.gen(function* () {
			yield* migrate;
			const sql = yield* PgClient.PgClient;
			return yield* Effect.gen(function* () {
				yield* sql`INSERT INTO carneloot.users (id,created_at,updated_at) VALUES (${userId}::uuid,now(),now())`;
				yield* sql`INSERT INTO carneloot.pets (id,owner_id,name,name_key,created_at,updated_at) VALUES (${petId}::uuid,${userId}::uuid,'Constraint pet','constraint pet',now(),now())`;
				yield* sql`INSERT INTO carneloot.pet_food_settings (pet_id,day_start,timezone,reminder_delay_ms,created_at,updated_at) VALUES (${petId}::uuid,NULL,NULL,NULL,now(),now())`;

				const settingsPetFk = yield* Effect.result(
					sql`INSERT INTO carneloot.pet_food_settings (pet_id,day_start,timezone,reminder_delay_ms,created_at,updated_at) VALUES (${missingPetId}::uuid,NULL,NULL,NULL,now(),now())`,
				);
				const dayStartPair = yield* Effect.result(
					sql`UPDATE carneloot.pet_food_settings SET day_start=${'08:00'}::time WHERE pet_id=${petId}::uuid`,
				);
				const timeZonePair = yield* Effect.result(
					sql`UPDATE carneloot.pet_food_settings SET timezone='UTC' WHERE pet_id=${petId}::uuid`,
				);
				const zeroDelay = yield* Effect.result(
					sql`UPDATE carneloot.pet_food_settings SET reminder_delay_ms=0 WHERE pet_id=${petId}::uuid`,
				);
				const excessiveDelay = yield* Effect.result(
					sql`UPDATE carneloot.pet_food_settings SET reminder_delay_ms=2592000001 WHERE pet_id=${petId}::uuid`,
				);

				const entryId = crypto.randomUUID();
				yield* sql`INSERT INTO carneloot.pet_food_entries (id,pet_id,recorded_by,amount_mg,fed_at,source_bot_id,source_update_id,created_at,updated_at) VALUES (${entryId}::uuid,${petId}::uuid,${userId}::uuid,50000,now(),'constraint-test',1,now(),now())`;
				const duplicateSource = yield* Effect.result(
					sql`INSERT INTO carneloot.pet_food_entries (id,pet_id,recorded_by,amount_mg,fed_at,source_bot_id,source_update_id,created_at,updated_at) VALUES (${crypto.randomUUID()}::uuid,${petId}::uuid,${userId}::uuid,50000,now(),'constraint-test',1,now(),now())`,
				);
				const zeroAmount = yield* Effect.result(
					sql`INSERT INTO carneloot.pet_food_entries (id,pet_id,recorded_by,amount_mg,fed_at,source_bot_id,source_update_id,created_at,updated_at) VALUES (${crypto.randomUUID()}::uuid,${petId}::uuid,${userId}::uuid,0,now(),'constraint-test',2,now(),now())`,
				);
				const excessiveAmount = yield* Effect.result(
					sql`INSERT INTO carneloot.pet_food_entries (id,pet_id,recorded_by,amount_mg,fed_at,source_bot_id,source_update_id,created_at,updated_at) VALUES (${crypto.randomUUID()}::uuid,${petId}::uuid,${userId}::uuid,100000001,now(),'constraint-test',3,now(),now())`,
				);
				const entryPetFk = yield* Effect.result(
					sql`INSERT INTO carneloot.pet_food_entries (id,pet_id,recorded_by,amount_mg,fed_at,source_bot_id,source_update_id,created_at,updated_at) VALUES (${crypto.randomUUID()}::uuid,${missingPetId}::uuid,${userId}::uuid,1,now(),'constraint-test',4,now(),now())`,
				);
				const recorderFk = yield* Effect.result(
					sql`INSERT INTO carneloot.pet_food_entries (id,pet_id,recorded_by,amount_mg,fed_at,source_bot_id,source_update_id,created_at,updated_at) VALUES (${crypto.randomUUID()}::uuid,${petId}::uuid,${missingUserId}::uuid,1,now(),'constraint-test',5,now(),now())`,
				);

				yield* sql`DELETE FROM carneloot.pets WHERE id=${petId}::uuid`;
				const children = yield* sql<{
					settings: number;
					entries: number;
				}>`SELECT (SELECT count(*)::int FROM carneloot.pet_food_settings WHERE pet_id=${petId}::uuid) settings,(SELECT count(*)::int FROM carneloot.pet_food_entries WHERE pet_id=${petId}::uuid) entries`;
				return {
					failures: [
						settingsPetFk,
						dayStartPair,
						timeZonePair,
						zeroDelay,
						excessiveDelay,
						duplicateSource,
						zeroAmount,
						excessiveAmount,
						entryPetFk,
						recorderFk,
					],
					children: children[0],
				};
			}).pipe(
				Effect.ensuring(
					sql`DELETE FROM carneloot.users WHERE id=${userId}::uuid`.pipe(
						Effect.ignore,
					),
				),
			);
		});
		const result = await Effect.runPromise(
			Effect.provide(program, PostgresTestLayer.layer),
		);
		expect(result.failures).toHaveLength(10);
		expect(result.failures.every((exit) => exit._tag === 'Failure')).toBe(true);
		expect(result.children).toEqual({ settings: 0, entries: 0 });
	});
});

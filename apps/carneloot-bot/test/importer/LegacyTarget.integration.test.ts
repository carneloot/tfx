import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Layer } from 'effect';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { MappedLegacy } from '../../src/importer/LegacyMapping.js';
import { LegacyTarget } from '../../src/importer/LegacyTarget.js';
import * as LegacyTargetLive from '../../src/importer/LegacyTargetLive.js';
import { migrate } from '../../src/postgres/AppMigrator.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';

describe.skipIf(!enabled)('legacy target dry run', () => {
	it('returns inserted counts while rolling target and ledger rows back', async () => {
		const id = randomUUID();
		const mapped: MappedLegacy = {
			fingerprint: `dry-run-${id}`,
			rows: [
				{
					sourceTable: 'users',
					sourceKey: '1',
					targetTable: 'users',
					targetKey: id,
					value: {
						id,
						created_at: '2026-01-01T00:00:00.000Z',
						updated_at: '2026-01-01T00:00:00.000Z',
					},
				},
			],
			rounding: [],
			warnings: [],
		};
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const target = yield* LegacyTarget;
				yield* migrate;
				const promotion = yield* target.promote(mapped, { dryRun: true });
				const users = yield* sql<{
					readonly count: number;
				}>`SELECT count(*)::int count FROM carneloot.users WHERE id=${id}`;
				const ledgers = yield* sql<{
					readonly count: number;
				}>`SELECT count(*)::int count FROM carneloot.legacy_import_ledger WHERE source_fingerprint=${mapped.fingerprint}`;
				return {
					promotion,
					users: users[0]?.count,
					ledgers: ledgers[0]?.count,
				};
			}).pipe(
				Effect.provide(
					Layer.provideMerge(LegacyTargetLive.layer, PostgresTestLayer.layer),
				),
			),
		);
		expect(result.promotion).toEqual({ inserted: { users: 1 }, existing: {} });
		expect(result.users).toBe(0);
		expect(result.ledgers).toBe(0);
	});

	it('promotes food entries across probe batches while adopting existing targets', async () => {
		const userId = randomUUID();
		const petId = randomUUID();
		const foodIds = Array.from({ length: 501 }, () => randomUUID());
		const timestamp = '2026-01-01T00:00:00.000Z';
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const target = yield* LegacyTarget;
				yield* migrate;
				yield* sql`INSERT INTO carneloot.users (id,created_at,updated_at) VALUES (${userId},${timestamp},${timestamp})`;
				yield* sql`INSERT INTO carneloot.pets (id,owner_id,name,name_key,created_at,updated_at) VALUES (${petId},${userId},${'Batch'},${'batch'},${timestamp},${timestamp})`;
				yield* sql`INSERT INTO carneloot.pet_food_entries (id,pet_id,recorded_by,amount_mg,fed_at,source_bot_id,source_update_id,source_message_chat_id,source_message_id,created_at,updated_at) VALUES (${foodIds[0]!},${petId},${userId},${1000},${timestamp},${'legacy-batch'},${1},${null},${null},${timestamp},${timestamp})`;
				const users = yield* sql<{
					readonly row: Record<string, unknown>;
				}>`SELECT to_jsonb(t) row FROM carneloot.users t WHERE id=${userId}`;
				const pets = yield* sql<{
					readonly row: Record<string, unknown>;
				}>`SELECT to_jsonb(t) row FROM carneloot.pets t WHERE id=${petId}`;
				const existingFood = yield* sql<{
					readonly row: Record<string, unknown>;
				}>`SELECT to_jsonb(t) row FROM carneloot.pet_food_entries t WHERE id=${foodIds[0]!}`;
				const mapped: MappedLegacy = {
					fingerprint: `batch-${randomUUID()}`,
					rows: [
						{
							sourceTable: 'users',
							sourceKey: '1',
							targetTable: 'users',
							targetKey: userId,
							value: users[0]!.row,
						},
						{
							sourceTable: 'pets',
							sourceKey: '1',
							targetTable: 'pets',
							targetKey: petId,
							value: pets[0]!.row,
						},
						...foodIds.map((id, index) => ({
							sourceTable: 'pet_food',
							sourceKey: String(index + 1),
							targetTable: 'pet_food_entries',
							targetKey: id,
							value:
								index === 0
									? existingFood[0]!.row
									: {
											id,
											pet_id: petId,
											recorded_by: userId,
											amount_mg: 1000,
											fed_at: timestamp,
											source_bot_id: 'legacy-batch',
											source_update_id: index + 1,
											source_message_chat_id: null,
											source_message_id: null,
											created_at: timestamp,
											updated_at: timestamp,
										},
						})),
					],
					rounding: [],
					warnings: [],
				};
				const promotion = yield* target.promote(mapped, { dryRun: false });
				const foodCount = yield* sql<{
					readonly count: number;
				}>`SELECT count(*)::int count FROM carneloot.pet_food_entries WHERE pet_id=${petId}`;
				const ledgerCount = yield* sql<{
					readonly count: number;
				}>`SELECT count(*)::int count FROM carneloot.legacy_import_ledger WHERE source_fingerprint=${mapped.fingerprint}`;
				return {
					promotion,
					foodCount: foodCount[0]?.count,
					ledgerCount: ledgerCount[0]?.count,
				};
			}).pipe(
				Effect.provide(
					Layer.provideMerge(LegacyTargetLive.layer, PostgresTestLayer.layer),
				),
			),
		);
		expect(result.promotion).toEqual({
			inserted: { pet_food: 500 },
			existing: { users: 1, pets: 1, pet_food: 1 },
		});
		expect(result.foodCount).toBe(501);
		expect(result.ledgerCount).toBe(503);
	});

	it('deduplicates mapped targets across probe batches while retaining ledgers', async () => {
		const id = randomUUID();
		const timestamp = '2026-01-01T00:00:00.000Z';
		const mapped: MappedLegacy = {
			fingerprint: `duplicate-${id}`,
			rows: Array.from({ length: 501 }, (_, index) => ({
				sourceTable: 'legacy_users',
				sourceKey: String(index + 1),
				targetTable: 'users' as const,
				targetKey: id,
				value: { id, created_at: timestamp, updated_at: timestamp },
			})),
			rounding: [],
			warnings: [],
		};
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const target = yield* LegacyTarget;
				yield* migrate;
				const promotion = yield* target.promote(mapped, { dryRun: false });
				const users = yield* sql<{
					readonly count: number;
				}>`SELECT count(*)::int count FROM carneloot.users WHERE id=${id}`;
				const ledgers = yield* sql<{
					readonly count: number;
				}>`SELECT count(*)::int count FROM carneloot.legacy_import_ledger WHERE source_fingerprint=${mapped.fingerprint}`;
				return {
					promotion,
					users: users[0]?.count,
					ledgers: ledgers[0]?.count,
				};
			}).pipe(
				Effect.provide(
					Layer.provideMerge(LegacyTargetLive.layer, PostgresTestLayer.layer),
				),
			),
		);
		expect(result.promotion).toEqual({
			inserted: { legacy_users: 1 },
			existing: { legacy_users: 500 },
		});
		expect(result.users).toBe(1);
		expect(result.ledgers).toBe(501);
	});

	it('adopts preexisting composite targets through typed probes', async () => {
		const userId = randomUUID();
		const botId = `bot-${randomUUID()}`;
		const timestamp = '2026-01-01T00:00:00.000Z';
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const target = yield* LegacyTarget;
				yield* migrate;
				yield* sql`INSERT INTO carneloot.users (id,created_at,updated_at) VALUES (${userId},${timestamp},${timestamp})`;
				yield* sql`INSERT INTO carneloot.telegram_identities (bot_id,telegram_user_id,user_id,username,first_name,last_name,private_chat_id,created_at,updated_at) VALUES (${botId},${42},${userId},${null},${'Composite'},${null},${42},${timestamp},${timestamp})`;
				const identity = yield* sql<{
					readonly row: Record<string, unknown>;
				}>`SELECT to_jsonb(t) row FROM carneloot.telegram_identities t WHERE bot_id=${botId} AND telegram_user_id=${42}`;
				const mapped: MappedLegacy = {
					fingerprint: `composite-${randomUUID()}`,
					rows: [
						{
							sourceTable: 'identities',
							sourceKey: '1',
							targetTable: 'telegram_identities',
							targetKey: `${botId}/42`,
							value: identity[0]!.row,
						},
					],
					rounding: [],
					warnings: [],
				};
				const promotion = yield* target.promote(mapped, { dryRun: false });
				const ledgers = yield* sql<{
					readonly count: number;
				}>`SELECT count(*)::int count FROM carneloot.legacy_import_ledger WHERE source_fingerprint=${mapped.fingerprint}`;
				return { promotion, ledgers: ledgers[0]?.count };
			}).pipe(
				Effect.provide(
					Layer.provideMerge(LegacyTargetLive.layer, PostgresTestLayer.layer),
				),
			),
		);
		expect(result.promotion).toEqual({
			inserted: {},
			existing: { identities: 1 },
		});
		expect(result.ledgers).toBe(1);
	});
});

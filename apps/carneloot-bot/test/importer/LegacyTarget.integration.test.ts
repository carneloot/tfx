import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Layer } from 'effect';
import { createHash, randomUUID } from 'node:crypto';
import { Telegram } from 'tfx/Telegram';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bot/Declaration.js', () => ({ botId: 'carneloot' }));

import * as SendExternalNotification from '../../src/application/SendExternalNotification.js';
import {
	mapLegacySnapshot,
	type MappedLegacy,
} from '../../src/importer/LegacyMapping.js';
import {
	legacyTables,
	type LegacySnapshot,
} from '../../src/importer/LegacySchemas.js';
import { LegacyTarget } from '../../src/importer/LegacyTarget.js';
import * as LegacyTargetLive from '../../src/importer/LegacyTargetLive.js';
import { migrate } from '../../src/postgres/AppMigrator.js';
import * as RepositoriesLive from '../../src/postgres/RepositoriesLive.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

const emptySnapshot = () =>
	Object.fromEntries(
		legacyTables.map((table) => [table, []]),
	) as unknown as LegacySnapshot;

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

	it('promotes imported notification provisioning idempotently for external delivery', async () => {
		const apiKey = `legacy-key-${randomUUID()}`;
		const keyHash = createHash('sha256').update(apiKey).digest('hex');
		const snapshot = emptySnapshot() as any;
		snapshot.users = [
			{
				id: 'owner',
				telegram_id: '41',
				username: null,
				first_name: 'Owner',
				last_name: null,
			},
			{
				id: 'subscriber',
				telegram_id: '42',
				username: null,
				first_name: 'Subscriber',
				last_name: null,
			},
		];
		snapshot.api_keys = [
			{ id: 'key', user_id: 'owner', key: keyHash, created_at: 1_700_000_000 },
		];
		snapshot.notifications = [
			{
				id: 'template',
				owner_id: 'owner',
				keyword: 'meal',
				message: 'Hello {{name}}',
			},
		];
		snapshot.users_to_notify = [
			{
				id: 'subscription',
				notification_id: 'template',
				user_id: 'subscriber',
			},
		];
		const fingerprint = `notifications-${randomUUID()}`;
		const firstMapped = await Effect.runPromise(
			mapLegacySnapshot(
				snapshot,
				fingerprint,
				'carneloot',
				new Date('2026-01-01T00:00:00.000Z'),
			).pipe(Effect.provide(NodeCrypto.layer)),
		);
		const secondMapped = await Effect.runPromise(
			mapLegacySnapshot(
				snapshot,
				fingerprint,
				'carneloot',
				new Date('2026-02-01T00:00:00.000Z'),
			).pipe(Effect.provide(NodeCrypto.layer)),
		);
		const sent: Array<Record<string, unknown>> = [];
		const telegram = Layer.succeed(Telegram, {
			sendMessage: (request: Record<string, unknown>) =>
				Effect.sync(() => {
					sent.push(request);
					return { message_id: sent.length };
				}),
		} as never);
		const services = Layer.provideMerge(
			Layer.merge(LegacyTargetLive.layer, RepositoriesLive.layer),
			Layer.mergeAll(PostgresTestLayer.layer, NodeCrypto.layer, telegram),
		);
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const target = yield* LegacyTarget;
				const first = yield* target.promote(firstMapped, { dryRun: false });
				const second = yield* target.promote(secondMapped, { dryRun: false });
				const key = yield* sql<{
					readonly key_hash: string;
					readonly user_id: string;
				}>`SELECT key_hash,user_id FROM carneloot.api_keys WHERE id=${firstMapped.rows.find((row) => row.targetTable === 'api_keys')!.value.id}`;
				const template = yield* sql<{
					readonly owner_user_id: string;
					readonly keyword: string;
					readonly message: string;
				}>`SELECT owner_user_id,keyword,message FROM carneloot.notification_templates WHERE id=${firstMapped.rows.find((row) => row.targetTable === 'notification_templates')!.value.id}`;
				const subscriptions = yield* sql<{
					readonly count: number;
				}>`SELECT count(*)::int count FROM carneloot.notification_subscriptions WHERE template_id=${firstMapped.rows.find((row) => row.targetTable === 'notification_templates')!.value.id}`;
				const delivery = yield* SendExternalNotification.execute({
					apiKey,
					keyword: 'meal',
					variables: { name: 'Mimo' },
				});
				return {
					first,
					second,
					key: key[0],
					template: template[0],
					subscriptions: subscriptions[0]?.count,
					delivery,
				};
			}).pipe(Effect.provide(services)),
		);
		expect(result.first.inserted).toMatchObject({
			users: 4,
			api_keys: 1,
			notifications: 1,
			users_to_notify: 1,
		});
		expect(result.second).toEqual({
			inserted: {},
			existing: result.first.inserted,
		});
		expect(result.key?.key_hash).toBe(keyHash);
		expect(result.template?.owner_user_id).toBe(result.key?.user_id);
		expect(result.template).toMatchObject({
			keyword: 'meal',
			message: 'Hello {{name}}',
		});
		expect(result.subscriptions).toBe(1);
		expect(result.delivery).toMatchObject({
			status: 'sent',
			counts: { sent: 2, failed: 0, unknown: 0 },
		});
		expect(sent).toEqual([
			{ chat_id: 41, text: 'Hello Mimo' },
			{ chat_id: 42, text: 'Hello Mimo' },
		]);
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

import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import {
	mapLegacySnapshot,
	updateIdFromDigest,
} from '../../src/importer/LegacyMapping.js';
import {
	legacyTables,
	type LegacySnapshot,
} from '../../src/importer/LegacySchemas.js';
const empty = () =>
	Object.fromEntries(
		legacyTables.map((t) => [t, []]),
	) as unknown as LegacySnapshot;
describe('legacy mapping', () => {
	it('uses all first 53 digest bits without 32-bit truncation', () => {
		expect(
			updateIdFromDigest(Uint8Array.from([255, 255, 255, 255, 255, 255, 248])),
		).toBe(Number.MAX_SAFE_INTEGER);
		expect(
			updateIdFromDigest(Uint8Array.from([1, 2, 3, 4, 5, 6, 248])),
		).toBeGreaterThan(0xffffffff);
	});
	it('decodes legacy config blobs with schemas', async () => {
		const snapshot = empty() as any;
		snapshot.users = [
			{
				id: 'u',
				telegram_id: '42',
				username: null,
				first_name: 'A',
				last_name: null,
			},
		];
		snapshot.pets = [{ id: 'p', name: 'Pet', owner_id: 'u' }];
		snapshot.configs = [
			{
				id: 'day-start',
				context: 'pet:p',
				key: 'dayStart',
				value: new TextEncoder().encode(
					'{"hour":4,"timezone":"America/Sao_Paulo"}',
				).buffer,
			},
			{
				id: 'delay',
				context: 'pet:p',
				key: 'notificationDelay',
				value: new TextEncoder().encode('{"hours":2,"seconds":30}').buffer,
			},
		];
		const mapped = await Effect.runPromise(
			mapLegacySnapshot(
				snapshot,
				'sha256:test',
				'bot',
				new Date('2026-01-01'),
			).pipe(Effect.provide(NodeCrypto.layer)),
		);
		const settings = mapped.rows.find(
			(row) => row.targetTable === 'pet_food_settings',
		)!.value;
		expect(settings.day_start).toBe('04:00');
		expect(settings.timezone).toBe('America/Sao_Paulo');
		expect(settings.reminder_delay_ms).toBe(7_230_000);
	});

	it('reports unknown configs and leaves invalid known configs for verification', async () => {
		const snapshot = empty() as any;
		snapshot.users = [
			{
				id: 'u',
				telegram_id: '42',
				username: null,
				first_name: 'A',
				last_name: null,
			},
		];
		snapshot.pets = [{ id: 'p', name: 'Pet', owner_id: 'u' }];
		snapshot.configs = [
			{
				id: 'invalid',
				context: 'pet:p',
				key: 'dayStart',
				value: '{"hour":0,"timezone":"UTC"}',
			},
			{ id: 'unknown', context: 'pet:p', key: 'other', value: '{}' },
		];
		const mapped = await Effect.runPromise(
			mapLegacySnapshot(
				snapshot,
				'sha256:test',
				'bot',
				new Date('2026-01-01'),
			).pipe(Effect.provide(NodeCrypto.layer)),
		);
		expect(
			mapped.rows.find((row) => row.targetTable === 'pet_food_settings'),
		).toBeUndefined();
		expect(mapped.warnings).toContainEqual(
			expect.objectContaining({
				code: 'unknown-config-key',
				sourceKey: 'unknown',
			}),
		);
	});

	it('maps notification provisioning with stable ownership and subscriptions', async () => {
		const snapshot = empty() as any;
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
			{
				id: 'key',
				user_id: 'owner',
				key: 'a'.repeat(64),
				created_at: 1_700_000_000,
			},
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
		snapshot.notification_history = [
			{
				id: 'history',
				notification_id: 'template',
				pet_id: null,
				user_id: 'owner',
				message_id: 7,
				sent_at: 1_700_000_000,
			},
		];
		const mapped = await Effect.runPromise(
			mapLegacySnapshot(
				snapshot,
				'sha256:test',
				'bot',
				new Date('2026-01-01'),
			).pipe(Effect.provide(NodeCrypto.layer)),
		);
		const apiKey = mapped.rows.find((row) => row.targetTable === 'api_keys')!;
		const template = mapped.rows.find(
			(row) => row.targetTable === 'notification_templates',
		)!;
		const subscription = mapped.rows.find(
			(row) => row.targetTable === 'notification_subscriptions',
		)!;
		const history = mapped.rows.find(
			(row) => row.targetTable === 'notification_events',
		)!;
		expect(apiKey.value).toMatchObject({ key_hash: 'a'.repeat(64) });
		expect(apiKey.ignoredComparisonFields).toEqual([]);
		expect(template.value).toMatchObject({
			keyword: 'meal',
			message: 'Hello {{name}}',
			owner_user_id: apiKey.value.user_id,
		});
		expect(template.ignoredComparisonFields).toEqual([
			'created_at',
			'updated_at',
		]);
		expect(subscription.value).toMatchObject({
			template_id: template.value.id,
		});
		expect(subscription.ignoredComparisonFields).toEqual(['created_at']);
		expect(history.ignoredComparisonFields).toEqual([]);
		expect(subscription.targetKey).toBe(
			`${template.value.id}:${subscription.value.user_id}`,
		);
	});

	it('preserves food timestamp and reports exact rounding', async () => {
		const snapshot = empty() as any;
		snapshot.users = [
			{
				id: 'u',
				telegram_id: '42',
				username: null,
				first_name: 'A',
				last_name: null,
			},
		];
		snapshot.pets = [{ id: 'p', name: 'Pet', owner_id: 'u' }];
		snapshot.pet_food = [
			{
				id: 'f',
				pet_id: 'p',
				user_id: 'u',
				message_id: 7,
				quantity: 1.2345,
				time: 1700000000,
			},
		];
		const mapped = await Effect.runPromise(
			mapLegacySnapshot(
				snapshot,
				'sha256:test',
				'bot',
				new Date('2026-01-01'),
			).pipe(Effect.provide(NodeCrypto.layer)),
		);
		const food = mapped.rows.find(
			(r) => r.targetTable === 'pet_food_entries',
		)!.value;
		expect(food.amount_mg).toBe(1235);
		expect(food.fed_at).toBe('2023-11-14T22:13:20.000Z');
		expect(mapped.rounding[0]?.deltaMg).toBeCloseTo(0.5);
		expect(food.source_message_chat_id).toBe(42);
	});
});

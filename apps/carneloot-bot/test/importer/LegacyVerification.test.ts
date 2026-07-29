import * as DateTime from 'effect/DateTime';
import { describe, expect, it } from 'vitest';

import { countSummary } from '../../src/importer/LegacyReport.js';
import {
	decodeLegacyRow,
	legacyTables,
	type LegacySnapshot,
} from '../../src/importer/LegacySchemas.js';
import { verifyLegacy } from '../../src/importer/LegacyVerification.js';
const empty = () =>
	Object.fromEntries(
		legacyTables.map((table) => [table, []]),
	) as unknown as LegacySnapshot;
const mapped = (rows: any[] = [], warnings: any[] = []) => ({
	fingerprint: 'sha256:test',
	rounding: [],
	warnings,
	rows,
});
describe('legacy source schema', () => {
	it('accepts actual legacy user shape', () => {
		expect(
			decodeLegacyRow('users', {
				id: 'u1',
				telegram_id: '42',
				username: null,
				first_name: 'Ada',
				last_name: null,
			}),
		).toMatchObject({ id: 'u1', telegram_id: '42' });
	});
	it('blocks duplicate 53-bit food replay identities', () => {
		const snapshot = empty();
		const value = {
			source_bot_id: 'bot',
			source_update_id: 9_007_199_254_740_000,
			pet_id: 'pet',
		};
		const report = verifyLegacy(
			snapshot,
			mapped([
				{
					sourceTable: 'pet_food',
					sourceKey: '1',
					targetTable: 'pet_food_entries',
					targetKey: 'a',
					value,
				},
				{
					sourceTable: 'pet_food',
					sourceKey: '2',
					targetTable: 'pet_food_entries',
					targetKey: 'b',
					value,
				},
			]),
			[],
			'dry-run',
			DateTime.makeUnsafe('2026-07-16T00:00:00.000Z'),
		);
		expect(report.blockers).toContainEqual(
			expect.objectContaining({ code: 'source-update-collision' }),
		);
	});
	it('blocks normalized pet, self-caregiver, API hash, and sent-delivery collisions', () => {
		const snapshot = empty() as any;
		snapshot.users = [{ id: 'u', telegram_id: '42' }];
		snapshot.pets = [{ id: 'p', owner_id: 'u' }];
		snapshot.pet_carers = [{ id: 'c', pet_id: 'p', carer_id: 'u' }];
		const report = verifyLegacy(
			snapshot,
			mapped([
				{
					sourceTable: 'pets',
					sourceKey: 'p1',
					targetTable: 'pets',
					targetKey: '1',
					value: { owner_id: 'owner', name_key: 'fido' },
				},
				{
					sourceTable: 'pets',
					sourceKey: 'p2',
					targetTable: 'pets',
					targetKey: '2',
					value: { owner_id: 'owner', name_key: 'fido' },
				},
				{
					sourceTable: 'api_keys',
					sourceKey: 'k1',
					targetTable: 'api_keys',
					targetKey: '1',
					value: { key_hash: 'a'.repeat(64) },
				},
				{
					sourceTable: 'api_keys',
					sourceKey: 'k2',
					targetTable: 'api_keys',
					targetKey: '2',
					value: { key_hash: 'a'.repeat(64) },
				},
				{
					sourceTable: 'notification_history',
					sourceKey: 'h1:delivery',
					targetTable: 'notification_deliveries',
					targetKey: '1',
					value: {
						telegram_bot_id: 'bot',
						recipient_chat_id: 42,
						telegram_message_id: 7,
					},
				},
				{
					sourceTable: 'notification_history',
					sourceKey: 'h2:delivery',
					targetTable: 'notification_deliveries',
					targetKey: '2',
					value: {
						telegram_bot_id: 'bot',
						recipient_chat_id: 42,
						telegram_message_id: 7,
					},
				},
			]),
			[],
			'dry-run',
			DateTime.makeUnsafe('2026-07-16T00:00:00.000Z'),
		);
		expect(report.blockers.map((blocker) => blocker.code)).toEqual(
			expect.arrayContaining([
				'duplicate-normalized-pet-name',
				'self-caregiver',
				'duplicate-api-key-hash',
				'duplicate-delivery-identity',
			]),
		);
	});
	it('skips unknown and invalid known configs with accurate sanitized counts', () => {
		const snapshot = empty() as any;
		snapshot.pets = [{ id: 'p', owner_id: 'u' }];
		snapshot.configs = [
			{
				id: 'invalid',
				context: 'pet:p',
				key: 'dayStart',
				value: '{"hour":0,"timezone":"UTC"}',
			},
			{ id: 'unknown', context: 'pet:p', key: 'other', value: '{}' },
		];
		const report = verifyLegacy(
			snapshot,
			mapped(
				[],
				[
					{
						code: 'unknown-config-key',
						table: 'configs',
						sourceKey: 'unknown',
						message: 'Unsupported legacy configuration is excluded',
					},
				],
			),
			[],
			'dry-run',
			DateTime.makeUnsafe('2026-07-16T00:00:00.000Z'),
		);
		expect(report.blockers).toContainEqual(
			expect.objectContaining({ code: 'invalid-pet-food-config' }),
		);
		expect(report.counts.configs).toMatchObject({
			source: 2,
			accepted: 0,
			skipped: 2,
		});
		expect(countSummary(report)).toBe(
			'Legacy import counts: source=3 accepted=1 skipped=2 existing=0 inserted=0',
		);
	});
	it('rejects unsafe food values and sanitizes at caller boundary', () => {
		expect(() =>
			decodeLegacyRow('pet_food', {
				id: 'f',
				pet_id: 'p',
				user_id: 'u',
				message_id: null,
				quantity: Infinity,
				time: 1,
			}),
		).toThrow('quantity');
		expect(() =>
			decodeLegacyRow('notification_history', {
				id: 'h',
				notification_id: null,
				pet_id: null,
				user_id: 'u',
				message_id: 1.2,
				sent_at: 1,
			}),
		).toThrow('message_id');
	});
});

import { describe, expect, it } from 'vitest';

import {
	decodeLegacyRow,
	legacyTables,
	type LegacySnapshot,
} from '../../src/importer/LegacySchemas.js';
import { verifyLegacy } from '../../src/importer/LegacyVerification.js';
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
		const snapshot = Object.fromEntries(
			legacyTables.map((table) => [table, []]),
		) as unknown as LegacySnapshot;
		const value = {
			source_bot_id: 'bot',
			source_update_id: 9_007_199_254_740_000,
			pet_id: 'pet',
		};
		const report = verifyLegacy(
			snapshot,
			{
				fingerprint: 'sha256:test',
				rounding: [],
				warnings: [],
				rows: [
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
				],
			},
			[],
			'dry-run',
		);
		expect(report.blockers).toContainEqual(
			expect.objectContaining({ code: 'source-update-collision' }),
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

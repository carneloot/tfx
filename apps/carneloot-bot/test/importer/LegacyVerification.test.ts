import { describe, expect, it } from 'vitest';

import { decodeLegacyRow } from '../../src/importer/LegacySchemas.js';
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

import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { DeliveryOutcome } from '../../src/domain/notifications/DeliveryOutcome.js';
import * as RecipientRole from '../../src/domain/notifications/RecipientRole.js';

describe('RecipientRole', () => {
	it('provides standard roles and round-trips unknown valid roles', () => {
		expect([
			RecipientRole.owner,
			RecipientRole.caregiver,
			RecipientRole.subscriber,
		]).toEqual(['owner', 'caregiver', 'subscriber']);
		const custom = Schema.decodeUnknownSync(RecipientRole.RecipientRole)(
			'weekend-helper',
		);
		expect(Schema.encodeSync(RecipientRole.RecipientRole)(custom)).toBe(
			'weekend-helper',
		);
	});
	it('validates safe delivery outcomes', () => {
		expect(
			Schema.decodeUnknownSync(DeliveryOutcome)({
				_tag: 'Unknown',
				error: { code: 'timeout', message: 'Ambiguous transport result' },
			}),
		).toMatchObject({ _tag: 'Unknown' });
		expect(() =>
			Schema.decodeUnknownSync(DeliveryOutcome)({
				_tag: 'Sent',
				telegramBotId: 'carneloot',
				telegramMessageId: 0,
			}),
		).toThrow();
	});
	it.each(['', 'Owner', '-owner', 'owner_', 'owner--backup', 'á'])(
		'rejects %j',
		(value) => {
			expect(() =>
				Schema.decodeUnknownSync(RecipientRole.RecipientRole)(value),
			).toThrow();
		},
	);
});

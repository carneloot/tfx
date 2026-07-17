import { DateTime, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { DeliveryOutcome } from '../../src/domain/notifications/DeliveryOutcome.js';
import { NotificationEvent } from '../../src/domain/notifications/NotificationEvent.js';
import * as RecipientRole from '../../src/domain/notifications/RecipientRole.js';

describe('RecipientRole', () => {
	it('requires explicit notification recipient and food timestamp metadata', () => {
		const event = {
			id: '00000000-0000-4000-8000-000000000001',
			botId: 'carneloot',
			kind: 'feeding-reminder',
			ownerUserId: '00000000-0000-4000-8000-000000000002',
			petId: null,
			foodEntryId: null,
			scheduledFor: DateTime.makeUnsafe(0),
			status: 'scheduled',
			dedupeKey: 'event-key',
			jobId: null,
			recipientsMaterializedAt: null,
			foodTimestampExplicit: false,
			createdAt: DateTime.makeUnsafe(0),
			updatedAt: DateTime.makeUnsafe(0),
			completedAt: null,
			cancelledAt: null,
		};
		expect(Schema.decodeUnknownSync(NotificationEvent)(event)).toMatchObject({
			recipientsMaterializedAt: null,
			foodTimestampExplicit: false,
		});
		const { recipientsMaterializedAt: _, ...missingMarker } = event;
		expect(() =>
			Schema.decodeUnknownSync(NotificationEvent)(missingMarker),
		).toThrow();
		const { foodTimestampExplicit: _foodTimestamp, ...missingTimestampFlag } =
			event;
		expect(() =>
			Schema.decodeUnknownSync(NotificationEvent)(missingTimestampFlag),
		).toThrow();
	});

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
		const retryAt = DateTime.makeUnsafe('2024-01-02T12:00:00Z');
		const failed = Schema.decodeUnknownSync(DeliveryOutcome)({
			_tag: 'Failed',
			error: { message: 'Temporary failure' },
			retryable: true,
			retryAt,
		});
		expect(
			failed._tag === 'Failed' &&
				failed.retryAt !== null &&
				DateTime.Equivalence(failed.retryAt, retryAt),
		).toBe(true);
		expect(() =>
			Schema.decodeUnknownSync(DeliveryOutcome)({
				_tag: 'Failed',
				error: { message: 'Temporary failure' },
				retryable: true,
				retryAt: DateTime.toEpochMillis(retryAt),
			}),
		).toThrow();
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

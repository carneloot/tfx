import { Duration, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { BotId, PetId } from '../../src/domain/Ids.js';
import { EventId } from '../../src/domain/notifications/NotificationEvent.js';
import { FoodEntryId } from '../../src/domain/pet-food/PetFood.js';
import * as FoodAddedNotificationJob from '../../src/jobs/FoodAddedNotificationJob.js';

describe('FoodAddedNotificationJob declaration', () => {
	it('owns versioned payload and bounded retry policy', () => {
		const payload = {
			eventId: Schema.decodeUnknownSync(EventId)(
				'00000000-0000-4000-8000-000000000001',
			),
			botId: Schema.decodeUnknownSync(BotId)('carneloot'),
			petId: Schema.decodeUnknownSync(PetId)(
				'00000000-0000-4000-8000-000000000002',
			),
			foodEntryId: Schema.decodeUnknownSync(FoodEntryId)(
				'00000000-0000-4000-8000-000000000003',
			),
		};
		expect(
			Schema.decodeUnknownSync(FoodAddedNotificationJob.PayloadV1)(payload),
		).toEqual(payload);
		expect(FoodAddedNotificationJob.declaration).toMatchObject({
			name: 'food-added-notification',
			maxAttempts: 8,
		});
		expect(FoodAddedNotificationJob.declaration.payload.latest.version).toBe(1);
		const retryAfter = Duration.seconds(7);
		const retry = FoodAddedNotificationJob.declaration.retry(
			new FoodAddedNotificationJob.FoodAddedNotificationRetryError({
				message: 'transient',
				retryAfter,
			}),
		);
		expect(retry?._tag).toBe('Retry');
		if (retry?._tag === 'Retry')
			expect(Duration.equals(retry.retryAfter!, retryAfter)).toBe(true);
		expect(
			FoodAddedNotificationJob.declaration.retry(
				new FoodAddedNotificationJob.FoodAddedNotificationPermanentError({
					message: 'deleted context',
				}),
			),
		).toEqual({ _tag: 'Permanent' });
		expect(
			Duration.equals(
				FoodAddedNotificationJob.declaration.schedule(8),
				Duration.minutes(30),
			),
		).toBe(true);
	});
});

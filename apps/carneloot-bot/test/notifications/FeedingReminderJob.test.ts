import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { BotId, PetId } from '../../src/domain/Ids.js';
import { EventId } from '../../src/domain/notifications/NotificationEvent.js';
import { FoodEntryId } from '../../src/domain/pet-food/PetFood.js';
import * as FeedingReminderJob from '../../src/jobs/FeedingReminderJob.js';

describe('FeedingReminderJob declaration', () => {
	it('owns a versioned v1 payload and finite retry policy', () => {
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
			Schema.decodeUnknownSync(FeedingReminderJob.PayloadV1)(payload),
		).toEqual(payload);
		expect(FeedingReminderJob.declaration).toMatchObject({
			name: 'feeding-reminder',
			maxAttempts: 8,
		});
		expect(FeedingReminderJob.declaration.payload.latest.version).toBe(1);
		expect(
			FeedingReminderJob.declaration.retry(
				new FeedingReminderJob.FeedingReminderRetryError({
					message: 'later',
					retryAfter: 123,
				}),
			),
		).toEqual({ _tag: 'Retry', retryAfter: 123 });
		expect(
			FeedingReminderJob.declaration.retry(
				new FeedingReminderJob.FeedingReminderPermanentError({
					message: 'stop',
				}),
			),
		).toEqual({ _tag: 'Permanent' });
	});
});

import * as Duration from 'effect/Duration';
import * as Schema from 'effect/Schema';
import * as Job from 'tfx/Job';
import * as VersionedSchema from 'tfx/VersionedSchema';

import { BotId, PetId } from '../domain/Ids.js';
import { EventId } from '../domain/notifications/NotificationEvent.js';
import { FoodEntryId } from '../domain/pet-food/PetFood.js';

export const PayloadV1 = Schema.Struct({
	eventId: EventId,
	botId: BotId,
	petId: PetId,
	foodEntryId: FoodEntryId,
});
export const Payload = VersionedSchema.history(
	VersionedSchema.version(1, PayloadV1),
);
export class FeedingReminderRetryError extends Schema.TaggedErrorClass<FeedingReminderRetryError>()(
	'FeedingReminderRetryError',
	{
		message: Schema.String,
		retryAfter: Schema.optionalKey(Schema.DurationFromMillis),
	},
) {}
export class FeedingReminderPermanentError extends Schema.TaggedErrorClass<FeedingReminderPermanentError>()(
	'FeedingReminderPermanentError',
	{ message: Schema.String },
) {}
export const FeedingReminderError = Schema.Union([
	FeedingReminderRetryError,
	FeedingReminderPermanentError,
]);
export type FeedingReminderError = typeof FeedingReminderError.Type;
export const declaration = Job.make('feeding-reminder', {
	payload: Payload,
	error: FeedingReminderError,
	maxAttempts: 8,
	retry: (error) =>
		error._tag === 'FeedingReminderRetryError'
			? Job.retry(error.retryAfter)
			: Job.permanent,
	schedule: (attempt) =>
		Duration.min(Duration.minutes(30), Duration.minutes(2 ** (attempt - 1))),
});

import { Data } from 'effect';
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
export class FeedingReminderRetryError extends Data.TaggedError(
	'FeedingReminderRetryError',
)<{ readonly message: string; readonly retryAfter?: number }> {}
export class FeedingReminderPermanentError extends Data.TaggedError(
	'FeedingReminderPermanentError',
)<{ readonly message: string }> {}
export type FeedingReminderError =
	| FeedingReminderRetryError
	| FeedingReminderPermanentError;
export const declaration = Job.make('feeding-reminder', {
	payload: Payload,
	error: undefined as unknown as FeedingReminderError,
	maxAttempts: 8,
	retry: (error) =>
		error._tag === 'FeedingReminderRetryError'
			? Job.retry(error.retryAfter)
			: Job.permanent,
	schedule: (attempt) => Math.min(3_600_000, 5_000 * 2 ** (attempt - 1)),
});

import * as Schema from 'effect/Schema';

import { BotId, PetId, UserId } from '../Ids.js';
import { FoodEntryId } from '../pet-food/PetFood.js';
import { Uuid } from '../Uuid.js';

export const EventId = Uuid.pipe(Schema.brand('NotificationEventId'));
export type EventId = typeof EventId.Type;
export const EventStatus = Schema.Literals([
	'scheduled',
	'dispatching',
	'completed',
	'cancelled',
]);
export type EventStatus = typeof EventStatus.Type;
export const NotificationEvent = Schema.Struct({
	id: EventId,
	botId: BotId,
	kind: Schema.NonEmptyString,
	ownerUserId: UserId,
	petId: Schema.NullOr(PetId),
	foodEntryId: Schema.NullOr(FoodEntryId),
	scheduledFor: Schema.NullOr(Schema.DateTimeUtc),
	status: EventStatus,
	dedupeKey: Schema.NonEmptyString,
	jobId: Schema.NullOr(Uuid),
	createdAt: Schema.DateTimeUtc,
	updatedAt: Schema.DateTimeUtc,
	completedAt: Schema.NullOr(Schema.DateTimeUtc),
	cancelledAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type NotificationEvent = typeof NotificationEvent.Type;

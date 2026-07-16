import * as Duration from 'effect/Duration';
import * as Schema from 'effect/Schema';

import { BotId, PetId, TelegramChatId, UserId } from '../Ids.js';
import { FoodAmountMg } from './FoodAmount.js';
import { IanaTimeZone, LocalTime } from './FoodDateTime.js';

const uuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const FoodEntryId = Schema.String.check(
	Schema.isPattern(uuidPattern),
).pipe(Schema.brand('FoodEntryId'));
export type FoodEntryId = typeof FoodEntryId.Type;
export const ReminderDelay = Schema.Duration.check(
	Schema.makeFilter(
		(value) => {
			const millis = Duration.toMillis(value);
			return (
				Number.isSafeInteger(millis) &&
				millis >= 1 &&
				millis <= Duration.toMillis(Duration.days(30))
			);
		},
		{ message: 'Reminder delay must be between 1ms and 30 days' },
	),
).annotate({ identifier: 'ReminderDelay' });
export type ReminderDelay = typeof ReminderDelay.Type;
export const PetFoodSettings = Schema.Struct({
	petId: PetId,
	dayStart: Schema.NullOr(LocalTime),
	timeZone: Schema.NullOr(IanaTimeZone),
	reminderDelay: Schema.NullOr(ReminderDelay),
	createdAt: Schema.DateTimeUtc,
	updatedAt: Schema.DateTimeUtc,
}).check(
	Schema.makeFilter(
		(value) => (value.dayStart === null) === (value.timeZone === null),
		{ message: 'dayStart and timeZone must be set together' },
	),
);
export type PetFoodSettings = typeof PetFoodSettings.Type;
export const PetFoodEntry = Schema.Struct({
	id: FoodEntryId,
	petId: PetId,
	recordedBy: UserId,
	amountMg: FoodAmountMg,
	fedAt: Schema.DateTimeUtc,
	sourceBotId: BotId,
	sourceUpdateId: Schema.Number,
	sourceMessageChatId: Schema.NullOr(TelegramChatId),
	sourceMessageId: Schema.NullOr(Schema.Number),
	createdAt: Schema.DateTimeUtc,
	updatedAt: Schema.DateTimeUtc,
});
export type PetFoodEntry = typeof PetFoodEntry.Type;

import * as Context from 'effect/Context';
import type * as DateTime from 'effect/DateTime';
import type * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

import type { BotId, PetId, UserId } from '../domain/Ids.js';
import type { FoodEntryId } from '../domain/pet-food/PetFood.js';

export class ReminderSchedulerError extends Schema.TaggedErrorClass<ReminderSchedulerError>()(
	'ReminderSchedulerError',
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Unknown),
	},
) {}
export interface ReminderSchedule {
	readonly botId: BotId;
	readonly ownerUserId: UserId;
	readonly petId: PetId;
	readonly foodEntryId: FoodEntryId;
	readonly runAt: DateTime.Utc;
}
export interface ReminderSchedulerService {
	/**
	 * Implementations must use the ambient PgClient transaction and perform
	 * persistence only. External side effects are forbidden before commit.
	 * Plan 10 supplies only a test SQL recorder; Plan 11 supplies durable SQL.
	 */
	readonly replaceForLatest: (
		schedule: ReminderSchedule,
	) => Effect.Effect<void, ReminderSchedulerError>;
	/** Same ambient-transaction, persistence-only contract as replaceForLatest. */
	readonly cancelForPet: (request: {
		readonly botId: BotId;
		readonly petId: PetId;
	}) => Effect.Effect<void, ReminderSchedulerError>;
}
export class ReminderScheduler extends Context.Service<
	ReminderScheduler,
	ReminderSchedulerService
>()('carneloot/ReminderScheduler') {}

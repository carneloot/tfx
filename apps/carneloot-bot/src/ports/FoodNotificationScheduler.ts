import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

import type { BotId, PetId, UserId } from '../domain/Ids.js';
import type { FoodEntryId } from '../domain/pet-food/PetFood.js';

export class FoodNotificationSchedulerError extends Schema.TaggedErrorClass<FoodNotificationSchedulerError>()(
	'FoodNotificationSchedulerError',
	{
		reason: Schema.Literals(['PersistenceFailure', 'InvariantViolation']),
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Unknown),
	},
) {
	get isRetryable(): boolean {
		return this.reason === 'PersistenceFailure';
	}
}

export interface FoodAddedSchedule {
	readonly botId: BotId;
	readonly ownerUserId: UserId;
	readonly actorUserId: UserId;
	readonly petId: PetId;
	readonly foodEntryId: FoodEntryId;
	readonly sourceUpdateId: number;
	readonly timestampExplicit: boolean;
}

export interface FoodNotificationSchedulerService {
	/** Uses caller's ambient PostgreSQL transaction; performs no Telegram I/O. */
	readonly scheduleAdded: (
		schedule: FoodAddedSchedule,
	) => Effect.Effect<void, FoodNotificationSchedulerError>;
}

export class FoodNotificationScheduler extends Context.Service<
	FoodNotificationScheduler,
	FoodNotificationSchedulerService
>()('carneloot/FoodNotificationScheduler') {}

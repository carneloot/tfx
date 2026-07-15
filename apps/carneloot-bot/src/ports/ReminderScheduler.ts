import { Data } from 'effect';
import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';

import type { PetId } from '../domain/Ids.js';
import type { FoodEntryId } from '../domain/pet-food/PetFood.js';

export class ReminderSchedulerError extends Data.TaggedError(
	'ReminderSchedulerError',
)<{ readonly message: string; readonly cause?: unknown }> {}
export interface ReminderSchedule {
	readonly petId: PetId;
	readonly foodEntryId: FoodEntryId;
	readonly runAt: number;
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
	readonly cancelForPet: (
		petId: PetId,
	) => Effect.Effect<void, ReminderSchedulerError>;
}
export class ReminderScheduler extends Context.Service<
	ReminderScheduler,
	ReminderSchedulerService
>()('carneloot/ReminderScheduler') {}

import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';

import type { PetId } from '../domain/Ids.js';
import type { FoodEntryId } from '../domain/pet-food/PetFood.js';

export interface ReminderSchedule {
	readonly petId: PetId;
	readonly foodEntryId: FoodEntryId;
	readonly runAt: number;
}
export interface ReminderSchedulerService {
	readonly replaceForLatest: (
		schedule: ReminderSchedule,
	) => Effect.Effect<void, unknown>;
	readonly cancelForPet: (petId: PetId) => Effect.Effect<void, unknown>;
}
export class ReminderScheduler extends Context.Service<
	ReminderScheduler,
	ReminderSchedulerService
>()('carneloot/ReminderScheduler') {}

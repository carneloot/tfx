import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';

import type { BotId, PetId, UserId } from '../domain/Ids.js';
import type { FoodEntryId } from '../domain/pet-food/PetFood.js';
import { PetFoodRepository } from '../ports/PetFoodRepository.js';
import { ReminderScheduler } from '../ports/ReminderScheduler.js';

export interface LatestSnapshot {
	readonly id: FoodEntryId;
	readonly fedAt: DateTime.Utc;
}

export interface ReconcileFoodReminderRequest {
	readonly botId: BotId;
	readonly ownerUserId: UserId;
	readonly petId: PetId;
	readonly before: LatestSnapshot | undefined;
}

const snapshotsEqual = (
	left: LatestSnapshot | undefined,
	right: LatestSnapshot | undefined,
): boolean =>
	left?.id === right?.id &&
	(left === undefined ||
		(right !== undefined &&
			DateTime.toEpochMillis(left.fedAt) === DateTime.toEpochMillis(right.fedAt)));

/** Reconciles persistence-only scheduling within the caller's ambient transaction. */
export const reconcile = (request: ReconcileFoodReminderRequest) =>
	Effect.gen(function* () {
		const repository = yield* PetFoodRepository;
		const scheduler = yield* ReminderScheduler;
		const latest = yield* repository.latestEntry(request.petId);
		const after =
			latest === undefined ? undefined : { id: latest.id, fedAt: latest.fedAt };

		if (snapshotsEqual(request.before, after)) return;

		const settings = yield* repository.getSettings(request.petId);
		if (latest === undefined || settings?.reminderDelay == null) {
			yield* scheduler.cancelForPet({
				botId: request.botId,
				petId: request.petId,
			});
			return;
		}

		yield* scheduler.replaceForLatest({
			botId: request.botId,
			ownerUserId: request.ownerUserId,
			petId: request.petId,
			foodEntryId: latest.id,
			runAt: DateTime.addDuration(latest.fedAt, settings.reminderDelay),
		});
	});

import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';

import * as DayBoundary from '../domain/pet-food/DayBoundary.js';
import * as FoodCorrectionInput from '../domain/pet-food/FoodCorrectionInput.js';
import * as FoodDateTime from '../domain/pet-food/FoodDateTime.js';
import type { FoodEntryId } from '../domain/pet-food/PetFood.js';
import {
	DuplicateFoodEntry,
	FoodEntryNotFound,
	PetFoodSetupMissing,
} from '../domain/pet-food/PetFoodError.js';
import { PetFoodRepository } from '../ports/PetFoodRepository.js';
import { authorize, type PetFoodAccess } from './PetFoodAccess.js';
import * as ReconcileFoodReminder from './ReconcileFoodReminder.js';

export interface CorrectFoodInput {
	readonly correction: string;
	readonly messageDate: DateTime.Utc;
}

const notFound = () =>
	new FoodEntryNotFound({ message: 'Food entry was not found' });

/** Corrects one current-day entry atomically with reminder reconciliation. */
export const execute = (
	access: PetFoodAccess,
	entryId: FoodEntryId,
	input: CorrectFoodInput,
) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const repository = yield* PetFoodRepository;
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				const authorized = yield* authorize(access);
				const latest = yield* repository.latestEntry(access.petId);
				const before =
					latest === undefined
						? undefined
						: { id: latest.id, fedAt: latest.fedAt };
				const selected = yield* repository.lockEntry(access.petId, entryId);
				if (selected === undefined) return yield* Effect.fail(notFound());

				const settings = yield* repository.getSettings(access.petId);
				if (
					settings === undefined ||
					settings.dayStart === null ||
					settings.timeZone === null
				)
					return yield* Effect.fail(
						new PetFoodSetupMissing({
							message: 'Pet day start is not configured',
						}),
					);
				const now = yield* DateTime.now;
				const window = DayBoundary.current(now, {
					localTime: settings.dayStart,
					timeZone: settings.timeZone,
				});
				const selectedAt = DateTime.toEpochMillis(selected.fedAt);
				if (
					selectedAt < DateTime.toEpochMillis(window.start) ||
					selectedAt >= DateTime.toEpochMillis(window.end)
				)
					return yield* Effect.fail(notFound());

				const correction = yield* FoodCorrectionInput.parse(input.correction);
				const fedAt =
					correction.when === undefined
						? selected.fedAt
						: yield* FoodDateTime.parse(
								correction.when,
								settings.timeZone,
								input.messageDate,
							);
				const duplicate = yield* repository.findBusinessDuplicateExcluding(
					access.petId,
					fedAt,
					selected.id,
				);
				if (duplicate !== undefined)
					return yield* Effect.fail(
						new DuplicateFoodEntry({
							message: 'A food entry already exists within one minute',
						}),
					);
				const updated = yield* repository.updateEntry(
					selected.id,
					correction.amountMg ?? selected.amountMg,
					fedAt,
					now,
				);
				if (updated === undefined) return yield* Effect.fail(notFound());
				yield* ReconcileFoodReminder.reconcile({
					botId: access.botId,
					ownerUserId: authorized.ownerId,
					petId: access.petId,
					before,
				});
				return { entry: updated, timeZone: settings.timeZone };
			}),
		);
	});

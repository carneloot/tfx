import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';

import * as DayBoundary from '../domain/pet-food/DayBoundary.js';
import type { FoodEntryId } from '../domain/pet-food/PetFood.js';
import {
	FoodEntryNotFound,
	PetFoodSetupMissing,
} from '../domain/pet-food/PetFoodError.js';
import { PetFoodRepository } from '../ports/PetFoodRepository.js';
import { authorize, type PetFoodAccess } from './PetFoodAccess.js';
import * as ReconcileFoodReminder from './ReconcileFoodReminder.js';

const notFound = () =>
	new FoodEntryNotFound({ message: 'Food entry was not found' });

/** Deletes one current-day entry atomically with reminder reconciliation. */
export const execute = Effect.fn('DeleteFood.execute')
	((access: PetFoodAccess, entryId: FoodEntryId) =>
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

				const deleted = yield* repository.deleteEntry(selected.id);
				if (deleted === undefined) return yield* Effect.fail(notFound());
				yield* ReconcileFoodReminder.reconcile({
					botId: access.botId,
					ownerUserId: authorized.ownerId,
					petId: access.petId,
					before,
				});
				return deleted;
			}),
		);
	}));

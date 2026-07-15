import * as PgClient from '@effect/sql-pg/PgClient';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';

import type { BotId, TelegramUserId, UserId } from '../domain/Ids.js';
import * as DayBoundary from '../domain/pet-food/DayBoundary.js';
import type { Pet } from '../domain/Pet.js';
import { PetFoodRepository } from '../ports/PetFoodRepository.js';
import { PetRepository } from '../ports/PetRepository.js';
import { authorize } from './PetFoodAccess.js';

export interface Identity {
	readonly ownerId: UserId;
	readonly botId: BotId;
	readonly telegramUserId: TelegramUserId;
}
export type PetFoodStatus =
	| { readonly _tag: 'MissingDayStart'; readonly pet: Pet }
	| {
			readonly _tag: 'Configured';
			readonly pet: Pet;
			readonly totalMg: number;
			readonly latestFedAt: number | null;
			readonly window: DayBoundary.Window;
	  };
export const execute = (identity: Identity) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const pets = yield* PetRepository;
		const food = yield* PetFoodRepository;
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				const owned = yield* pets.listOwned(identity.ownerId);
				const now = yield* Clock.currentTimeMillis;
				return yield* Effect.forEach(owned, (pet) =>
					Effect.gen(function* () {
						yield* authorize({ ...identity, petId: pet.id });
						const settings = yield* food.getSettings(pet.id);
						if (
							settings === undefined ||
							settings.dayStart === null ||
							settings.timeZone === null
						)
							return { _tag: 'MissingDayStart' as const, pet };
						const window = DayBoundary.current(now, {
							localTime: settings.dayStart,
							timeZone: settings.timeZone,
						});
						const summary = yield* food.status(
							pet.id,
							window.start,
							window.end,
						);
						return {
							_tag: 'Configured' as const,
							pet,
							...summary,
							window,
						};
					}),
				);
			}),
		);
	});

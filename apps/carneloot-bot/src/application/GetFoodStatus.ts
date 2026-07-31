import * as PgClient from '@effect/sql-pg/PgClient';
import * as Data from 'effect/Data';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';

import type { BotId, TelegramUserId, UserId } from '../domain/Ids.js';
import * as DayBoundary from '../domain/pet-food/DayBoundary.js';
import type { Pet } from '../domain/Pet.js';
import { PetFoodRepository } from '../ports/PetFoodRepository.js';
import * as ListPets from './ListPets.js';
import { authorize } from './PetFoodAccess.js';

export interface Identity {
	readonly actorId: UserId;
	readonly botId: BotId;
	readonly telegramUserId: TelegramUserId;
}
export type PetFoodStatus = Data.TaggedEnum<{
	readonly MissingDayStart: { readonly pet: Pet };
	readonly Configured: {
		readonly pet: Pet;
		readonly totalMg: number;
		readonly latestFedAt: DateTime.Utc | null;
		readonly window: DayBoundary.Window;
	};
}>;
const PetFoodStatus = Data.taggedEnum<PetFoodStatus>();
export const execute = Effect.fn('GetFoodStatus.execute')(
	(identity: Identity) =>
		Effect.gen(function* () {
			const sql = yield* PgClient.PgClient;
			const food = yield* PetFoodRepository;
			return yield* sql.withTransaction(
				Effect.gen(function* () {
					const accessible = yield* ListPets.execute(identity.actorId);
					for (const { pet } of accessible)
						yield* authorize({ ...identity, petId: pet.id });
					const [now, settings] = yield* Effect.all([
						DateTime.now,
						Effect.forEach(accessible, ({ pet }) => food.getSettings(pet.id), {
							concurrency: 'unbounded',
						}),
					]);
					return yield* Effect.forEach(accessible, ({ pet }, index) =>
						Effect.gen(function* () {
							const setting = settings[index];
							if (
								setting === undefined ||
								setting.dayStart === null ||
								setting.timeZone === null
							)
								return PetFoodStatus.MissingDayStart({ pet });
							const window = DayBoundary.current(now, {
								localTime: setting.dayStart,
								timeZone: setting.timeZone,
							});
							const summary = yield* food.status(
								pet.id,
								window.start,
								window.end,
							);
							return PetFoodStatus.Configured({
								pet,
								...summary,
								window,
							});
						}),
					);
				}),
			);
		}),
);

import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';

import type { BotId } from '../domain/Ids.js';
import type { IanaTimeZone } from '../domain/pet-food/FoodDateTime.js';
import type { PetFoodEntry } from '../domain/pet-food/PetFood.js';
import { UserRepository } from '../ports/UserRepository.js';
import { displayName } from './CaregiverAccess.js';

export interface DisplayFoodEntry {
	readonly entry: PetFoodEntry;
	readonly actorDisplay: string;
	readonly localTimestamp: string;
}

const twoDigits = (value: number) => String(value).padStart(2, '0');
const formatLocalTimestamp = (
	instant: DateTime.Utc,
	timeZone: IanaTimeZone,
): string => {
	const parts = DateTime.toParts(
		DateTime.makeZonedUnsafe(instant, { timeZone }),
	);
	return `${twoDigits(parts.day)}/${twoDigits(parts.month)}/${parts.year} ${twoDigits(parts.hour)}:${twoDigits(parts.minute)}`;
};

/** Enriches current-day entries for display without exposing Telegram profiles. */
export const execute = Effect.fn('ListCurrentFoodEntries.execute')
	((
	botId: BotId,
	timeZone: IanaTimeZone,
	entries: ReadonlyArray<PetFoodEntry>,
) =>
	Effect.gen(function* () {
		const users = yield* UserRepository;
		const ordered = [...entries].sort((left, right) => {
			const byTime =
				DateTime.toEpochMillis(right.fedAt) -
				DateTime.toEpochMillis(left.fedAt);
			if (byTime !== 0) return byTime;
			return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
		});
		const actorIds = [...new Set(ordered.map((entry) => entry.recordedBy))];
		const actors = yield* Effect.forEach(actorIds, (actorId) =>
			users.findById(botId, actorId),
		);
		const actorsById = new Map(
			actors.map((actor) => [actor.user.id, actor] as const),
		);
		return yield* Effect.forEach(ordered, (entry) =>
			Effect.gen(function* () {
				const actor = actorsById.get(entry.recordedBy);
				if (actor === undefined)
					return yield* Effect.die(
						new Error('Food entry actor lookup missing'),
					);
				return {
					entry,
					actorDisplay: displayName(actor),
					localTimestamp: formatLocalTimestamp(entry.fedAt, timeZone),
				};
			}),
		);
	}));

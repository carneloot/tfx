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
export const execute = (
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
		return yield* Effect.forEach(ordered, (entry) =>
			Effect.map(users.findById(botId, entry.recordedBy), (actor) => ({
				entry,
				actorDisplay: displayName(actor),
				localTimestamp: formatLocalTimestamp(entry.fedAt, timeZone),
			})),
		);
	});

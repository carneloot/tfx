import * as Context from 'effect/Context';
import type * as DateTime from 'effect/DateTime';
import type * as Effect from 'effect/Effect';

import type { DomainPersistenceError } from '../domain/DomainError.js';
import type { BotId, PetId, TelegramChatId, UserId } from '../domain/Ids.js';
import type { FoodAmount } from '../domain/pet-food/FoodAmount.js';
import type {
	IanaTimeZone,
	LocalTime,
} from '../domain/pet-food/FoodDateTime.js';
import type {
	FoodEntryId,
	PetFoodEntry,
	PetFoodSettings,
	ReminderDelay,
} from '../domain/pet-food/PetFood.js';
import type { PetAccessDenied } from '../domain/pet-food/PetFoodError.js';
import type { Pet } from '../domain/Pet.js';

export interface FoodSource {
	readonly botId: BotId;
	readonly updateId: number;
	readonly messageChatId: TelegramChatId | null;
	readonly messageId: number | null;
}
export interface NewFoodEntry {
	readonly id: FoodEntryId;
	readonly petId: PetId;
	readonly recordedBy: UserId;
	readonly amountMg: FoodAmount;
	readonly fedAt: DateTime.Utc;
	readonly source: FoodSource;
	readonly now: DateTime.Utc;
}
export interface FoodStatusSummary {
	readonly totalMg: number;
	readonly latestFedAt: DateTime.Utc | null;
}
export type PetFoodRepositoryError = DomainPersistenceError | PetAccessDenied;
export interface PetFoodRepositoryService {
	readonly lockOwnedPet: (
		ownerId: UserId,
		petId: PetId,
	) => Effect.Effect<Pet, PetFoodRepositoryError>;
	readonly getSettings: (
		petId: PetId,
	) => Effect.Effect<PetFoodSettings | undefined, PetFoodRepositoryError>;
	readonly setDayStart: (
		petId: PetId,
		dayStart: LocalTime,
		timeZone: IanaTimeZone,
		now: DateTime.Utc,
	) => Effect.Effect<PetFoodSettings, PetFoodRepositoryError>;
	readonly setReminderDelay: (
		petId: PetId,
		delay: ReminderDelay,
		now: DateTime.Utc,
	) => Effect.Effect<PetFoodSettings, PetFoodRepositoryError>;
	readonly clearReminderDelay: (
		petId: PetId,
		now: DateTime.Utc,
	) => Effect.Effect<PetFoodSettings, PetFoodRepositoryError>;
	readonly latestEntry: (
		petId: PetId,
	) => Effect.Effect<PetFoodEntry | undefined, PetFoodRepositoryError>;
	readonly listEntries: (
		petId: PetId,
		start: DateTime.Utc,
		end: DateTime.Utc,
	) => Effect.Effect<ReadonlyArray<PetFoodEntry>, PetFoodRepositoryError>;
	readonly lockEntry: (
		petId: PetId,
		entryId: FoodEntryId,
	) => Effect.Effect<PetFoodEntry | undefined, PetFoodRepositoryError>;
	readonly lockAccessibleBySourceMessage: (
		actorId: UserId,
		botId: BotId,
		chatId: TelegramChatId,
		messageId: number,
	) => Effect.Effect<ReadonlyArray<PetFoodEntry>, PetFoodRepositoryError>;
	readonly findBySource: (
		petId: PetId,
		botId: BotId,
		updateId: number,
	) => Effect.Effect<PetFoodEntry | undefined, PetFoodRepositoryError>;
	readonly findBusinessDuplicate: (
		petId: PetId,
		fedAt: DateTime.Utc,
	) => Effect.Effect<PetFoodEntry | undefined, PetFoodRepositoryError>;
	readonly findBusinessDuplicateExcluding: (
		petId: PetId,
		fedAt: DateTime.Utc,
		excludedEntryId: FoodEntryId,
	) => Effect.Effect<PetFoodEntry | undefined, PetFoodRepositoryError>;
	readonly insert: (
		entry: NewFoodEntry,
	) => Effect.Effect<PetFoodEntry, PetFoodRepositoryError>;
	readonly updateEntry: (
		entryId: FoodEntryId,
		amountMg: FoodAmount,
		fedAt: DateTime.Utc,
		now: DateTime.Utc,
	) => Effect.Effect<PetFoodEntry | undefined, PetFoodRepositoryError>;
	readonly deleteEntry: (
		entryId: FoodEntryId,
	) => Effect.Effect<PetFoodEntry | undefined, PetFoodRepositoryError>;
	readonly status: (
		petId: PetId,
		start: DateTime.Utc,
		end: DateTime.Utc,
	) => Effect.Effect<FoodStatusSummary, PetFoodRepositoryError>;
}
export class PetFoodRepository extends Context.Service<
	PetFoodRepository,
	PetFoodRepositoryService
>()('carneloot/PetFoodRepository') {}

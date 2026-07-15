import * as Context from 'effect/Context';
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
	ReminderDelayMs,
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
	readonly fedAt: number;
	readonly source: FoodSource;
	readonly now: number;
}
export interface FoodStatusSummary {
	readonly totalMg: number;
	readonly latestFedAt: number | null;
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
		now: number,
	) => Effect.Effect<PetFoodSettings, PetFoodRepositoryError>;
	readonly setReminderDelay: (
		petId: PetId,
		delay: ReminderDelayMs,
		now: number,
	) => Effect.Effect<PetFoodSettings, PetFoodRepositoryError>;
	readonly clearReminderDelay: (
		petId: PetId,
		now: number,
	) => Effect.Effect<PetFoodSettings, PetFoodRepositoryError>;
	readonly latestEntry: (
		petId: PetId,
	) => Effect.Effect<PetFoodEntry | undefined, PetFoodRepositoryError>;
	readonly findBySource: (
		petId: PetId,
		botId: BotId,
		updateId: number,
	) => Effect.Effect<PetFoodEntry | undefined, PetFoodRepositoryError>;
	readonly findBusinessDuplicate: (
		petId: PetId,
		fedAt: number,
	) => Effect.Effect<PetFoodEntry | undefined, PetFoodRepositoryError>;
	readonly insert: (
		entry: NewFoodEntry,
	) => Effect.Effect<PetFoodEntry, PetFoodRepositoryError>;
	readonly status: (
		petId: PetId,
		start: number,
		end: number,
	) => Effect.Effect<FoodStatusSummary, PetFoodRepositoryError>;
}
export class PetFoodRepository extends Context.Service<
	PetFoodRepository,
	PetFoodRepositoryService
>()('carneloot/PetFoodRepository') {}

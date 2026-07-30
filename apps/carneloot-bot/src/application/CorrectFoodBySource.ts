import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';

import type {
	BotId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../domain/Ids.js';
import * as FoodCorrectionInput from '../domain/pet-food/FoodCorrectionInput.js';
import * as FoodDateTime from '../domain/pet-food/FoodDateTime.js';
import type { PetFoodEntry } from '../domain/pet-food/PetFood.js';
import {
	DuplicateFoodEntry,
	PetFoodSetupMissing,
} from '../domain/pet-food/PetFoodError.js';
import { PetFoodRepository } from '../ports/PetFoodRepository.js';
import { authorize } from './PetFoodAccess.js';
import * as ReconcileFoodReminder from './ReconcileFoodReminder.js';

export interface CorrectFoodBySourceInput {
	readonly actorId: UserId;
	readonly botId: BotId;
	readonly telegramUserId: TelegramUserId;
	readonly chatId: TelegramChatId;
	readonly repliedMessageId: number;
	readonly correction: string;
	readonly messageDate: DateTime.Utc;
}

export type CorrectFoodBySourceResult =
	| { readonly _tag: 'Unrelated' }
	| {
			readonly _tag: 'Corrected';
			readonly entries: ReadonlyArray<PetFoodEntry>;
	  };

/** Corrects every currently accessible entry correlated to one exact Telegram message. */
export const execute = Effect.fn('CorrectFoodBySource.execute')(
	(input: CorrectFoodBySourceInput) =>
		Effect.gen(function* () {
			const sql = yield* PgClient.PgClient;
			const repository = yield* PetFoodRepository;
			return yield* sql.withTransaction(
				Effect.gen(function* () {
					const selected = yield* repository.lockAccessibleBySourceMessage(
						input.actorId,
						input.botId,
						input.chatId,
						input.repliedMessageId,
					);
					if (selected.length === 0) return { _tag: 'Unrelated' } as const;
					const correction = yield* FoodCorrectionInput.parse(input.correction);

					const pets = new Map<
						string,
						{
							readonly petId: PetFoodEntry['petId'];
							readonly ownerId: UserId;
							readonly before:
								| {
										readonly id: PetFoodEntry['id'];
										readonly fedAt: DateTime.Utc;
								  }
								| undefined;
						}
					>();
					for (const entry of selected) {
						if (pets.has(entry.petId)) continue;
						const authorized = yield* authorize({
							actorId: input.actorId,
							botId: input.botId,
							telegramUserId: input.telegramUserId,
							petId: entry.petId,
						});
						const latest = yield* repository.latestEntry(entry.petId);
						pets.set(entry.petId, {
							petId: entry.petId,
							ownerId: authorized.ownerId,
							before:
								latest === undefined
									? undefined
									: { id: latest.id, fedAt: latest.fedAt },
						});
					}

					const now = yield* DateTime.now;
					const updated: Array<PetFoodEntry> = [];
					for (const entry of selected) {
						const settings = yield* repository.getSettings(entry.petId);
						if (settings?.timeZone == null)
							return yield* Effect.fail(
								new PetFoodSetupMissing({
									message: 'Pet time zone is not configured',
								}),
							);
						const fedAt =
							correction.when === undefined
								? entry.fedAt
								: yield* FoodDateTime.parse(
										correction.when,
										settings.timeZone,
										input.messageDate,
									);
						const duplicate = yield* repository.findBusinessDuplicateExcluding(
							entry.petId,
							fedAt,
							entry.id,
						);
						if (duplicate !== undefined)
							return yield* Effect.fail(
								new DuplicateFoodEntry({
									message: 'A food entry already exists within one minute',
								}),
							);
						const value = yield* repository.updateEntry(
							entry.id,
							correction.amountMg ?? entry.amountMg,
							fedAt,
							now,
						);
						if (value === undefined)
							return yield* Effect.die('Locked food entry disappeared');
						updated.push(value);
					}

					for (const pet of pets.values()) {
						yield* ReconcileFoodReminder.reconcile({
							botId: input.botId,
							ownerUserId: pet.ownerId,
							petId: pet.petId,
							before: pet.before,
						});
					}
					return { _tag: 'Corrected', entries: updated } as const;
				}),
			);
		}),
);

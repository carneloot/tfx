import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';

import type { BotId, PetId, TelegramUserId, UserId } from '../domain/Ids.js';
import { PetAccessDenied } from '../domain/pet-food/PetFoodError.js';
import { PetRepository } from '../ports/PetRepository.js';
import { ReminderScheduler } from '../ports/ReminderScheduler.js';
import { UserRepository } from '../ports/UserRepository.js';

export interface Actor {
	readonly actorId: UserId;
	readonly botId: BotId;
	readonly telegramUserId: TelegramUserId;
}

const denied = () => new PetAccessDenied({ message: 'Pet is not owned by actor' });

export const execute = (actor: Actor, petId: PetId) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const users = yield* UserRepository;
		const pets = yield* PetRepository;
		const reminders = yield* ReminderScheduler;

		return yield* sql.withTransaction(
			Effect.gen(function* () {
				const current = yield* users.findByTelegram(
					actor.botId,
					actor.telegramUserId,
				);
				if (current.user.id !== actor.actorId) return yield* Effect.fail(denied());

				const pet = yield* pets.lockById(petId);
				if (pet === undefined || pet.ownerId !== actor.actorId)
					return yield* Effect.fail(denied());

				yield* reminders.cancelForPet({ botId: actor.botId, petId });
				const deleted = yield* pets.deleteOwned(actor.actorId, petId);
				if (!deleted) return yield* Effect.fail(denied());

				yield* Effect.logInfo('carneloot.pet.deleted').pipe(
					Effect.annotateLogs({ ownerId: actor.actorId, petId }),
				);
				return pet;
			}),
		);
	});

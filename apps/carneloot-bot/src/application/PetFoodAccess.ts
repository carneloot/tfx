import * as Effect from 'effect/Effect';

import type { BotId, PetId, TelegramUserId, UserId } from '../domain/Ids.js';
import { PetAccessDenied } from '../domain/pet-food/PetFoodError.js';
import type { Pet } from '../domain/Pet.js';
import { PetCaregiverRepository } from '../ports/PetCaregiverRepository.js';
import { PetRepository } from '../ports/PetRepository.js';
import { UserRepository } from '../ports/UserRepository.js';

export interface PetFoodAccess {
	readonly actorId: UserId;
	readonly botId: BotId;
	readonly telegramUserId: TelegramUserId;
	readonly petId: PetId;
}
export interface AuthorizedPetFoodAccess {
	readonly actorId: UserId;
	readonly ownerId: UserId;
	readonly pet: Pet;
	readonly role: 'owner' | 'caregiver';
}

const denied = (message: string) => new PetAccessDenied({ message });

export const authorize = (access: PetFoodAccess) =>
	Effect.gen(function* () {
		const users = yield* UserRepository;
		const current = yield* users.findByTelegram(
			access.botId,
			access.telegramUserId,
		);
		if (current.user.id !== access.actorId)
			return yield* Effect.fail(
				denied('Telegram identity no longer matches actor'),
			);

		const pet = yield* (yield* PetRepository).lockById(access.petId);
		if (pet === undefined)
			return yield* Effect.fail(denied('Pet is not accessible'));
		if (pet.ownerId === access.actorId)
			return {
				actorId: access.actorId,
				ownerId: pet.ownerId,
				pet,
				role: 'owner',
			};

		const relationship = yield* (yield* PetCaregiverRepository).lock(
			access.petId,
			access.actorId,
		);
		if (relationship?.status !== 'accepted')
			return yield* Effect.fail(denied('Pet is not accessible'));
		return {
			actorId: access.actorId,
			ownerId: pet.ownerId,
			pet,
			role: 'caregiver',
		};
	});

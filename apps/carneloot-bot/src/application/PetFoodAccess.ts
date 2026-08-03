import * as Effect from 'effect/Effect';

import { CurrentUser } from '../bot/CurrentUser.js';
import type { BotId, PetId, TelegramUserId, UserId } from '../domain/Ids.js';
import { PetAccessDenied } from '../domain/pet-food/PetFoodError.js';
import type { Pet } from '../domain/Pet.js';
import { PetCaregiverRepository } from '../ports/PetCaregiverRepository.js';
import { PetRepository } from '../ports/PetRepository.js';

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

export const authorize = Effect.fn('PetFoodAccess.authorize')(
	(access: PetFoodAccess) =>
		Effect.gen(function* () {
			const current = yield* CurrentUser;
			if (current.user.id !== access.actorId)
				return yield* Effect.fail(
					denied('Telegram identity no longer matches actor'),
				);

			const pets = yield* PetRepository;
			const pet = yield* pets.lockById(access.petId);
			if (pet === undefined)
				return yield* Effect.fail(denied('Pet is not accessible'));
			if (pet.ownerId === access.actorId)
				return {
					actorId: access.actorId,
					ownerId: pet.ownerId,
					pet,
					role: 'owner',
				};

			const caregivers = yield* PetCaregiverRepository;
			const relationship = yield* caregivers.lock(access.petId, access.actorId);
			if (relationship?.status !== 'accepted')
				return yield* Effect.fail(denied('Pet is not accessible'));
			return {
				actorId: access.actorId,
				ownerId: pet.ownerId,
				pet,
				role: 'caregiver',
			};
		}),
);

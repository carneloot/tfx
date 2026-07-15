import * as Effect from 'effect/Effect';

import type { BotId, PetId, TelegramUserId, UserId } from '../domain/Ids.js';
import { PetAccessDenied } from '../domain/pet-food/PetFoodError.js';
import { PetFoodRepository } from '../ports/PetFoodRepository.js';
import { UserRepository } from '../ports/UserRepository.js';

export interface PetFoodAccess {
	readonly ownerId: UserId;
	readonly botId: BotId;
	readonly telegramUserId: TelegramUserId;
	readonly petId: PetId;
}
export const authorize = (access: PetFoodAccess) =>
	Effect.gen(function* () {
		const users = yield* UserRepository;
		const current = yield* users.findByTelegram(
			access.botId,
			access.telegramUserId,
		);
		if (current.user.id !== access.ownerId)
			return yield* Effect.fail(
				new PetAccessDenied({
					message: 'Telegram identity no longer owns user',
				}),
			);
		const repository = yield* PetFoodRepository;
		return yield* repository.lockOwnedPet(access.ownerId, access.petId);
	});

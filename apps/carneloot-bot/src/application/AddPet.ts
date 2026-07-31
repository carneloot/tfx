import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

import { CurrentUser } from '../bot/CurrentUser.js';
import {
	InvalidDomainInput,
	UserNotRegistered,
} from '../domain/DomainError.js';
import type { BotId, TelegramUserId, UserId } from '../domain/Ids.js';
import { PetName } from '../domain/Pet.js';
import { PetRepository } from '../ports/PetRepository.js';

export interface Request {
	readonly ownerId: UserId;
	readonly botId: BotId;
	readonly telegramUserId: TelegramUserId;
	readonly name: unknown;
}
export const execute = Effect.fn('AddPet.execute')((request: Request) =>
	Effect.gen(function* () {
		const name = yield* Schema.decodeUnknownEffect(PetName)(request.name).pipe(
			Effect.mapError(
				(cause) =>
					new InvalidDomainInput({ message: 'Invalid pet name', cause }),
			),
		);
		const current = yield* CurrentUser;
		if (current.user.id !== request.ownerId)
			return yield* Effect.fail(
				new UserNotRegistered({
					message: 'Telegram identity no longer owns this conversation',
				}),
			);
		const pets = yield* PetRepository;
		const pet = yield* pets.addOwned(request.ownerId, name);
		yield* Effect.logInfo('carneloot.pet.added').pipe(
			Effect.annotateLogs({ ownerId: pet.ownerId, petId: pet.id }),
		);
		return pet;
	}),
);

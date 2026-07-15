import { Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import * as AddPet from '../src/application/AddPet.js';
import * as ListPets from '../src/application/ListPets.js';
import {
	PetNameAlreadyExists,
	UserNotRegistered,
} from '../src/domain/DomainError.js';
import {
	BotId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../src/domain/Ids.js';
import { PetRepository } from '../src/ports/PetRepository.js';
import { UserRepository } from '../src/ports/UserRepository.js';
const ownerId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000001',
);
const otherId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000003',
);
const botId = Schema.decodeUnknownSync(BotId)('carneloot');
const telegramUserId = Schema.decodeUnknownSync(TelegramUserId)(42);
const profile = {
	botId,
	telegramUserId,
	username: null,
	firstName: 'Ana',
	lastName: null,
	privateChatId: Schema.decodeUnknownSync(TelegramChatId)(42),
};
let insertions = 0;
const pets = Layer.succeed(PetRepository, {
	findById: () => Effect.die('unused'),
	addOwned: (_ownerId, name) => {
		insertions++;
		return name === 'Rex'
			? Effect.succeed({
					id: '00000000-0000-4000-8000-000000000002' as never,
					ownerId,
					name,
					createdAt: 0,
					updatedAt: 0,
				})
			: Effect.fail(new PetNameAlreadyExists({ message: 'duplicate' }));
	},
	listOwned: () => Effect.succeed([]),
});
const users = (id = ownerId) =>
	Layer.succeed(UserRepository, {
		registerTelegramProfile: () => Effect.die('unused'),
		findByTelegram: () =>
			Effect.succeed({ user: { id, createdAt: 0, updatedAt: 0 }, profile }),
	});
const request = { ownerId, botId, telegramUserId, name: ' Rex ' };
describe('pet application services', () => {
	it('revalidates identity and normalizes before insertion', async () => {
		const pet = await Effect.runPromise(
			Effect.provide(AddPet.execute(request), Layer.merge(pets, users())),
		);
		expect(pet.name).toBe('Rex');
	});
	it('rejects removed or remapped identities without insertion', async () => {
		insertions = 0;
		const removed = Layer.succeed(UserRepository, {
			registerTelegramProfile: () => Effect.die('unused'),
			findByTelegram: () =>
				Effect.fail(new UserNotRegistered({ message: 'removed' })),
		});
		for (const identity of [removed, users(otherId)]) {
			const result = await Effect.runPromiseExit(
				Effect.provide(AddPet.execute(request), Layer.merge(pets, identity)),
			);
			expect(result).toMatchObject({ _tag: 'Failure' });
		}
		expect(insertions).toBe(0);
	});
	it('returns empty owned projections', async () => {
		expect(
			await Effect.runPromise(Effect.provide(ListPets.execute(ownerId), pets)),
		).toEqual([]);
	});
});

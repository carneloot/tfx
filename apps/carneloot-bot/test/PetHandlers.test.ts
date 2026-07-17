import { Effect, Layer, Schema } from 'effect';
import * as DateTime from 'effect/DateTime';
import { MessageContext, type MessageContextService } from 'tfx/MessageContext';
import { describe, expect, it } from 'vitest';

import { CurrentUser } from '../src/bot/CurrentUser.js';
import { listPets } from '../src/bot/PetHandlers.js';
import {
	BotId,
	PetId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../src/domain/Ids.js';
import { PetName } from '../src/domain/Pet.js';
import { PetRepository } from '../src/ports/PetRepository.js';
const ownerId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000001',
);
const profile = {
	botId: Schema.decodeUnknownSync(BotId)('carneloot'),
	telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(42),
	username: null,
	firstName: 'Ana',
	lastName: null,
	privateChatId: Schema.decodeUnknownSync(TelegramChatId)(42),
};
const current = {
	user: {
		id: ownerId,
		createdAt: DateTime.makeUnsafe(0),
		updatedAt: DateTime.makeUnsafe(0),
	},
	profile,
};
const run = async (
	items: ReadonlyArray<{ readonly name: string; readonly caregiver?: boolean }>,
) => {
	const replies: Array<string> = [];
	const pets = items.map(({ name, caregiver }, index) => ({
		id: Schema.decodeUnknownSync(PetId)(
			`00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
		),
		ownerId: caregiver
			? Schema.decodeUnknownSync(UserId)('00000000-0000-4000-8000-000000000099')
			: ownerId,
		name: Schema.decodeUnknownSync(PetName)(name),
		nameKey: name.toLocaleLowerCase('pt-BR'),
		createdAt: DateTime.makeUnsafe(0),
		updatedAt: DateTime.makeUnsafe(0),
	}));
	const context = {
		reply: (text: string) =>
			Effect.sync(() => {
				replies.push(text);
				return {} as never;
			}),
	} as unknown as MessageContextService;
	const effect = listPets.pipe(
		Effect.provideService(CurrentUser, current),
		Effect.provideService(MessageContext, context),
		Effect.provide(
			Layer.succeed(PetRepository, {
				findById: () => Effect.die('unused'),
				lockById: () => Effect.die('unused'),
				deleteOwned: () => Effect.die('unused'),
				addOwned: () => Effect.die('unused'),
				listOwned: () => Effect.succeed(pets),
				listAccessible: () => Effect.succeed(pets),
			}),
		),
	) as Effect.Effect<void, unknown>;
	await Effect.runPromise(effect);
	return replies;
};
describe('pet list handler', () => {
	it('uses exact empty text', async () => {
		expect(await run([])).toEqual(['Você não tem pets']);
	});
	it('sorts accessible pets and marks only caregiver projections', async () => {
		expect(
			await run([{ name: 'Rex', caregiver: true }, { name: 'Bidu' }]),
		).toEqual(['1. Bidu\n2. Rex (cuidando)']);
	});
});

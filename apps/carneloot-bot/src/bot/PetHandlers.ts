import * as Effect from 'effect/Effect';
import { Conversations, MessageContext, UpdateContext } from 'tfx';
import { ConversationScopeUnavailable } from 'tfx/Conversations';

import * as ListPets from '../application/ListPets.js';
import * as AddPetConversation from './AddPetConversation.js';
import { CurrentUser } from './CurrentUser.js';
import { botId } from './Declaration.js';

export const startAddPet = Effect.gen(function* () {
	const current = yield* CurrentUser;
	const update = yield* UpdateContext.UpdateContext;
	if (update.chatId === undefined || update.userId === undefined)
		return yield* Effect.fail(
			new ConversationScopeUnavailable('Missing conversation scope'),
		);
	const conversations = yield* Conversations.Conversations;
	yield* conversations.start(
		AddPetConversation.built,
		{
			ownerId: current.user.id,
			botId: current.profile.botId,
			telegramUserId: current.profile.telegramUserId,
		},
		{
			scope: { botId, chatId: update.chatId, userId: update.userId },
		},
	);
});
export const listPets = Effect.gen(function* () {
	const current = yield* CurrentUser;
	const pets = yield* ListPets.execute(current.user.id);
	const context = yield* MessageContext.MessageContext;
	yield* context.reply(
		pets.length === 0
			? 'Você não tem pets'
			: pets.map((pet, index) => `${index + 1}. ${pet.name}`).join('\n'),
	);
});

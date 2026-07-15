import * as Effect from 'effect/Effect';
import { Conversations, MessageContext, UpdateContext } from 'tfx';
import { ConversationScopeUnavailable } from 'tfx/Conversations';

import * as ListPets from '../application/ListPets.js';
import type { Pet } from '../domain/Pet.js';
import type { RegisteredUser } from '../domain/User.js';
import * as ConfigureDayStartConversation from './conversations/ConfigureDayStartConversation.js';
import * as ConfigureReminderDelayConversation from './conversations/ConfigureReminderDelayConversation.js';
import { CurrentUser } from './CurrentUser.js';
import { botId } from './Declaration.js';

const input = (current: RegisteredUser, pets: ReadonlyArray<Pet>) => ({
	ownerId: current.user.id,
	botId: current.profile.botId,
	telegramUserId: current.profile.telegramUserId,
	pets: pets.map(({ id, name }) => ({ id, name })),
});

const start = (
	built:
		| typeof ConfigureDayStartConversation.built
		| typeof ConfigureReminderDelayConversation.built,
) =>
	Effect.gen(function* () {
		const current = yield* CurrentUser;
		const pets = yield* ListPets.execute(current.user.id);
		const context = yield* MessageContext.MessageContext;
		if (pets.length === 0) {
			yield* context.reply('Você não tem pets');
			return;
		}
		const update = yield* UpdateContext.UpdateContext;
		if (update.chatId === undefined || update.userId === undefined)
			return yield* Effect.fail(
				new ConversationScopeUnavailable('Missing conversation scope'),
			);
		const conversations = yield* Conversations.Conversations;
		yield* conversations.start(built as never, input(current, pets), {
			scope: { botId, chatId: update.chatId, userId: update.userId },
			conflict: 'replace',
		});
	});

export const startConfigureDayStart = start(
	ConfigureDayStartConversation.built,
);
export const startConfigureReminderDelay = start(
	ConfigureReminderDelayConversation.built,
);

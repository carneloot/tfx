import * as Effect from 'effect/Effect';
import {
	ConversationPrompt,
	Conversations,
	MessageContext,
	UpdateContext,
} from 'tfx';
import { ConversationScopeUnavailable } from 'tfx/Conversations';

import { botId } from './Declaration.js';

export const cancelCurrent = Effect.gen(function* () {
	const update = yield* UpdateContext.UpdateContext;
	if (update.chatId === undefined || update.userId === undefined)
		return yield* Effect.fail(
			new ConversationScopeUnavailable({
				message: 'Missing conversation scope',
			}),
		);
	const conversations = yield* Conversations.Conversations;
	const cancelled = yield* conversations.cancelCurrent({
		botId,
		chatId: update.chatId,
		userId: update.userId,
	});
	if (cancelled) {
		const context = yield* MessageContext.MessageContext;
		yield* context.reply('Conversa cancelada.', {
			reply_markup: ConversationPrompt.removeReplyKeyboard,
		});
	}
	return cancelled;
});

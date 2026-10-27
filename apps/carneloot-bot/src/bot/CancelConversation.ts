import * as Effect from 'effect/Effect';
import {
	ConversationPrompt,
	Conversations,
	MessageContext,
	UpdateContext,
} from 'tfx';

import { ConversationOperationError } from '../domain/ApplicationError.js';
import { botId } from './Declaration.js';

export const cancelCurrent = Effect.gen(function* () {
	const update = yield* UpdateContext.UpdateContext;
	const conversations = yield* Conversations.Conversations;
	const cancelled =
		update.chatId === undefined || update.userId === undefined
			? false
			: yield* conversations
					.cancelCurrent({
						botId,
						chatId: update.chatId,
						userId: update.userId,
					})
					.pipe(
						Effect.mapError(
							(cause) =>
								new ConversationOperationError({
									message: 'Could not cancel conversation',
									cause,
								}),
						),
					);
	const context = yield* MessageContext.MessageContext;
	yield* context.reply('Operação cancelada', {
		reply_markup: ConversationPrompt.removeReplyKeyboard,
	});
	return cancelled;
});

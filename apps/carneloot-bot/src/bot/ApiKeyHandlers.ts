import * as Effect from 'effect/Effect';
import { Conversations, MessageContext, UpdateContext } from 'tfx';

import * as GenerateApiKey from '../application/GenerateApiKey.js';
import { ConversationOperationError } from '../domain/ApplicationError.js';
import { ApiKeyRepository } from '../ports/ApiKeyRepository.js';
import * as ApiKeyConversation from './conversations/ApiKeyConversation.js';
import { CurrentUser } from './CurrentUser.js';
import { botId } from './Declaration.js';

const display = (key: string) =>
	Effect.flatMap(MessageContext.MessageContext, (context) =>
		context.reply(`Aqui está: <pre>${key}</pre>`, { parse_mode: 'HTML' }),
	).pipe(Effect.asVoid);

export const generate = Effect.gen(function* () {
	const current = yield* CurrentUser;
	const repository = yield* ApiKeyRepository;
	if (!(yield* repository.hasForUser(current.user.id))) {
		yield* display(yield* GenerateApiKey.execute(current.user.id));
		return;
	}
	const update = yield* UpdateContext.UpdateContext;
	if (update.chatId === undefined || update.userId === undefined)
		return yield* Effect.fail(
			new ConversationOperationError({
				message: 'Missing conversation scope',
				cause: { _tag: 'MissingConversationScope' },
			}),
		);
	const conversations = yield* Conversations.Conversations;
	yield* conversations
		.start(
			ApiKeyConversation.built,
			{ userId: current.user.id },
			{
				scope: { botId, chatId: update.chatId, userId: update.userId },
				conflict: 'replace',
			},
		)
		.pipe(
			Effect.mapError(
				(cause) =>
					new ConversationOperationError({
						message: 'Could not start API key conversation',
						cause,
					}),
			),
		);
});

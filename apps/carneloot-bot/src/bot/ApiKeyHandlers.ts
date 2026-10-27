import * as Effect from 'effect/Effect';
import { Conversations, UpdateContext } from 'tfx';

import { ConversationOperationError } from '../domain/ApplicationError.js';
import * as GenerateApiKeyConversation from './conversations/GenerateApiKeyConversation.js';
import { CurrentUser } from './CurrentUser.js';

export const startGenerateApiKey = Effect.gen(function* () {
	// The issuance boundary also enforces private chat before touching a key.
	if (
		(yield* GenerateApiKeyConversation.issue(false)) !== 'ConfirmationRequired'
	)
		return;
	const current = yield* CurrentUser;
	const update = yield* UpdateContext.UpdateContext;
	if (update.chatId === undefined || update.userId === undefined)
		return yield* new ConversationOperationError({
			message: 'Missing conversation scope',
			cause: { _tag: 'MissingConversationScope' },
		});
	const conversations = yield* Conversations.Conversations;
	yield* conversations
		.start(
			GenerateApiKeyConversation.built,
			{ actorId: current.user.id },
			{
				scope: {
					botId: current.profile.botId,
					chatId: update.chatId,
					userId: update.userId,
				},
				conflict: 'replace',
			},
		)
		.pipe(
			Effect.mapError(
				(cause) =>
					new ConversationOperationError({
						message: 'Could not start API key confirmation',
						cause,
					}),
			),
		);
});

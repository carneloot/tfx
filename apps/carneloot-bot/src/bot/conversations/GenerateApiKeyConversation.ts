import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import {
	Conversation,
	ConversationBuilder,
	ConversationChoice,
	ConversationInput,
	MessageContext,
} from 'tfx';

import * as GenerateApiKey from '../../application/GenerateApiKey.js';
import { ApplicationError } from '../../domain/ApplicationError.js';
import { InvalidDomainInput } from '../../domain/DomainError.js';
import { UserId } from '../../domain/Ids.js';
import { CurrentUser } from '../CurrentUser.js';
import { RegisteredUser } from '../Declaration.js';
import * as ConversationUi from './ConversationUi.js';

export const issue = Effect.fn('GenerateApiKeyConversation.issue')(function* (
	confirmed: boolean,
) {
	const context = yield* MessageContext.MessageContext;
	if (context.message.chat.type !== 'private') {
		yield* context.reply('Para gerar uma chave, fale comigo no privado.', {
			reply_markup: { remove_keyboard: true },
		});
		return 'PrivateChatRequired' as const;
	}
	const current = yield* CurrentUser;
	const result = yield* GenerateApiKey.execute({
		actorId: current.user.id,
		botId: current.profile.botId,
		telegramUserId: current.profile.telegramUserId,
		confirmed,
	});
	if (result._tag === 'Issued') {
		yield* context.reply(`Aqui está: <pre>${result.key}</pre>`, {
			parse_mode: 'HTML',
			reply_markup: { remove_keyboard: true },
		});
	}
	return result._tag;
});

const State = Schema.Struct({ actorId: UserId });
const choice = ConversationChoice.reply([{ label: 'Yes', value: true }], {
	cancelLabel: 'No',
});
export const declaration = Conversation.make('generate-api-key', {
	version: 1,
	startup: State,
	initialize: (state) => state,
	initialStep: 'confirm',
	steps: {
		confirm: Conversation.step('confirm', {
			state: State,
			input: ConversationInput.choice(choice),
		}),
	},
	middleware: [RegisteredUser],
	idleTimeout: '15 minutes',
	error: ApplicationError,
});

export const built = ConversationBuilder.done(
	ConversationBuilder.make(declaration).step('confirm', {
		enter: () =>
			ConversationUi.promptChoice(
				'Você já possui uma API Key. Deseja gerar uma nova? A outra chave será invalidada.',
				choice,
			),
		onInput: (state, selected) =>
			Effect.gen(function* () {
				const current = yield* CurrentUser;
				if (current.user.id !== state.actorId)
					return yield* new InvalidDomainInput({
						message: 'API key confirmation actor mismatch',
					});
				if (selected._tag === 'Cancelled')
					return ConversationBuilder.cancelled({
						afterCommit: ConversationUi.replyRemovingKeyboard('Okay!'),
					});
				// The secret exists only after the transition commits. It never enters conversation state.
				return ConversationBuilder.complete({
					afterCommit: issue(true).pipe(Effect.asVoid),
				});
			}),
		onInvalid: () =>
			Effect.succeed(
				ConversationBuilder.stay({
					afterCommit: ConversationUi.reply('Por favor, escolha uma opção'),
				}),
			),
	}),
);

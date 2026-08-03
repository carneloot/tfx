import * as Crypto from 'effect/Crypto';
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
import { UserId } from '../../domain/Ids.js';
import { ApiKeyRepository } from '../../ports/ApiKeyRepository.js';
import { RegisteredUser } from '../Declaration.js';
import * as ConversationUi from './ConversationUi.js';

const State = Schema.Struct({ userId: UserId });
const confirm = ConversationChoice.boolean({ yes: 'Sim', no: 'Não' });
const display = (key: string) =>
	Effect.flatMap(MessageContext.MessageContext, (context) =>
		context.reply(`Aqui está: <pre>${key}</pre>`, { parse_mode: 'HTML' }),
	).pipe(Effect.asVoid);

export const declaration = Conversation.make('replace-api-key', {
	version: 1,
	startup: State,
	initialStep: 'confirm',
	initialize: (state) => state,
	steps: {
		confirm: Conversation.step('confirm', {
			state: State,
			input: ConversationInput.choice(confirm),
		}),
	},
	middleware: [RegisteredUser],
	idleTimeout: '15 minutes',
	error: ApplicationError,
});

const required = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		yield* ApiKeyRepository;
		yield* Crypto.Crypto;
		return yield* effect;
	});

export const built = ConversationBuilder.done(
	ConversationBuilder.make(declaration).step('confirm', {
		enter: () =>
			required(
				ConversationUi.promptChoice(
					'Você já tem uma chave. Deseja gerar outra?',
					confirm,
				),
			),
		onInput: (state, choice) =>
			required(
				Effect.gen(function* () {
					if (choice._tag === 'Cancelled' || !choice.value)
						return ConversationBuilder.complete({
							afterCommit: ConversationUi.replyRemovingKeyboard('Okay!'),
						});
					const key = yield* GenerateApiKey.execute(state.userId);
					return ConversationBuilder.complete({ afterCommit: display(key) });
				}),
			),
	}),
);

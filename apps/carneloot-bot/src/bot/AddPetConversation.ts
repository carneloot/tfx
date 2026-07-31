import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { Conversation, ConversationBuilder, ConversationInput } from 'tfx';

import * as AddPet from '../application/AddPet.js';
import { ApplicationError } from '../domain/ApplicationError.js';
import { BotId, TelegramUserId, UserId } from '../domain/Ids.js';
import { PetName } from '../domain/Pet.js';
import { PetRepository } from '../ports/PetRepository.js';
import { UserRepository } from '../ports/UserRepository.js';
import * as ConversationUi from './conversations/ConversationUi.js';
import { RegisteredUser } from './Declaration.js';

const State = Schema.Struct({
	ownerId: UserId,
	botId: BotId,
	telegramUserId: TelegramUserId,
});
export const declaration = Conversation.make('add-owned-pet', {
	version: 1,
	startup: State,
	initialStep: 'name',
	initialize: (identity) => identity,
	steps: {
		name: Conversation.step('name', {
			state: State,
			input: ConversationInput.text(PetName),
		}),
	},
	middleware: [RegisteredUser],
	idleTimeout: 15 * 60 * 1000,
	error: ApplicationError,
});
export const built = ConversationBuilder.done(
	ConversationBuilder.make(declaration).step('name', {
		enter: () =>
			Effect.gen(function* () {
				yield* PetRepository;
				yield* UserRepository;
				yield* ConversationUi.replyRemovingKeyboard('Qual o nome do seu pet?');
			}),
		onInput: (state, name) =>
			Effect.gen(function* () {
				return yield* AddPet.execute({ ...state, name }).pipe(
					Effect.as(
						ConversationBuilder.complete({
							afterCommit: ConversationUi.replyRemovingKeyboard(
								'Pet cadastrado com sucesso!',
							),
						}),
					),
					Effect.catchTag('PetNameAlreadyExists', () =>
						Effect.succeed(
							ConversationBuilder.stay({
								afterCommit: ConversationUi.replyRemovingKeyboard(
									'Já existe um pet com esse nome.',
								),
							}),
						),
					),
				);
			}),
		onInvalid: () =>
			Effect.succeed(
				ConversationBuilder.stay({
					afterCommit: ConversationUi.replyRemovingKeyboard(
						'Nome de pet inválido.',
					),
				}),
			),
	}),
);

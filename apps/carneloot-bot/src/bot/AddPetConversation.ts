import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import {
	Conversation,
	ConversationBuilder,
	ConversationInput,
	MessageContext,
} from 'tfx';

import * as AddPet from '../application/AddPet.js';
import { BotId, TelegramUserId, UserId } from '../domain/Ids.js';
import { PetName } from '../domain/Pet.js';
import { PetRepository } from '../ports/PetRepository.js';
import { UserRepository } from '../ports/UserRepository.js';

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
	idleTimeout: 15 * 60 * 1000,
	error: undefined as any,
});
export const built = ConversationBuilder.done(
	ConversationBuilder.make(declaration).step('name', {
		enter: () =>
			Effect.gen(function* () {
				yield* PetRepository;
				yield* UserRepository;
				const context = yield* MessageContext.MessageContext;
				yield* context.reply('Qual o nome do seu pet?');
			}).pipe(Effect.mapError((error): unknown => error)),
		onInput: (state, name) =>
			Effect.gen(function* () {
				const context = yield* MessageContext.MessageContext;
				return yield* AddPet.execute({ ...state, name }).pipe(
					Effect.as(
						ConversationBuilder.complete({
							afterCommit: context.reply('Pet cadastrado com sucesso!'),
						}),
					),
					Effect.catchTag('PetNameAlreadyExists', () =>
						Effect.succeed(
							ConversationBuilder.stay({
								afterCommit: context.reply('Já existe um pet com esse nome.'),
							}),
						),
					),
				);
			}),
		onInvalid: () =>
			Effect.map(MessageContext.MessageContext, (context) =>
				ConversationBuilder.stay({
					afterCommit: context.reply('Nome de pet inválido.'),
				}),
			),
	}),
);

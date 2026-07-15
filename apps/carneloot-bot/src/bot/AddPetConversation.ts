import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import {
	Conversation,
	ConversationBuilder,
	ConversationInput,
	MessageContext,
} from 'tfx';

import * as AddPet from '../application/AddPet.js';
import { UserId } from '../domain/Ids.js';
import { PetName } from '../domain/Pet.js';
import { PetRepository } from '../ports/PetRepository.js';

const State = Schema.Struct({ ownerId: UserId });
export const declaration = Conversation.make('add-owned-pet', {
	version: 1,
	startup: UserId,
	initialStep: 'name',
	initialize: (ownerId) => ({ ownerId }),
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
				const context = yield* MessageContext.MessageContext;
				yield* context.reply('Qual o nome do seu pet?');
			}).pipe(Effect.mapError((error): unknown => error)),
		onInput: (state, name) =>
			Effect.gen(function* () {
				yield* AddPet.execute(state.ownerId, name);
				const context = yield* MessageContext.MessageContext;
				return ConversationBuilder.complete({
					afterCommit: context.reply('Pet cadastrado com sucesso!'),
				});
			}),
	}),
);

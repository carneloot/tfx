import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import {
	Conversation,
	ConversationBuilder,
	ConversationChoice,
	ConversationInput,
	ConversationPrompt,
} from 'tfx';

import * as ListCaregivers from '../../application/ListCaregivers.js';
import { ApplicationError } from '../../domain/ApplicationError.js';
import { BotId, PetId, TelegramUserId, UserId } from '../../domain/Ids.js';
import { PetName } from '../../domain/Pet.js';
import { RegisteredUser } from '../Declaration.js';
import * as ConversationUi from './ConversationUi.js';

const PetOption = Schema.Struct({ id: PetId, name: PetName });
const State = Schema.Struct({
	actorId: UserId,
	botId: BotId,
	telegramUserId: TelegramUserId,
	pets: Schema.Array(PetOption).check(Schema.isNonEmpty()),
});
const Text = ConversationInput.text(Schema.String);
const choice = (state: typeof State.Type) =>
	ConversationChoice.reply(
		ConversationUi.uniqueReplyOptions(
			state.pets.map((pet) => ({ label: pet.name, value: pet.id })),
		),
		{ cancelLabel: 'Cancelar' },
	);

export const declaration = Conversation.make('list-pet-caregivers', {
	version: 1,
	startup: State,
	initialStep: 'pet',
	initialize: (state) => state,
	steps: { pet: Conversation.step('pet', { state: State, input: Text }) },
	middleware: [RegisteredUser],
	idleTimeout: 15 * 60 * 1000,
	error: ApplicationError,
});
export const built = ConversationBuilder.done(
	ConversationBuilder.make(declaration).step('pet', {
		enter: (state) =>
			ConversationUi.promptChoice('Escolha o pet:', choice(state)),
		onInput: (state, value) =>
			Effect.gen(function* () {
				const selected = yield* Effect.result(
					ConversationPrompt.resolve(choice(state), value),
				);
				if (selected._tag === 'Failure')
					return ConversationBuilder.stay({
						afterCommit: ConversationUi.reply('Por favor, escolha uma opção.'),
					});
				const resolved = selected.success;
				if (resolved._tag === 'Cancelled')
					return ConversationBuilder.cancelled({
						afterCommit: ConversationUi.replyRemovingKeyboard(
							'Operação cancelada.',
						),
					});
				const pet = state.pets.find((item) => item.id === resolved.value);
				if (pet === undefined)
					return ConversationBuilder.stay({
						afterCommit: ConversationUi.reply('Por favor, escolha uma opção.'),
					});
				const result = yield* Effect.result(
					ListCaregivers.execute(state, pet.id),
				);
				if (
					result._tag === 'Failure' &&
					result.failure._tag === 'CaregiverAccessLost'
				)
					return ConversationBuilder.complete({
						afterCommit: ConversationUi.replyRemovingKeyboard(
							'Este pet não está mais disponível para você.',
						),
					});
				if (result._tag === 'Failure')
					return yield* Effect.fail(result.failure);
				const text =
					result.success.length === 0
						? `O pet ${pet.name} não possui cuidadores.`
						: `Cuidadores de ${pet.name}:\n${result.success.map((item) => `• ${item.displayName} — ${item.statusLabel}`).join('\n')}`;
				return ConversationBuilder.complete({
					afterCommit: ConversationUi.replyRemovingKeyboard(text),
				});
			}),
		onInvalid: () =>
			Effect.succeed(
				ConversationBuilder.stay({
					afterCommit: ConversationUi.reply('Por favor, escolha uma opção.'),
				}),
			),
	}),
);

import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import {
	Conversation,
	ConversationBuilder,
	ConversationChoice,
	ConversationInput,
	ConversationPrompt,
	Telegram,
} from 'tfx';

import * as InviteCaregiver from '../../application/InviteCaregiver.js';
import { ApplicationError } from '../../domain/ApplicationError.js';
import { BotId, PetId, TelegramUserId, UserId } from '../../domain/Ids.js';
import { PetName } from '../../domain/Pet.js';
import { RegisteredUser } from '../Declaration.js';
import * as ConversationUi from './ConversationUi.js';

const PetOption = Schema.Struct({ id: PetId, name: PetName });
const Base = {
	actorId: UserId,
	botId: BotId,
	telegramUserId: TelegramUserId,
	pets: Schema.Array(PetOption).check(Schema.isNonEmpty()),
};
const PetState = Schema.Struct(Base);
const UsernameState = Schema.Struct({
	...Base,
	petId: PetId,
	petName: PetName,
});
const Text = ConversationInput.text(Schema.String);
const choice = (state: typeof PetState.Type) =>
	ConversationChoice.reply(
		ConversationUi.uniqueReplyOptions(
			state.pets.map((pet) => ({ label: pet.name, value: pet.id })),
		),
		{ cancelLabel: 'Cancelar' },
	);

export const declaration = Conversation.make('invite-pet-caregiver', {
	version: 1,
	startup: PetState,
	initialStep: 'pet',
	initialize: (state) => state,
	steps: {
		pet: Conversation.step('pet', { state: PetState, input: Text }),
		username: Conversation.step('username', {
			state: UsernameState,
			input: Text,
		}),
	},
	middleware: [RegisteredUser],
	idleTimeout: 15 * 60 * 1000,
	error: ApplicationError,
});
export const built = ConversationBuilder.done(
	ConversationBuilder.make(declaration)
		.step('pet', {
			enter: (state) =>
				ConversationUi.promptChoice('Escolha o pet:', choice(state)),
			onInput: (state, value) =>
				Effect.gen(function* () {
					const result = yield* Effect.result(
						ConversationPrompt.resolve(choice(state), value),
					);
					if (result._tag === 'Failure')
						return ConversationBuilder.stay({
							afterCommit: ConversationUi.reply('Por favor, escolha uma opção'),
						});
					const selected = result.success;
					if (selected._tag === 'Cancelled')
						return ConversationBuilder.cancelled({
							afterCommit: ConversationUi.replyRemovingKeyboard(
								'Operação cancelada.',
							),
						});
					const pet = state.pets.find((item) => item.id === selected.value);
					if (pet === undefined)
						return ConversationBuilder.stay({
							afterCommit: ConversationUi.reply('Por favor, escolha uma opção'),
						});
					return ConversationBuilder.to('username', {
						...state,
						petId: pet.id,
						petName: pet.name,
					});
				}),
			onInvalid: () =>
				Effect.succeed(
					ConversationBuilder.stay({
						afterCommit: ConversationUi.reply('Por favor, escolha uma opção'),
					}),
				),
		})
		.step('username', {
			enter: () =>
				ConversationUi.replyRemovingKeyboard(
					'Envie o @username da pessoa cuidadora.',
				),
			onInput: (state, value) =>
				Effect.gen(function* () {
					const result = yield* Effect.result(
						InviteCaregiver.execute(state, state.petId, value),
					);
					if (result._tag === 'Failure') {
						const tag = result.failure._tag;
						if (tag === 'CaregiverUsernameNotFound')
							return ConversationBuilder.stay({
								afterCommit: ConversationUi.reply(
									'Usuário não encontrado. Tente novamente.',
								),
							});
						if (tag === 'CaregiverUsernameAmbiguous')
							return ConversationBuilder.stay({
								afterCommit: ConversationUi.reply(
									'Mais de um usuário corresponde a esse nome.',
								),
							});
						if (tag === 'CaregiverSelfInvitation')
							return ConversationBuilder.stay({
								afterCommit: ConversationUi.reply(
									'Você não pode convidar a si mesmo.',
								),
							});
						if (tag === 'CaregiverRelationshipExists')
							return ConversationBuilder.stay({
								afterCommit: ConversationUi.reply(
									'Esta pessoa já possui um vínculo com este pet.',
								),
							});
						if (tag === 'CaregiverAccessLost')
							return ConversationBuilder.complete({
								afterCommit: ConversationUi.replyRemovingKeyboard(
									'Este pet não está mais disponível para você.',
								),
							});
						return yield* Effect.fail(result.failure);
					}
					return ConversationBuilder.complete({
						afterCommit: Effect.gen(function* () {
							yield* ConversationUi.replyRemovingKeyboard(
								'Convite enviado com sucesso!',
							);
							const telegram = yield* Telegram.Telegram;
							yield* Effect.forEach(
								result.success.notices,
								(notice) =>
									telegram.sendMessage({
										chat_id: notice.chatId,
										text: notice.text,
									}),
								{ discard: true },
							);
						}),
					});
				}),
			onInvalid: () =>
				Effect.succeed(
					ConversationBuilder.stay({
						afterCommit: ConversationUi.reply('Envie um username válido.'),
					}),
				),
		}),
);

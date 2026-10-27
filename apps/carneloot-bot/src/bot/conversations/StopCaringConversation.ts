import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import {
	Conversation,
	ConversationBuilder,
	ConversationChoice,
	ConversationInput,
	ConversationPrompt,
} from 'tfx';
import * as Telegram from 'tfx/Telegram';

import * as StopCaring from '../../application/StopCaring.js';
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
const ConfirmState = Schema.Struct({ ...Base, petId: PetId, petName: PetName });
const Text = ConversationInput.text(Schema.String);
const petChoice = (state: typeof PetState.Type) =>
	ConversationChoice.reply(
		ConversationUi.uniqueReplyOptions(
			state.pets.map((item) => ({ label: item.name, value: item.id })),
		),
		{ cancelLabel: 'Cancelar' },
	);
const confirmChoice = ConversationChoice.boolean({ yes: 'Sim', no: 'Não' });

export const declaration = Conversation.make('stop-caring-for-pet', {
	version: 1,
	startup: PetState,
	initialStep: 'pet',
	initialize: (state) => state,
	steps: {
		pet: Conversation.step('pet', { state: PetState, input: Text }),
		confirm: Conversation.step('confirm', {
			state: ConfirmState,
			input: ConversationInput.choice(confirmChoice),
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
				state.pets.length === 0
					? ConversationUi.replyRemovingKeyboard(
							'Você não está cuidando de nenhum pet.',
						)
					: ConversationUi.promptChoice('Escolha o pet:', petChoice(state)),
			onInput: (state, value) =>
				Effect.gen(function* () {
					const selected = yield* Effect.result(
						ConversationPrompt.resolve(petChoice(state), value),
					);
					if (selected._tag === 'Failure')
						return ConversationBuilder.stay({
							afterCommit: ConversationUi.reply(
								'Por favor, escolha uma opção.',
							),
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
							afterCommit: ConversationUi.reply(
								'Por favor, escolha uma opção.',
							),
						});
					return ConversationBuilder.to('confirm', {
						...state,
						petId: pet.id,
						petName: pet.name,
					});
				}),
			onInvalid: () =>
				Effect.succeed(
					ConversationBuilder.stay({
						afterCommit: ConversationUi.reply('Por favor, escolha uma opção.'),
					}),
				),
		})
		.step('confirm', {
			enter: (state) =>
				ConversationUi.promptChoice(
					`Deseja parar de cuidar de ${state.petName}?`,
					confirmChoice,
				),
			onInput: (state, selected) =>
				Effect.gen(function* () {
					if (selected._tag === 'Cancelled')
						return ConversationBuilder.cancelled({
							afterCommit: ConversationUi.replyRemovingKeyboard(
								'Operação cancelada.',
							),
						});
					if (!selected.value)
						return ConversationBuilder.complete({
							afterCommit: ConversationUi.replyRemovingKeyboard(
								'Você continuará cuidando deste pet.',
							),
						});
					const result = yield* Effect.result(
						StopCaring.execute(state, state.petId),
					);
					if (
						result._tag === 'Failure' &&
						(result.failure._tag === 'CaregiverAccessLost' ||
							result.failure._tag === 'CaregiverInvitationNotFound' ||
							result.failure._tag === 'CaregiverInvitationNotPending')
					)
						return ConversationBuilder.complete({
							afterCommit: ConversationUi.replyRemovingKeyboard(
								'Este pet não está mais disponível para você.',
							),
						});
					if (result._tag === 'Failure')
						return yield* Effect.fail(result.failure);
					return ConversationBuilder.complete({
						afterCommit: Effect.gen(function* () {
							yield* ConversationUi.replyRemovingKeyboard(
								'Você parou de cuidar deste pet.',
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
						afterCommit: ConversationUi.reply('Por favor, escolha uma opção.'),
					}),
				),
		}),
);

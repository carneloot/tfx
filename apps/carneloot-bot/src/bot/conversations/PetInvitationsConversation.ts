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

import * as RespondPetInvitation from '../../application/RespondPetInvitation.js';
import { ApplicationError } from '../../domain/ApplicationError.js';
import { BotId, PetId, TelegramUserId, UserId } from '../../domain/Ids.js';
import { PetName } from '../../domain/Pet.js';
import { RegisteredUser } from '../Declaration.js';
import * as ConversationUi from './ConversationUi.js';

const InvitationOption = Schema.Struct({
	petId: PetId,
	petName: PetName,
	ownerDisplayName: Schema.String,
});
const Base = {
	actorId: UserId,
	botId: BotId,
	telegramUserId: TelegramUserId,
	invitations: Schema.Array(InvitationOption).check(Schema.isNonEmpty()),
};
const InvitationState = Schema.Struct(Base);
const ConfirmState = Schema.Struct({ ...Base, petId: PetId, petName: PetName });
const Text = ConversationInput.text(Schema.String);
const invitationChoice = (items: ReadonlyArray<typeof InvitationOption.Type>) =>
	ConversationChoice.reply(
		ConversationUi.uniqueReplyOptions(
			items.map((item) => ({
				label: `${item.petName} (${item.ownerDisplayName})`,
				value: item.petId,
			})),
		),
		{ cancelLabel: 'Cancelar' },
	);
const confirmChoice = ConversationChoice.boolean({ yes: 'Sim', no: 'Não' });

export const declaration = Conversation.make('pet-caregiver-invitations', {
	version: 1,
	startup: InvitationState,
	initialStep: 'invitation',
	initialize: (state) => state,
	steps: {
		invitation: Conversation.step('invitation', {
			state: InvitationState,
			input: Text,
		}),
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
		.step('invitation', {
			enter: (state) =>
				state.invitations.length === 0
					? ConversationUi.replyRemovingKeyboard(
							'Você não tem convites pendentes.',
						)
					: ConversationUi.promptChoice(
							'Escolha um convite:',
							invitationChoice(state.invitations),
						),
			onInput: (state, value) =>
				Effect.gen(function* () {
					const selected = yield* Effect.result(
						ConversationPrompt.resolve(
							invitationChoice(state.invitations),
							value,
						),
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
					const invitation = state.invitations.find(
						(item) => item.petId === resolved.value,
					);
					if (invitation === undefined)
						return ConversationBuilder.stay({
							afterCommit: ConversationUi.reply(
								'Por favor, escolha uma opção.',
							),
						});
					return ConversationBuilder.to('confirm', {
						...state,
						petId: invitation.petId,
						petName: invitation.petName,
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
					`Deseja aceitar o convite para cuidar de ${state.petName}?`,
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
					const response = selected.value ? 'accepted' : 'rejected';
					const result = yield* Effect.result(
						RespondPetInvitation.execute(state, state.petId, response),
					);
					if (
						result._tag === 'Failure' &&
						(result.failure._tag === 'CaregiverAccessLost' ||
							result.failure._tag === 'CaregiverInvitationNotFound' ||
							result.failure._tag === 'CaregiverInvitationNotPending')
					)
						return ConversationBuilder.complete({
							afterCommit: ConversationUi.replyRemovingKeyboard(
								'Este convite não está mais disponível.',
							),
						});
					if (result._tag === 'Failure')
						return yield* Effect.fail(result.failure);
					return ConversationBuilder.complete({
						afterCommit: Effect.gen(function* () {
							yield* ConversationUi.replyRemovingKeyboard(
								response === 'accepted'
									? `Convite aceito! Você agora cuida de ${state.petName}.`
									: 'Convite recusado.',
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

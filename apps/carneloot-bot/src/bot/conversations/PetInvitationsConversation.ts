import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import {
	Conversation,
	ConversationBuilder,
	ConversationChoice,
	ConversationInput,
	ConversationPrompt,
} from 'tfx';
import type { TaggedError } from 'tfx/TaggedError';
import * as Telegram from 'tfx/Telegram';

import * as RespondPetInvitation from '../../application/RespondPetInvitation.js';
import { ApplicationError } from '../../domain/ApplicationError.js';
import { BotId, PetId, TelegramUserId, UserId } from '../../domain/Ids.js';
import { PetName } from '../../domain/Pet.js';
import { PetCaregiverRepository } from '../../ports/PetCaregiverRepository.js';
import { PetRepository } from '../../ports/PetRepository.js';
import { UserRepository } from '../../ports/UserRepository.js';
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
const reply = ConversationUi.reply;
const replyRemovingKeyboard = ConversationUi.replyRemovingKeyboard;
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

const required = <A, E extends TaggedError, R>(
	effect: Effect.Effect<A, E, R>,
) =>
	Effect.gen(function* () {
		yield* PgClient.PgClient;
		yield* PetRepository;
		yield* PetCaregiverRepository;
		yield* UserRepository;
		yield* Telegram.Telegram;
		return yield* effect;
	});
const stay = () =>
	required(
		Effect.succeed(
			ConversationBuilder.stay({
				afterCommit: reply('Por favor, escolha uma opção.'),
			}),
		),
	);
const unavailable = () =>
	ConversationBuilder.complete({
		afterCommit: replyRemovingKeyboard(
			'Este convite não está mais disponível.',
		),
	});
const output = (
	response: 'accepted' | 'rejected',
	petName: string,
	notices: ReadonlyArray<{ readonly chatId: number; readonly text: string }>,
) =>
	Effect.gen(function* () {
		yield* replyRemovingKeyboard(
			response === 'accepted'
				? `Convite aceito! Você agora cuida de ${petName}.`
				: 'Convite recusado.',
		);
		const telegram = yield* Telegram.Telegram;
		yield* Effect.forEach(
			notices,
			(notice) =>
				telegram.sendMessage({ chat_id: notice.chatId, text: notice.text }),
			{ discard: true },
		);
	});

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
				required(
					state.invitations.length === 0
						? replyRemovingKeyboard('Você não tem convites pendentes.')
						: ConversationUi.promptChoice(
								'Escolha um convite:',
								invitationChoice(state.invitations),
							),
				),
			onInput: (state, value) =>
				required(
					Effect.gen(function* () {
						const selected = yield* Effect.result(
							ConversationPrompt.resolve(
								invitationChoice(state.invitations),
								value,
							),
						);
						if (selected._tag === 'Failure') return yield* stay();
						const resolved = selected.success;
						if (resolved._tag === 'Cancelled')
							return ConversationBuilder.cancelled({
								afterCommit: replyRemovingKeyboard('Operação cancelada.'),
							});
						const invitation = state.invitations.find(
							(item) => item.petId === resolved.value,
						);
						if (invitation === undefined) return yield* stay();
						return ConversationBuilder.to('confirm', {
							...state,
							petId: invitation.petId,
							petName: invitation.petName,
						});
					}),
				),
			onInvalid: () => stay(),
		})
		.step('confirm', {
			enter: (state) =>
				required(
					ConversationUi.promptChoice(
						`Deseja aceitar o convite para cuidar de ${state.petName}?`,
						confirmChoice,
					),
				),
			onInput: (state, selected) =>
				required(
					Effect.gen(function* () {
						if (selected._tag === 'Cancelled')
							return ConversationBuilder.cancelled({
								afterCommit: replyRemovingKeyboard('Operação cancelada.'),
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
							return unavailable();
						if (result._tag === 'Failure')
							return yield* Effect.fail(result.failure);
						return ConversationBuilder.complete({
							afterCommit: output(
								response,
								state.petName,
								result.success.notices,
							),
						});
					}),
				),
			onInvalid: () => stay(),
		}),
);

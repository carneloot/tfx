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

import * as ListCaregivers from '../../application/ListCaregivers.js';
import * as RemoveCaregiver from '../../application/RemoveCaregiver.js';
import { ApplicationError } from '../../domain/ApplicationError.js';
import { BotId, PetId, TelegramUserId, UserId } from '../../domain/Ids.js';
import { PetName } from '../../domain/Pet.js';
import { PetCaregiverRepository } from '../../ports/PetCaregiverRepository.js';
import { PetRepository } from '../../ports/PetRepository.js';
import { UserRepository } from '../../ports/UserRepository.js';
import * as ConversationUi from './ConversationUi.js';

const PetOption = Schema.Struct({ id: PetId, name: PetName });
const CaregiverOption = Schema.Struct({ id: UserId, label: Schema.String });
const Base = {
	actorId: UserId,
	botId: BotId,
	telegramUserId: TelegramUserId,
	pets: Schema.Array(PetOption).check(Schema.isNonEmpty()),
};
const PetState = Schema.Struct(Base);
const CaregiverState = Schema.Struct({
	...Base,
	petId: PetId,
	petName: PetName,
	caregivers: Schema.Array(CaregiverOption),
});
const Text = ConversationInput.text(Schema.String);
const reply = ConversationUi.reply;
const replyRemovingKeyboard = ConversationUi.replyRemovingKeyboard;
const petChoice = (state: typeof PetState.Type) =>
	ConversationChoice.reply(
		ConversationUi.uniqueReplyOptions(
			state.pets.map((item) => ({ label: item.name, value: item.id })),
		),
		{ cancelLabel: 'Cancelar' },
	);
const caregiverChoice = (items: ReadonlyArray<typeof CaregiverOption.Type>) =>
	ConversationChoice.reply(
		ConversationUi.uniqueReplyOptions(
			items.map((item) => ({ label: item.label, value: item.id })),
		),
		{ cancelLabel: 'Cancelar' },
	);

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
			'Este pet não está mais disponível para você.',
		),
	});
const output = (
	notices: ReadonlyArray<{ readonly chatId: number; readonly text: string }>,
) =>
	Effect.gen(function* () {
		yield* replyRemovingKeyboard('Cuidador removido com sucesso!');
		const telegram = yield* Telegram.Telegram;
		yield* Effect.forEach(
			notices,
			(notice) =>
				telegram.sendMessage({ chat_id: notice.chatId, text: notice.text }),
			{ discard: true },
		);
	});

export const declaration = Conversation.make('remove-pet-caregiver', {
	version: 1,
	startup: PetState,
	initialStep: 'pet',
	initialize: (state) => state,
	steps: {
		pet: Conversation.step('pet', { state: PetState, input: Text }),
		caregiver: Conversation.step('caregiver', {
			state: CaregiverState,
			input: Text,
		}),
	},
	idleTimeout: 15 * 60 * 1000,
	error: ApplicationError,
});
export const built = ConversationBuilder.done(
	ConversationBuilder.make(declaration)
		.step('pet', {
			enter: (state) =>
				required(
					ConversationUi.promptChoice('Escolha o pet:', petChoice(state)),
				),
			onInput: (state, value) =>
				required(
					Effect.gen(function* () {
						const selected = yield* Effect.result(
							ConversationPrompt.resolve(petChoice(state), value),
						);
						if (selected._tag === 'Failure') return yield* stay();
						const resolved = selected.success;
						if (resolved._tag === 'Cancelled')
							return ConversationBuilder.cancelled({
								afterCommit: replyRemovingKeyboard('Operação cancelada.'),
							});
						const pet = state.pets.find((item) => item.id === resolved.value);
						if (pet === undefined) return yield* stay();
						const listed = yield* Effect.result(
							ListCaregivers.execute(state, pet.id),
						);
						if (
							listed._tag === 'Failure' &&
							listed.failure._tag === 'CaregiverAccessLost'
						)
							return unavailable();
						if (listed._tag === 'Failure')
							return yield* Effect.fail(listed.failure);
						if (listed.success.length === 0)
							return ConversationBuilder.complete({
								afterCommit: replyRemovingKeyboard(
									`O pet ${pet.name} não possui cuidadores.`,
								),
							});
						return ConversationBuilder.to('caregiver', {
							...state,
							petId: pet.id,
							petName: pet.name,
							caregivers: listed.success.map((item) => ({
								id: item.relation.caregiverUserId,
								label: `${item.displayName} (${item.statusLabel})`,
							})),
						});
					}),
				),
			onInvalid: () => stay(),
		})
		.step('caregiver', {
			enter: (state) =>
				required(
					ConversationUi.promptChoice(
						'Escolha a pessoa cuidadora que deseja remover:',
						caregiverChoice(state.caregivers),
					),
				),
			onInput: (state, value) =>
				required(
					Effect.gen(function* () {
						const selected = yield* Effect.result(
							ConversationPrompt.resolve(
								caregiverChoice(state.caregivers),
								value,
							),
						);
						if (selected._tag === 'Failure') return yield* stay();
						const resolved = selected.success;
						if (resolved._tag === 'Cancelled')
							return ConversationBuilder.cancelled({
								afterCommit: replyRemovingKeyboard('Operação cancelada.'),
							});
						const result = yield* Effect.result(
							RemoveCaregiver.execute(state, state.petId, resolved.value),
						);
						if (
							result._tag === 'Failure' &&
							(result.failure._tag === 'CaregiverAccessLost' ||
								result.failure._tag === 'CaregiverInvitationNotFound')
						)
							return unavailable();
						if (result._tag === 'Failure')
							return yield* Effect.fail(result.failure);
						return ConversationBuilder.complete({
							afterCommit: output(result.success.notices),
						});
					}),
				),
			onInvalid: () => stay(),
		}),
);

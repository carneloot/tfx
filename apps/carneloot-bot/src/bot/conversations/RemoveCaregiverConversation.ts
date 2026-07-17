import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import {
	Conversation,
	ConversationBuilder,
	ConversationChoice,
	ConversationInput,
	ConversationPrompt,
	MessageContext,
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
const widen = <A, E extends TaggedError, R>(effect: Effect.Effect<A, E, R>) =>
	effect;
const reply = (text: string, removeKeyboard = false) =>
	widen(
		Effect.flatMap(MessageContext.MessageContext, (context) =>
			context.reply(
				text,
				removeKeyboard
					? { reply_markup: ConversationPrompt.removeReplyKeyboard }
					: undefined,
			),
		).pipe(Effect.asVoid),
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
const petChoice = (items: ReadonlyArray<typeof PetOption.Type>) =>
	ConversationChoice.make(
		items.map((item) => ({ label: item.name, value: item.id })),
	);
const caregiverChoice = (items: ReadonlyArray<typeof CaregiverOption.Type>) =>
	ConversationChoice.make(
		items.map((item) => ({ label: item.label, value: item.id })),
	);
const prompt = <A>(
	text: string,
	options: ConversationChoice.Choice<A, never>,
) =>
	Effect.flatMap(MessageContext.MessageContext, (context) =>
		context.reply(text, {
			reply_markup: {
				keyboard: options.options.map((item) => [{ text: item.label }]),
				one_time_keyboard: true,
				resize_keyboard: true,
			},
		}),
	).pipe(Effect.asVoid);
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
		afterCommit: reply('Este pet não está mais disponível para você.', true),
	});
const output = (
	notices: ReadonlyArray<{ readonly chatId: number; readonly text: string }>,
) =>
	Effect.gen(function* () {
		yield* reply('Cuidador removido com sucesso!', true);
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
				required(prompt('Escolha o pet:', petChoice(state.pets))),
			onInput: (state, value) =>
				required(
					Effect.gen(function* () {
						const selected = yield* Effect.result(
							ConversationPrompt.resolve(petChoice(state.pets), value),
						);
						if (selected._tag === 'Failure') return yield* stay();
						const resolved = selected.success;
						if (resolved._tag === 'Cancelled') return yield* stay();
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
								afterCommit: reply(
									`O pet ${pet.name} não possui cuidadores.`,
									true,
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
					prompt(
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
						if (resolved._tag === 'Cancelled') return yield* stay();
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

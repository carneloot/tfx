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

import * as DeletePet from '../../application/DeletePet.js';
import { ApplicationError } from '../../domain/ApplicationError.js';
import { BotId, PetId, TelegramUserId, UserId } from '../../domain/Ids.js';
import { PetName } from '../../domain/Pet.js';
import { PetRepository } from '../../ports/PetRepository.js';
import { ReminderScheduler } from '../../ports/ReminderScheduler.js';
import { UserRepository } from '../../ports/UserRepository.js';

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
		yield* ReminderScheduler;
		yield* UserRepository;
		return yield* effect;
	});
const petChoice = (pets: ReadonlyArray<typeof PetOption.Type>) =>
	ConversationChoice.make(
		pets.map((pet) => ({ label: pet.name, value: pet.id })),
	);
const confirmChoice = ConversationChoice.make([
	{ label: 'Sim', value: true },
	{ label: 'Não', value: false },
]);
const prompt = <A>(text: string, choice: ConversationChoice.Choice<A, never>) =>
	Effect.flatMap(MessageContext.MessageContext, (context) =>
		context.reply(text, {
			reply_markup: {
				keyboard: choice.options.map((item) => [{ text: item.label }]),
				one_time_keyboard: true,
				resize_keyboard: true,
			},
		}),
	).pipe(Effect.asVoid);
const invalid = required(
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

export const declaration = Conversation.make('delete-pet', {
	version: 1,
	startup: PetState,
	initialStep: 'pet',
	initialize: (state) => state,
	steps: {
		pet: Conversation.step('pet', { state: PetState, input: Text }),
		confirm: Conversation.step('confirm', { state: ConfirmState, input: Text }),
	},
	idleTimeout: 15 * 60 * 1000,
	error: ApplicationError,
});
export const built = ConversationBuilder.done(
	ConversationBuilder.make(declaration)
		.step('pet', {
			enter: (state) =>
				required(
					prompt('Escolha o pet que deseja deletar:', petChoice(state.pets)),
				),
			onInput: (state, value) =>
				required(
					Effect.gen(function* () {
						const selected = petChoice(state.pets).options.find(
							(item) => item.label === value,
						);
						if (selected === undefined) return yield* invalid;
						const pet = state.pets.find((item) => item.id === selected.value);
						if (pet === undefined) return yield* invalid;
						return ConversationBuilder.to('confirm', {
							...state,
							petId: pet.id,
							petName: pet.name,
						});
					}),
				),
			onInvalid: () => invalid,
		})
		.step('confirm', {
			enter: (state) =>
				required(
					prompt(
						`Tem certeza que deseja deletar ${state.petName}?`,
						confirmChoice,
					),
				),
			onInput: (state, value) =>
				required(
					Effect.gen(function* () {
						const selected = confirmChoice.options.find(
							(item) => item.label === value,
						);
						if (selected === undefined) return yield* invalid;
						if (!selected.value)
							return ConversationBuilder.complete({
								afterCommit: reply('Pet não deletado.', true),
							});
						const result = yield* Effect.result(
							DeletePet.execute(state, state.petId),
						);
						if (
							result._tag === 'Failure' &&
							result.failure._tag === 'PetAccessDenied'
						)
							return unavailable();
						if (result._tag === 'Failure')
							return yield* Effect.fail(result.failure);
						return ConversationBuilder.complete({
							afterCommit: reply('Pet deletado com sucesso!', true),
						});
					}),
				),
			onInvalid: () => invalid,
		}),
);

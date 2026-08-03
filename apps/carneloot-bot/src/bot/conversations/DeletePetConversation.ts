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

import * as DeletePet from '../../application/DeletePet.js';
import { ApplicationError } from '../../domain/ApplicationError.js';
import { BotId, PetId, TelegramUserId, UserId } from '../../domain/Ids.js';
import { PetName } from '../../domain/Pet.js';
import { PetRepository } from '../../ports/PetRepository.js';
import { ReminderScheduler } from '../../ports/ReminderScheduler.js';
import { UserRepository } from '../../ports/UserRepository.js';
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
const reply = ConversationUi.reply;
const replyRemovingKeyboard = ConversationUi.replyRemovingKeyboard;
const petChoice = (state: typeof PetState.Type) =>
	ConversationChoice.reply(
		ConversationUi.uniqueReplyOptions(
			state.pets.map((pet) => ({ label: pet.name, value: pet.id })),
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
		yield* ReminderScheduler;
		yield* UserRepository;
		return yield* effect;
	});
const invalid = required(
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

export const declaration = Conversation.make('delete-pet', {
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
				required(
					ConversationUi.promptChoice(
						'Escolha o pet que deseja deletar:',
						petChoice(state),
					),
				),
			onInput: (state, value) =>
				required(
					Effect.gen(function* () {
						const result = yield* Effect.result(
							ConversationPrompt.resolve(petChoice(state), value),
						);
						if (result._tag === 'Failure') return yield* invalid;
						const selected = result.success;
						if (selected._tag === 'Cancelled')
							return ConversationBuilder.cancelled({
								afterCommit: replyRemovingKeyboard('Operação cancelada.'),
							});
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
					ConversationUi.promptChoice(
						`Tem certeza que deseja deletar ${state.petName}?`,
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
						if (!selected.value)
							return ConversationBuilder.complete({
								afterCommit: replyRemovingKeyboard('Pet não deletado.'),
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
							afterCommit: replyRemovingKeyboard('Pet deletado com sucesso!'),
						});
					}),
				),
			onInvalid: () => invalid,
		}),
);

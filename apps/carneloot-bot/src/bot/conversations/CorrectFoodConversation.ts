import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
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

import * as CorrectFood from '../../application/CorrectFood.js';
import * as ListCurrentFoodEntries from '../../application/ListCurrentFoodEntries.js';
import { authorize } from '../../application/PetFoodAccess.js';
import { ApplicationError } from '../../domain/ApplicationError.js';
import { BotId, PetId, TelegramUserId, UserId } from '../../domain/Ids.js';
import * as DayBoundary from '../../domain/pet-food/DayBoundary.js';
import { FoodEntryId } from '../../domain/pet-food/PetFood.js';
import { PetName } from '../../domain/Pet.js';
import { PetCaregiverRepository } from '../../ports/PetCaregiverRepository.js';
import { PetFoodRepository } from '../../ports/PetFoodRepository.js';
import { PetRepository } from '../../ports/PetRepository.js';
import { ReminderScheduler } from '../../ports/ReminderScheduler.js';
import { UserRepository } from '../../ports/UserRepository.js';
import { RegisteredUser } from '../Declaration.js';
import * as ConversationUi from './ConversationUi.js';

const PetOption = Schema.Struct({ id: PetId, name: PetName });
const EntryOption = Schema.Struct({ id: FoodEntryId, label: Schema.String });
const Base = {
	actorId: UserId,
	botId: BotId,
	telegramUserId: TelegramUserId,
	pets: Schema.Array(PetOption),
};
const PetState = Schema.Struct(Base);
const EntryState = Schema.Struct({
	...Base,
	petId: PetId,
	entries: Schema.Array(EntryOption),
});
const CorrectionState = Schema.Struct({
	...Base,
	petId: PetId,
	entryId: FoodEntryId,
});
const Text = ConversationInput.text(Schema.String);
const reply = ConversationUi.reply;
const replyRemovingKeyboard = ConversationUi.replyRemovingKeyboard;
const required = <A, E extends TaggedError, R>(
	effect: Effect.Effect<A, E, R>,
) =>
	Effect.gen(function* () {
		yield* PgClient.PgClient;
		yield* PetFoodRepository;
		yield* PetRepository;
		yield* PetCaregiverRepository;
		yield* ReminderScheduler;
		yield* UserRepository;
		yield* UserRepository;
		return yield* effect;
	});
const choice = <A>(options: ReadonlyArray<ConversationChoice.Option<A>>) =>
	ConversationChoice.reply(ConversationUi.uniqueReplyOptions(options), {
		cancelLabel: 'Cancelar',
		columns: 1,
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
const grams = (mg: number) =>
	`${Number.isInteger(mg / 1000) ? mg / 1000 : (mg / 1000).toFixed(3).replace(/0+$/u, '').replace(/\.$/u, '')} g`;

export const declaration = Conversation.make('correct-pet-food', {
	version: 1,
	startup: PetState,
	initialStep: 'pet',
	initialize: (state) => state,
	steps: {
		pet: Conversation.step('pet', { state: PetState, input: Text }),
		entry: Conversation.step('entry', { state: EntryState, input: Text }),
		correction: Conversation.step('correction', {
			state: CorrectionState,
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
				required(
					ConversationUi.promptChoice(
						'Escolha o pet:',
						choice(
							state.pets.map((pet) => ({ label: pet.name, value: pet.id })),
						),
					),
				),
			onInput: (state, value) =>
				required(
					Effect.gen(function* () {
						const resolved = yield* Effect.result(
							ConversationPrompt.resolve(
								choice(
									state.pets.map((pet) => ({ label: pet.name, value: pet.id })),
								),
								value,
							),
						);
						if (resolved._tag === 'Failure') return yield* invalid;
						const selected = resolved.success;
						if (selected._tag === 'Cancelled')
							return ConversationBuilder.cancelled({
								afterCommit: replyRemovingKeyboard('Operação cancelada.'),
							});
						const pet = state.pets.find((item) => item.id === selected.value);
						if (pet === undefined) return yield* invalid;
						const access = {
							actorId: state.actorId,
							botId: state.botId,
							telegramUserId: state.telegramUserId,
							petId: pet.id,
						};
						const authorization = yield* Effect.result(authorize(access));
						if (
							authorization._tag === 'Failure' &&
							authorization.failure._tag === 'PetAccessDenied'
						)
							return unavailable();
						if (authorization._tag === 'Failure')
							return yield* Effect.fail(authorization.failure);
						const repository = yield* PetFoodRepository;
						const settings = yield* repository.getSettings(pet.id);
						if (
							settings?.dayStart === null ||
							settings?.timeZone === null ||
							settings === undefined
						)
							return ConversationBuilder.complete({
								afterCommit: replyRemovingKeyboard(
									`Você não configurou o início do dia para o pet ${pet.name}.`,
								),
							});
						const window = DayBoundary.current(yield* DateTime.now, {
							localTime: settings.dayStart,
							timeZone: settings.timeZone,
						});
						const listed = yield* repository.listEntries(
							pet.id,
							window.start,
							window.end,
						);
						const entries = yield* ListCurrentFoodEntries.execute(
							state.botId,
							settings.timeZone,
							listed,
						);
						if (entries.length === 0)
							return ConversationBuilder.complete({
								afterCommit: replyRemovingKeyboard(
									'Não há registros de ração hoje para este pet.',
								),
							});
						return ConversationBuilder.to('entry', {
							...state,
							petId: pet.id,
							entries: entries.map(
								({ entry, localTimestamp, actorDisplay }) => ({
									id: entry.id,
									label: `${grams(entry.amountMg)} — ${localTimestamp} — ${actorDisplay}`,
								}),
							),
						});
					}),
				),
			onInvalid: () => invalid,
		})
		.step('entry', {
			enter: (state) =>
				required(
					ConversationUi.promptChoice(
						'Escolha o registro de ração:',
						choice(
							state.entries.map((entry) => ({
								label: entry.label,
								value: entry.id,
							})),
						),
					),
				),
			onInput: (state, value) =>
				required(
					Effect.gen(function* () {
						const resolved = yield* Effect.result(
							ConversationPrompt.resolve(
								choice(
									state.entries.map((entry) => ({
										label: entry.label,
										value: entry.id,
									})),
								),
								value,
							),
						);
						if (resolved._tag === 'Failure') return yield* invalid;
						const selected = resolved.success;
						if (selected._tag === 'Cancelled')
							return ConversationBuilder.cancelled({
								afterCommit: replyRemovingKeyboard('Operação cancelada.'),
							});
						const entry = state.entries.find(
							(item) => item.id === selected.value,
						);
						if (entry === undefined) return yield* invalid;
						return ConversationBuilder.to('correction', {
							...state,
							entryId: entry.id,
						});
					}),
				),
			onInvalid: () => invalid,
		})
		.step('correction', {
			enter: () =>
				required(
					replyRemovingKeyboard('Digite a nova quantidade, horário, ou ambos:'),
				),
			onInput: (state, value) =>
				required(
					Effect.gen(function* () {
						const context = yield* MessageContext.MessageContext;
						const result = yield* Effect.result(
							CorrectFood.execute(
								{
									actorId: state.actorId,
									botId: state.botId,
									telegramUserId: state.telegramUserId,
									petId: state.petId,
								},
								state.entryId,
								{
									correction: value,
									messageDate: DateTime.makeUnsafe(context.message.date * 1000),
								},
							),
						);
						if (result._tag === 'Failure') {
							if (result.failure._tag === 'PetAccessDenied')
								return unavailable();
							if (result.failure._tag === 'InvalidDomainInput')
								return yield* invalid;
							return yield* Effect.fail(result.failure);
						}
						return ConversationBuilder.complete({
							afterCommit: replyRemovingKeyboard('Ração alterada com sucesso!'),
						});
					}),
				),
			onInvalid: () => invalid,
		}),
);

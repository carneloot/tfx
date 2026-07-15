import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import {
	Conversation,
	ConversationBuilder,
	ConversationInput,
	MessageContext,
} from 'tfx';

import * as AddFood from '../../application/AddFood.js';
import { authorize } from '../../application/PetFoodAccess.js';
import {
	BotId,
	PetId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../../domain/Ids.js';
import { FoodAmount } from '../../domain/pet-food/FoodAmount.js';
import { IanaTimeZone } from '../../domain/pet-food/FoodDateTime.js';
import { PetName } from '../../domain/Pet.js';
import { PetFoodRepository } from '../../ports/PetFoodRepository.js';
import { ReminderScheduler } from '../../ports/ReminderScheduler.js';
import { UserRepository } from '../../ports/UserRepository.js';

const PetOption = Schema.Struct({ id: PetId, name: PetName });
const Base = {
	ownerId: UserId,
	botId: BotId,
	telegramUserId: TelegramUserId,
	pets: Schema.Array(PetOption),
	updateId: Schema.Number,
	messageChatId: TelegramChatId,
	messageId: Schema.Number,
};
const PetState = Schema.Struct(Base);
const AmountState = Schema.Struct({
	...Base,
	petId: PetId,
	petName: PetName,
	timeZone: IanaTimeZone,
});
const Text = ConversationInput.text(Schema.String);
const widen = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, unknown, R> =>
	effect.pipe(Effect.mapError((error): unknown => error));
const reply = (text: string) =>
	widen(
		Effect.flatMap(MessageContext.MessageContext, (context) =>
			context.reply(text),
		),
	);
const required = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		yield* PgClient.PgClient;
		yield* PetFoodRepository;
		yield* ReminderScheduler;
		yield* UserRepository;
		return yield* effect;
	});
const stay = (text: string) =>
	required(
		Effect.succeed(ConversationBuilder.stay({ afterCommit: reply(text) })),
	);
const setupWarning = (name: string) =>
	`Você não configurou o início do dia para o pet ${name}.`;
const amountText = (milligrams: number) => {
	const grams = milligrams / 1_000;
	return `${Number.isInteger(grams) ? grams : grams.toFixed(3).replace(/0+$/u, '').replace(/\.$/u, '')} g`;
};
const localized = (instant: number, timeZone: IanaTimeZone) => {
	const parts = DateTime.toParts(
		DateTime.makeZonedUnsafe(instant, { timeZone }),
	);
	return `${String(parts.day).padStart(2, '0')}/${String(parts.month).padStart(2, '0')}/${parts.year} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
};
const splitInput = (
	input: string,
): { amount: string; dateTime: string } | undefined => {
	const trimmed = input.trim();
	if (trimmed.length === 0) return undefined;
	const suffix =
		/^(.*?\S)\s+((?:\d{2}[/-]\d{2}(?:[/-]\d{4})? \d{2}:\d{2})|(?:\d{2}:\d{2}))$/u.exec(
			trimmed,
		);
	if (suffix !== null) return { amount: suffix[1]!, dateTime: suffix[2]! };
	return { amount: trimmed, dateTime: '' };
};

export const declaration = Conversation.make('add-pet-food', {
	version: 1,
	startup: PetState,
	initialStep: 'pet',
	initialize: (state) => state,
	steps: {
		pet: Conversation.step('pet', { state: PetState, input: Text }),
		amount: Conversation.step('amount', { state: AmountState, input: Text }),
	},
	idleTimeout: 15 * 60 * 1_000,
	error: undefined as unknown,
});

export const built = ConversationBuilder.done(
	ConversationBuilder.make(declaration)
		.step('pet', {
			enter: (state) =>
				required(
					reply(
						`Escolha o pet: ${state.pets.map((pet) => pet.name).join(', ')}`,
					),
				),
			onInput: (state, value) =>
				required(
					widen(
						Effect.gen(function* () {
							const pet = state.pets.find(
								(candidate) => candidate.name === value,
							);
							if (pet === undefined)
								return yield* stay('Por favor, escolha uma opção');
							yield* authorize({
								ownerId: state.ownerId,
								botId: state.botId,
								telegramUserId: state.telegramUserId,
								petId: pet.id,
							});
							const settings = yield* (yield* PetFoodRepository).getSettings(
								pet.id,
							);
							if (
								settings?.dayStart === null ||
								settings?.timeZone === null ||
								settings === undefined
							)
								return yield* stay(setupWarning(pet.name));
							return ConversationBuilder.to('amount', {
								...state,
								petId: pet.id,
								petName: pet.name,
								timeZone: settings.timeZone,
							});
						}),
					),
				),
			onInvalid: () => stay('Por favor, escolha uma opção'),
		})
		.step('amount', {
			enter: () =>
				required(reply('Envie a quantidade e, opcionalmente, o horário.')),
			onInput: (state, value) =>
				required(
					widen(
						Effect.gen(function* () {
							const parsed = splitInput(value);
							if (parsed === undefined)
								return yield* stay(
									'Formato inválido. Envie a quantidade e, opcionalmente, o horário.',
								);
							const amount = yield* Effect.result(
								Schema.decodeUnknownEffect(FoodAmount)(parsed.amount),
							);
							if (amount._tag === 'Failure')
								return yield* stay(
									'Formato inválido. Envie a quantidade e, opcionalmente, o horário.',
								);
							const result = yield* Effect.result(
								AddFood.execute(
									{
										ownerId: state.ownerId,
										botId: state.botId,
										telegramUserId: state.telegramUserId,
										petId: state.petId,
									},
									parsed.amount,
									parsed.dateTime,
									{
										botId: state.botId,
										updateId: state.updateId,
										messageChatId: state.messageChatId,
										messageId: state.messageId,
									},
								),
							);
							if (result._tag === 'Failure') {
								const error = result.failure as { readonly _tag?: string };
								if (error._tag === 'DuplicateFoodEntry')
									return yield* stay(
										'Já existe um registro de ração nesse horário.',
									);
								if (error._tag === 'PetFoodSetupMissing')
									return yield* stay(setupWarning(state.petName));
								return yield* stay(
									'Formato inválido. Envie a quantidade e, opcionalmente, o horário.',
								);
							}
							const context = yield* MessageContext.MessageContext;
							const base = `Foram adicionados ${amountText(result.success.entry.amountMg)} de ração para o pet ${state.petName}.`;
							const text = result.success.latest
								? base
								: `${base} Horário: ${localized(result.success.entry.fedAt, state.timeZone)}.`;
							return ConversationBuilder.complete({
								afterCommit: Effect.andThen(
									context.reply(text),
									context.react([{ type: 'emoji', emoji: '👍' }]),
								),
							});
						}),
					),
				),
			onInvalid: () =>
				stay(
					'Formato inválido. Envie a quantidade e, opcionalmente, o horário.',
				),
		}),
);

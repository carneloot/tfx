import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import {
	Conversation,
	ConversationBuilder,
	ConversationInput,
	MessageContext,
} from 'tfx';

import * as ConfigureDayStart from '../../application/ConfigureDayStart.js';
import { BotId, PetId, TelegramUserId, UserId } from '../../domain/Ids.js';
import { IanaTimeZone, LocalTime } from '../../domain/pet-food/FoodDateTime.js';
import { PetName } from '../../domain/Pet.js';
import { PetFoodRepository } from '../../ports/PetFoodRepository.js';
import { UserRepository } from '../../ports/UserRepository.js';

const PetOption = Schema.Struct({ id: PetId, name: PetName });
const Base = {
	ownerId: UserId,
	botId: BotId,
	telegramUserId: TelegramUserId,
	pets: Schema.Array(PetOption),
};
const PetState = Schema.Struct(Base);
const SelectedState = Schema.Struct({
	...Base,
	petId: PetId,
	currentDayStart: Schema.NullOr(LocalTime),
	currentTimeZone: Schema.NullOr(IanaTimeZone),
});
const HourState = Schema.Struct({ ...Base, petId: PetId });
const TimeZoneState = Schema.Struct({
	...Base,
	petId: PetId,
	dayStart: LocalTime,
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
		yield* UserRepository;
		return yield* effect;
	});
const invalid = required(
	Effect.succeed(
		ConversationBuilder.stay({
			afterCommit: reply('Por favor, escolha uma opção'),
		}),
	),
);

export const declaration = Conversation.make('configure-pet-day-start', {
	version: 1,
	startup: PetState,
	initialStep: 'pet',
	initialize: (state) => state,
	steps: {
		pet: Conversation.step('pet', { state: PetState, input: Text }),
		confirm: Conversation.step('confirm', {
			state: SelectedState,
			input: Text,
		}),
		hour: Conversation.step('hour', { state: HourState, input: Text }),
		timezone: Conversation.step('timezone', {
			state: TimeZoneState,
			input: Text,
		}),
	},
	idleTimeout: 15 * 60 * 1000,
	error: undefined as unknown,
});
export const built = ConversationBuilder.done(
	ConversationBuilder.make(declaration)
		.step('pet', {
			enter: (state) =>
				required(
					reply(`Escolha o pet: ${state.pets.map((p) => p.name).join(', ')}`),
				),
			onInput: (state, value) =>
				required(
					widen(
						Effect.gen(function* () {
							const pet = state.pets.find((item) => item.name === value);
							if (pet === undefined) return yield* invalid;
							const settings = yield* (yield* PetFoodRepository).getSettings(
								pet.id,
							);
							return ConversationBuilder.to('confirm', {
								...state,
								petId: pet.id,
								currentDayStart: settings?.dayStart ?? null,
								currentTimeZone: settings?.timeZone ?? null,
							});
						}),
					),
				),
			onInvalid: () => invalid,
		})
		.step('confirm', {
			enter: (state) =>
				required(
					reply(
						state.currentDayStart === null
							? 'Início do dia não configurado. Envie Alterar.'
							: `Valor atual: ${state.currentDayStart} (${state.currentTimeZone}). Envie Alterar.`,
					),
				),
			onInput: (state, value) =>
				required(
					value === 'Alterar'
						? Effect.succeed(
								ConversationBuilder.to('hour', {
									ownerId: state.ownerId,
									botId: state.botId,
									telegramUserId: state.telegramUserId,
									pets: state.pets,
									petId: state.petId,
								}),
							)
						: invalid,
				),
			onInvalid: () => invalid,
		})
		.step('hour', {
			enter: () => required(reply('Escolha a hora de 0h a 23h.')),
			onInput: (state, value) =>
				required(
					(() => {
						const match = /^(?:([0-9])|([01][0-9])|(2[0-3]))h$/u.exec(value);
						if (match === null) return invalid;
						const hour = Number(match[1] ?? match[2] ?? match[3]);
						return Effect.succeed(
							ConversationBuilder.to('timezone', {
								...state,
								dayStart: Schema.decodeUnknownSync(LocalTime)(
									`${String(hour).padStart(2, '0')}:00`,
								),
							}),
						);
					})(),
				),
			onInvalid: () => invalid,
		})
		.step('timezone', {
			enter: () =>
				required(reply('Envie o fuso horário, por exemplo America/Sao_Paulo.')),
			onInput: (state, value) =>
				required(
					widen(
						Effect.gen(function* () {
							const decoded = yield* Effect.result(
								Schema.decodeUnknownEffect(IanaTimeZone)(value),
							);
							if (decoded._tag === 'Failure') return yield* invalid;
							yield* ConfigureDayStart.execute(
								{
									ownerId: state.ownerId,
									botId: state.botId,
									telegramUserId: state.telegramUserId,
									petId: state.petId,
								},
								state.dayStart,
								decoded.success,
							);
							return ConversationBuilder.complete({
								afterCommit: reply('Início do dia configurado com sucesso!'),
							});
						}),
					),
				),
			onInvalid: () => invalid,
		}),
);

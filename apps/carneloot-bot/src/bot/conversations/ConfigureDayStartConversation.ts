import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import {
	Conversation,
	ConversationBuilder,
	ConversationChoice,
	ConversationInput,
	ConversationPrompt,
} from 'tfx';

import * as ConfigureDayStart from '../../application/ConfigureDayStart.js';
import { authorize } from '../../application/PetFoodAccess.js';
import { ApplicationError } from '../../domain/ApplicationError.js';
import { BotId, PetId, TelegramUserId, UserId } from '../../domain/Ids.js';
import { IanaTimeZone, LocalTime } from '../../domain/pet-food/FoodDateTime.js';
import { PetName } from '../../domain/Pet.js';
import { PetFoodRepository } from '../../ports/PetFoodRepository.js';
import { RegisteredUser } from '../Declaration.js';
import * as ConversationUi from './ConversationUi.js';

const PetOption = Schema.Struct({ id: PetId, name: PetName });
const Base = {
	actorId: UserId,
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
const alterChoice = ConversationChoice.reply(
	[{ label: 'Alterar', value: 'alter' as const }],
	{ cancelLabel: 'Cancelar' },
);
const hourChoice = ConversationChoice.reply(
	Array.from({ length: 24 }, (_, hour) => ({ label: `${hour}h`, value: hour })),
	{ columns: 4, cancelLabel: 'Cancelar' },
);
const petChoice = (state: typeof PetState.Type) =>
	ConversationChoice.reply(
		ConversationUi.uniqueReplyOptions(
			state.pets.map((pet) => ({ label: pet.name, value: pet.id })),
		),
		{ cancelLabel: 'Cancelar' },
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
			input: ConversationInput.choice(alterChoice),
		}),
		hour: Conversation.step('hour', {
			state: HourState,
			input: ConversationInput.choice(hourChoice),
		}),
		timezone: Conversation.step('timezone', {
			state: TimeZoneState,
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
				state.pets.length === 0
					? ConversationUi.replyRemovingKeyboard('Você não tem pets')
					: ConversationUi.promptChoice('Escolha o pet:', petChoice(state)),
			onInput: (state, value) =>
				Effect.gen(function* () {
					if (state.pets.length === 0)
						return ConversationBuilder.cancelled({
							afterCommit:
								ConversationUi.replyRemovingKeyboard('Você não tem pets'),
						});
					const result = yield* Effect.result(
						ConversationPrompt.resolve(petChoice(state), value),
					);
					if (result._tag === 'Failure')
						return ConversationBuilder.stay({
							afterCommit: ConversationUi.reply('Por favor, escolha uma opção'),
						});
					const selected = result.success;
					if (selected._tag === 'Cancelled')
						return ConversationBuilder.cancelled({
							afterCommit: ConversationUi.replyRemovingKeyboard(
								'Operação cancelada.',
							),
						});
					const pet = state.pets.find((item) => item.id === selected.value);
					if (pet === undefined)
						return ConversationBuilder.stay({
							afterCommit: ConversationUi.reply('Por favor, escolha uma opção'),
						});
					yield* authorize({
						actorId: state.actorId,
						botId: state.botId,
						telegramUserId: state.telegramUserId,
						petId: pet.id,
					});
					const food = yield* PetFoodRepository;
					const settings = yield* food.getSettings(pet.id);
					return ConversationBuilder.to('confirm', {
						...state,
						petId: pet.id,
						currentDayStart: settings?.dayStart ?? null,
						currentTimeZone: settings?.timeZone ?? null,
					});
				}),
			onInvalid: () =>
				Effect.succeed(
					ConversationBuilder.stay({
						afterCommit: ConversationUi.reply('Por favor, escolha uma opção'),
					}),
				),
		})
		.step('confirm', {
			enter: (state) =>
				ConversationUi.promptChoice(
					state.currentDayStart === null
						? 'Início do dia não configurado.'
						: `Valor atual: ${state.currentDayStart} (${state.currentTimeZone}).`,
					alterChoice,
				),
			onInput: (state, selected) =>
				selected._tag === 'Cancelled'
					? Effect.succeed(
							ConversationBuilder.cancelled({
								afterCommit: ConversationUi.replyRemovingKeyboard(
									'Operação cancelada.',
								),
							}),
						)
					: selected.value === 'alter'
						? Effect.succeed(
								ConversationBuilder.to('hour', {
									actorId: state.actorId,
									botId: state.botId,
									telegramUserId: state.telegramUserId,
									pets: state.pets,
									petId: state.petId,
								}),
							)
						: Effect.succeed(
								ConversationBuilder.stay({
									afterCommit: ConversationUi.reply(
										'Por favor, escolha uma opção',
									),
								}),
							),
			onInvalid: () =>
				Effect.succeed(
					ConversationBuilder.stay({
						afterCommit: ConversationUi.reply('Por favor, escolha uma opção'),
					}),
				),
		})
		.step('hour', {
			enter: () =>
				ConversationUi.promptChoice('Escolha a hora de 0h a 23h.', hourChoice),
			onInput: (state, selected) =>
				selected._tag === 'Cancelled'
					? Effect.succeed(
							ConversationBuilder.cancelled({
								afterCommit: ConversationUi.replyRemovingKeyboard(
									'Operação cancelada.',
								),
							}),
						)
					: Effect.succeed(
							ConversationBuilder.to('timezone', {
								...state,
								dayStart: Schema.decodeUnknownSync(LocalTime)(
									`${String(selected.value).padStart(2, '0')}:00`,
								),
							}),
						),
			onInvalid: () =>
				Effect.succeed(
					ConversationBuilder.stay({
						afterCommit: ConversationUi.reply('Por favor, escolha uma opção'),
					}),
				),
		})
		.step('timezone', {
			enter: () =>
				ConversationUi.replyRemovingKeyboard(
					'Envie o fuso horário, por exemplo America/Sao_Paulo.',
				),
			onInput: (state, value) =>
				Effect.gen(function* () {
					const decoded = yield* Effect.result(
						Schema.decodeUnknownEffect(IanaTimeZone)(value),
					);
					if (decoded._tag === 'Failure')
						return ConversationBuilder.stay({
							afterCommit: ConversationUi.reply('Por favor, escolha uma opção'),
						});
					yield* ConfigureDayStart.execute(
						{
							actorId: state.actorId,
							botId: state.botId,
							telegramUserId: state.telegramUserId,
							petId: state.petId,
						},
						state.dayStart,
						decoded.success,
					);
					return ConversationBuilder.complete({
						afterCommit: ConversationUi.replyRemovingKeyboard(
							'Início do dia configurado com sucesso!',
						),
					});
				}),
			onInvalid: () =>
				Effect.succeed(
					ConversationBuilder.stay({
						afterCommit: ConversationUi.reply('Por favor, escolha uma opção'),
					}),
				),
		}),
);

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
	UpdateContext,
} from 'tfx';

import * as AddFood from '../../application/AddFood.js';
import { authorize } from '../../application/PetFoodAccess.js';
import { ApplicationError } from '../../domain/ApplicationError.js';
import { InvalidDomainInput } from '../../domain/DomainError.js';
import {
	BotId,
	PetId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../../domain/Ids.js';
import { IanaTimeZone } from '../../domain/pet-food/FoodDateTime.js';
import { FoodInput } from '../../domain/pet-food/FoodWhenInput.js';
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
const AmountState = Schema.Struct({
	...Base,
	petId: PetId,
	petName: PetName,
	timeZone: IanaTimeZone,
});
const Text = ConversationInput.text(Schema.String);
const petChoice = (state: typeof PetState.Type) =>
	ConversationChoice.reply(
		ConversationUi.uniqueReplyOptions(
			state.pets.map((pet) => ({ label: pet.name, value: pet.id })),
		),
		{ cancelLabel: 'Cancelar' },
	);
const amountPrompt =
	'Envie a quantidade e, opcionalmente, o horário (HH:mm, DD/MM[/AAAA] HH:mm ou -5min para 5 minutos antes desta mensagem).';

export const declaration = Conversation.make('add-pet-food', {
	version: 1,
	startup: PetState,
	initialStep: 'pet',
	initialize: (state) => state,
	steps: {
		pet: Conversation.step('pet', { state: PetState, input: Text }),
		amount: Conversation.step('amount', {
			state: AmountState,
			input: ConversationInput.text(FoodInput),
		}),
	},
	middleware: [RegisteredUser],
	idleTimeout: 15 * 60 * 1_000,
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
					const pet = state.pets.find(
						(candidate) => candidate.id === selected.value,
					);
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
					if (
						settings?.dayStart === null ||
						settings?.timeZone === null ||
						settings === undefined
					)
						return ConversationBuilder.stay({
							afterCommit: ConversationUi.reply(
								`Você não configurou o início do dia para o pet ${pet.name}.`,
							),
						});
					return ConversationBuilder.to('amount', {
						...state,
						petId: pet.id,
						petName: pet.name,
						timeZone: settings.timeZone,
					});
				}),
			onInvalid: () =>
				Effect.succeed(
					ConversationBuilder.stay({
						afterCommit: ConversationUi.reply('Por favor, escolha uma opção'),
					}),
				),
		})
		.step('amount', {
			enter: () => ConversationUi.replyRemovingKeyboard(amountPrompt),
			onInput: (state, value) =>
				Effect.gen(function* () {
					const context = yield* MessageContext.MessageContext;
					const update = yield* UpdateContext.UpdateContext;
					const messageChatId = yield* Schema.decodeUnknownEffect(
						TelegramChatId,
					)(context.chatId).pipe(
						Effect.mapError(
							(cause) =>
								new InvalidDomainInput({
									message: 'Invalid source chat id',
									cause,
								}),
						),
					);
					const result = yield* Effect.result(
						AddFood.execute(
							{
								actorId: state.actorId,
								botId: state.botId,
								telegramUserId: state.telegramUserId,
								petId: state.petId,
							},
							{
								amountMg: value.amountMg,
								when: value.when,
								messageDate: DateTime.makeUnsafe(context.message.date * 1_000),
							},
							{
								botId: state.botId,
								updateId: update.updateId,
								messageChatId,
								messageId: context.messageId,
							},
						),
					);
					if (result._tag === 'Failure') {
						if (result.failure._tag === 'DuplicateFoodEntry')
							return ConversationBuilder.stay({
								afterCommit: ConversationUi.reply(
									'Já existe um registro de ração nesse horário.',
								),
							});
						if (result.failure._tag === 'PetFoodSetupMissing')
							return ConversationBuilder.stay({
								afterCommit: ConversationUi.reply(
									`Você não configurou o início do dia para o pet ${state.petName}.`,
								),
							});
						return ConversationBuilder.stay({
							afterCommit: ConversationUi.reply(
								`Formato inválido. ${amountPrompt}`,
							),
						});
					}
					const grams = result.success.entry.amountMg / 1_000;
					const amountText = `${Number.isInteger(grams) ? grams : grams.toFixed(3).replace(/0+$/u, '').replace(/\.$/u, '')} g`;
					const base = `Foram adicionados ${amountText} de ração para o pet ${state.petName}.`;
					let text = base;
					if (!result.success.latest) {
						const parts = DateTime.toParts(
							DateTime.makeZonedUnsafe(result.success.entry.fedAt, {
								timeZone: state.timeZone,
							}),
						);
						const timestamp = `${String(parts.day).padStart(2, '0')}/${String(parts.month).padStart(2, '0')}/${parts.year} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
						text = `${base} Horário: ${timestamp}.`;
					}
					return ConversationBuilder.complete({
						afterCommit: Effect.andThen(
							ConversationUi.replyRemovingKeyboard(text),
							context.react([{ type: 'emoji', emoji: '👍' }]),
						),
					});
				}),
			onInvalid: () =>
				Effect.succeed(
					ConversationBuilder.stay({
						afterCommit: ConversationUi.replyRemovingKeyboard(
							`Formato inválido. ${amountPrompt}`,
						),
					}),
				),
		}),
);

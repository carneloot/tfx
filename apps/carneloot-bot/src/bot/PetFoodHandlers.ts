import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import { Conversations, MessageContext, UpdateContext } from 'tfx';

import * as AddFoodToAll from '../application/AddFoodToAll.js';
import * as GetFoodStatus from '../application/GetFoodStatus.js';
import * as ListPets from '../application/ListPets.js';
import { ConversationOperationError } from '../domain/ApplicationError.js';
import type { Pet } from '../domain/Pet.js';
import type { RegisteredUser } from '../domain/User.js';
import { PetRepository } from '../ports/PetRepository.js';
import * as AddFoodConversation from './conversations/AddFoodConversation.js';
import * as ConfigureDayStartConversation from './conversations/ConfigureDayStartConversation.js';
import * as ConfigureReminderDelayConversation from './conversations/ConfigureReminderDelayConversation.js';
import { CurrentUser } from './CurrentUser.js';
import { botId } from './Declaration.js';

const input = (current: RegisteredUser, pets: ReadonlyArray<Pet>) => ({
	actorId: current.user.id,
	botId: current.profile.botId,
	telegramUserId: current.profile.telegramUserId,
	pets: pets.map(({ id, name }) => ({ id, name })),
});

const start = (
	built:
		| typeof ConfigureDayStartConversation.built
		| typeof ConfigureReminderDelayConversation.built,
) =>
	Effect.gen(function* () {
		const current = yield* CurrentUser;
		const repository = yield* PetRepository;
		const pets = yield* repository.listOwned(current.user.id);
		const context = yield* MessageContext.MessageContext;
		if (pets.length === 0) {
			yield* context.reply('Você não tem pets');
			return;
		}
		const update = yield* UpdateContext.UpdateContext;
		if (update.chatId === undefined || update.userId === undefined)
			return yield* Effect.fail(
				new ConversationOperationError({
					message: 'Missing conversation scope',
					cause: { _tag: 'MissingConversationScope' },
				}),
			);
		const conversations = yield* Conversations.Conversations;
		yield* conversations
			.start(built, input(current, pets), {
				scope: { botId, chatId: update.chatId, userId: update.userId },
				conflict: 'replace',
			})
			.pipe(
				Effect.mapError(
					(cause) =>
						new ConversationOperationError({
							message: 'Could not start configuration conversation',
							cause,
						}),
				),
			);
	});

export const startConfigureDayStart = start(
	ConfigureDayStartConversation.built,
);
export const startConfigureReminderDelay = start(
	ConfigureReminderDelayConversation.built,
);

const elapsed = (now: DateTime.Utc, then: DateTime.Utc) => {
	const minutes = Math.floor(Duration.toMinutes(DateTime.distance(then, now)));
	if (minutes < 1) return 'menos de 1 minuto';
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	const parts: Array<string> = [];
	if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'hora' : 'horas'}`);
	if (remainder > 0)
		parts.push(`${remainder} ${remainder === 1 ? 'minuto' : 'minutos'}`);
	return parts.join(' e ');
};
const grams = (milligrams: number) => {
	const value = milligrams / 1_000;
	return Number.isInteger(value)
		? String(value)
		: value.toFixed(3).replace(/0+$/u, '').replace(/\.$/u, '');
};
export const foodStatus = Effect.gen(function* () {
	const current = yield* CurrentUser;
	const statuses = yield* GetFoodStatus.execute({
		actorId: current.user.id,
		botId: current.profile.botId,
		telegramUserId: current.profile.telegramUserId,
	});
	const context = yield* MessageContext.MessageContext;
	if (statuses.length === 0) {
		yield* context.reply('Você não tem pets');
		return;
	}
	const now = yield* DateTime.now;
	const lines = statuses.map((status) => {
		if (status._tag === 'MissingDayStart')
			return `Você não configurou o início do dia para o pet ${status.pet.name}.`;
		if (status.latestFedAt === null)
			return `- ${status.pet.name}: 0 g, nenhuma ração hoje`;
		return `- ${status.pet.name}: ${grams(status.totalMg)} g, última vez há ${elapsed(now, status.latestFedAt)}`;
	});
	yield* context.reply(lines.join('\n'));
});

export const addFoodToAll = (input: {
	readonly amount: import('../domain/pet-food/FoodAmount.js').FoodAmount;
	readonly when?: string;
}) =>
	Effect.gen(function* () {
		const current = yield* CurrentUser;
		const context = yield* MessageContext.MessageContext;
		const update = yield* UpdateContext.UpdateContext;
		const result = yield* AddFoodToAll.execute(
			{
				actorId: current.user.id,
				botId: current.profile.botId,
				telegramUserId: current.profile.telegramUserId,
			},
			{
				amountMg: input.amount,
				when: input.when ?? '',
				messageDate: DateTime.makeUnsafe(context.message.date * 1_000),
			},
			{
				botId: current.profile.botId,
				updateId: update.updateId,
				messageChatId: context.chatId,
				messageId: context.messageId,
			},
		);
		if (result.items.length === 0) {
			yield* context.reply('Você não possui nenhum pet.');
			return;
		}
		const names = (tag: AddFoodToAll.AddFoodToAllItem['_tag']) =>
			result.items
				.filter((item) => item._tag === tag)
				.map((item) => item.pet.name)
				.join(', ');
		const successful = result.items.filter(
			(item) => item._tag === 'Added' || item._tag === 'Replayed',
		);
		const lines: Array<string> = [];
		if (successful.length > 0)
			lines.push(
				`Ração registrada para ${successful.length} ${successful.length === 1 ? 'pet' : 'pets'}: ${successful.map((item) => item.pet.name).join(', ')}.`,
			);
		const setupMissing = names('SetupMissing');
		if (setupMissing !== '')
			lines.push(`Configuração pendente: ${setupMissing} (início do dia).`);
		const duplicates = names('Duplicate');
		if (duplicates !== '')
			lines.push(`Ignorados: ${duplicates} (registro duplicado).`);
		const accessLost = names('AccessLost');
		if (accessLost !== '') lines.push(`Acesso perdido: ${accessLost}.`);
		yield* context.reply(lines.join('\n'));
		if (successful.length > 0)
			yield* context.react([{ type: 'emoji', emoji: '👍' }]);
	});

export const startAddFood = Effect.gen(function* () {
	const current = yield* CurrentUser;
	const pets = (yield* ListPets.execute(current.user.id)).map(({ pet }) => pet);
	const context = yield* MessageContext.MessageContext;
	if (pets.length === 0) {
		yield* context.reply('Você não tem pets');
		return;
	}
	const update = yield* UpdateContext.UpdateContext;
	if (update.chatId === undefined || update.userId === undefined)
		return yield* Effect.fail(
			new ConversationOperationError({
				message: 'Missing conversation scope',
				cause: { _tag: 'MissingConversationScope' },
			}),
		);
	const conversations = yield* Conversations.Conversations;
	yield* conversations
		.start(AddFoodConversation.built, input(current, pets), {
			scope: { botId, chatId: update.chatId, userId: update.userId },
			conflict: 'replace',
		})
		.pipe(
			Effect.mapError(
				(cause) =>
					new ConversationOperationError({
						message: 'Could not start add-food conversation',
						cause,
					}),
			),
		);
});

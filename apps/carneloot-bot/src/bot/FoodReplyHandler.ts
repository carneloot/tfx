import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { MessageContext, MessageHandlerResult, UpdateContext } from 'tfx';

import * as RouteFoodReply from '../application/RouteFoodReply.js';
import { InvalidDomainInput } from '../domain/DomainError.js';
import { BotId, TelegramChatId, TelegramUserId } from '../domain/Ids.js';
import { UserRepository } from '../ports/UserRepository.js';
import { CurrentUser } from './CurrentUser.js';
import { botId } from './Declaration.js';

export const handle = (input: {
	readonly text: string;
	readonly repliedMessageId: number;
}) =>
	Effect.gen(function* () {
		const update = yield* UpdateContext.UpdateContext;
		const context = yield* MessageContext.MessageContext;
		const sender = context.message.from;
		if (sender === undefined) return MessageHandlerResult.unmatched;
		const repository = yield* UserRepository;
		const telegramUserId = yield* Schema.decodeUnknownEffect(TelegramUserId)(
			sender.id,
		).pipe(
			Effect.mapError(
				(cause) =>
					new InvalidDomainInput({
						message: 'Invalid Telegram user id',
						cause,
					}),
			),
		);
		const current = yield* repository
			.findByTelegram(Schema.decodeUnknownSync(BotId)(botId), telegramUserId)
			.pipe(
				Effect.catchTag('UserNotRegistered', () => Effect.succeed(undefined)),
			);
		// Unregistered replies cannot mutate food. Let unrelated text reach public
		// handlers instead of turning every reply into a registration prompt.
		if (current === undefined) return MessageHandlerResult.unmatched;
		const chatId = yield* Schema.decodeUnknownEffect(TelegramChatId)(
			context.chatId,
		).pipe(
			Effect.mapError(
				(cause) =>
					new InvalidDomainInput({
						message: 'Invalid Telegram chat id',
						cause,
					}),
			),
		);
		const result = yield* RouteFoodReply.execute({
			actorId: current.user.id,
			botId: current.profile.botId,
			telegramUserId: current.profile.telegramUserId,
			chatId,
			updateId: update.updateId,
			messageId: context.messageId,
			messageDate: DateTime.makeUnsafe(context.message.date * 1_000),
			repliedMessageId: input.repliedMessageId,
			text: input.text,
		}).pipe(Effect.provideService(CurrentUser, current));
		switch (result._tag) {
			case 'Unrelated':
				return MessageHandlerResult.unmatched;
			case 'ReminderFoodAdded':
				yield* context.reply(`Ração registrada para ${result.pet.name}.`);
				yield* context.react([{ type: 'emoji', emoji: '👍' }]);
				return MessageHandlerResult.handled;
			case 'FoodCorrected':
				yield* context.reply('Rações atualizadas com sucesso!');
				return MessageHandlerResult.handled;
			case 'InvalidInput':
				yield* context.reply(result.message);
				return MessageHandlerResult.handled;
		}
	});

import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { MessageContext, MessageHandlerResult, UpdateContext } from 'tfx';

import * as RouteNotificationReply from '../application/RouteNotificationReply.js';
import { InvalidDomainInput } from '../domain/DomainError.js';
import { TelegramChatId } from '../domain/Ids.js';
import { CurrentUser } from './CurrentUser.js';

export const handle = (input: {
	readonly text: string;
	readonly repliedMessageId: number;
}) =>
	Effect.gen(function* () {
		const current = yield* CurrentUser;
		const update = yield* UpdateContext.UpdateContext;
		const context = yield* MessageContext.MessageContext;
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
		const result = yield* RouteNotificationReply.execute({
			actorId: current.user.id,
			botId: current.profile.botId,
			telegramUserId: current.profile.telegramUserId,
			chatId,
			updateId: update.updateId,
			messageId: context.messageId,
			messageDate: DateTime.makeUnsafe(context.message.date * 1_000),
			repliedMessageId: input.repliedMessageId,
			text: input.text,
		});
		switch (result._tag) {
			case 'Unrelated':
				return MessageHandlerResult.unmatched;
			case 'NotificationForwarded':
				return MessageHandlerResult.handled;
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

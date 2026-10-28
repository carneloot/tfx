import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { MessageContext, MessageHandlerResult, UpdateContext } from 'tfx';

import * as RouteNotificationReply from '../application/RouteNotificationReply.js';
import { InvalidDomainInput } from '../domain/DomainError.js';
import { BotId, TelegramChatId, TelegramUserId } from '../domain/Ids.js';
import { botId } from './Declaration.js';

/** No registration middleware: unrelated replies must reach later message handlers. */
export const handle = (input: {
	readonly text: string;
	readonly repliedMessageId: number;
}) =>
	Effect.gen(function* () {
		const context = yield* MessageContext.MessageContext;
		const update = yield* UpdateContext.UpdateContext;
		if (context.message.from === undefined)
			return MessageHandlerResult.unmatched;
		const identity = yield* Schema.decodeUnknownEffect(
			Schema.Struct({
				botId: BotId,
				chatId: TelegramChatId,
				telegramUserId: TelegramUserId,
			}),
		)({
			botId,
			chatId: context.chatId,
			telegramUserId: context.message.from.id,
		}).pipe(
			Effect.mapError(
				() => new InvalidDomainInput({ message: 'Invalid Telegram identity' }),
			),
		);
		const result = yield* RouteNotificationReply.execute({
			...identity,
			...input,
			updateId: update.updateId,
		});
		if (result._tag === 'Unrelated') return MessageHandlerResult.unmatched;
		if (result._tag === 'Rejected') yield* context.reply(result.message);
		return MessageHandlerResult.handled;
	});

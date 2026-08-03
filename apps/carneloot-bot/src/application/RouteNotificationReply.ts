import * as Effect from 'effect/Effect';
import { Telegram } from 'tfx/Telegram';

import { DomainPersistenceError } from '../domain/DomainError.js';
import { NotificationReplyRejected } from '../domain/notifications/NotificationReplyError.js';
import { NotificationRepository } from '../ports/NotificationRepository.js';
import * as RouteFoodReply from './RouteFoodReply.js';

export type NotificationReplyResult =
	| RouteFoodReply.FoodReplyResult
	| { readonly _tag: 'NotificationForwarded' };

const persistenceError = (error: {
	readonly reason: string;
	readonly message: string;
}) =>
	new DomainPersistenceError({
		reason:
			error.reason === 'PersistenceFailure'
				? 'PersistenceFailure'
				: 'InvariantViolation',
		message: error.message,
		cause: error,
	});

/** Routes external notification replies before preserving food reply behavior. */
export const execute = Effect.fn('RouteNotificationReply.execute')(
	function* (input: RouteFoodReply.RouteFoodReplyInput) {
		const notifications = yield* NotificationRepository;
		const context = yield* notifications
			.findSentByTelegramMessage(
				input.botId,
				input.chatId,
				input.repliedMessageId,
			)
			.pipe(Effect.mapError(persistenceError));
		if (
			context?.event.kind !== 'external-notification' ||
			context.delivery.recipientUserId !== input.actorId
		)
			return yield* RouteFoodReply.execute(input);
		if (context.delivery.recipientRole === 'owner')
			return yield* Effect.fail(
				new NotificationReplyRejected({
					reason: 'OwnerSelfReply',
					message: 'Owner cannot reply to their own notification',
				}),
			);
		if (context.delivery.recipientRole !== 'subscriber')
			return yield* RouteFoodReply.execute(input);

		const owner = yield* notifications
			.findSentOwnerByEvent(context.event.id)
			.pipe(Effect.mapError(persistenceError));
		if (
			owner === undefined ||
			owner.recipientChatId === null ||
			owner.telegramMessageId === null
		)
			return yield* RouteFoodReply.execute(input);
		const telegram = yield* Telegram;
		yield* telegram.sendMessage({
			chat_id: owner.recipientChatId,
			text: input.text,
			reply_parameters: { message_id: owner.telegramMessageId },
		});
		return { _tag: 'NotificationForwarded' } as const;
	},
);

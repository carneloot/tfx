import * as Crypto from 'effect/Crypto';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

import { DomainPersistenceError } from '../domain/DomainError.js';
import type { BotId, TelegramChatId, TelegramUserId } from '../domain/Ids.js';
import { DeliveryId } from '../domain/notifications/NotificationDelivery.js';
import { EventId } from '../domain/notifications/NotificationEvent.js';
import { owner } from '../domain/notifications/RecipientRole.js';
import { ExternalNotificationRepository } from '../ports/ExternalNotificationRepository.js';
import { NotificationRepository } from '../ports/NotificationRepository.js';
import { UserRepository } from '../ports/UserRepository.js';
import * as Dispatch from './DispatchNotificationDelivery.js';

export const execute = Effect.fn('RouteNotificationReply.execute')(
	function* (input: {
		readonly botId: BotId;
		readonly chatId: TelegramChatId;
		readonly telegramUserId: TelegramUserId;
		readonly repliedMessageId: number;
		readonly updateId: number;
		readonly text: string;
	}) {
		const notifications = yield* NotificationRepository;
		const context = yield* notifications.findSentByTelegramMessage(
			input.botId,
			input.chatId,
			input.repliedMessageId,
		);
		if (context?.event.kind !== 'external')
			return { _tag: 'Unrelated' as const };
		const users = yield* UserRepository;
		const actor = yield* users
			.findByTelegram(input.botId, input.telegramUserId)
			.pipe(
				Effect.catchTag('UserNotRegistered', () => Effect.succeed(undefined)),
			);
		if (
			actor === undefined ||
			actor.user.id !== context.delivery.recipientUserId
		)
			return {
				_tag: 'Rejected' as const,
				message: 'Esta notificação não pertence a você.',
			};
		if (actor.user.id === context.event.ownerUserId)
			return {
				_tag: 'Rejected' as const,
				message: 'Você não pode responder a sua própria notificação.',
			};
		if (context.delivery.recipientRole !== 'subscriber')
			return { _tag: 'Unrelated' as const };
		const external = yield* ExternalNotificationRepository;
		const target = yield* external.ownerMessage(context.event.id, input.botId);
		if (target === undefined)
			return {
				_tag: 'Rejected' as const,
				message: 'A mensagem original do proprietário não está disponível.',
			};
		const display = [actor.profile.firstName, actor.profile.lastName]
			.filter((value) => value !== null && value.length > 0)
			.join(' ');
		const text = `${display}${actor.profile.username === null ? '' : ` (@${actor.profile.username})`}: ${input.text}`;
		if (text.length > 4096)
			return {
				_tag: 'Rejected' as const,
				message: 'A resposta é longa demais.',
			};
		const crypto = yield* Crypto.Crypto;
		const eventId = yield* external.create(
			{
				id: Schema.decodeUnknownSync(EventId)(
					yield* crypto.randomUUIDv4().pipe(Effect.orDie),
				),
				botId: input.botId,
				kind: 'external-reply',
				ownerUserId: context.event.ownerUserId,
				petId: null,
				foodEntryId: null,
				scheduledFor: null,
				foodTimestampExplicit: false,
				dedupeKey: `external-reply:${input.botId}:${input.chatId}:${input.updateId}`,
				now: yield* DateTime.now,
			},
			null,
			text,
			[
				{
					_tag: 'Reachable',
					id: Schema.decodeUnknownSync(DeliveryId)(
						yield* crypto.randomUUIDv4().pipe(Effect.orDie),
					),
					recipientUserId: context.event.ownerUserId,
					recipientRole: owner,
					channel: 'telegram',
					recipientChatId: target.chatId,
				},
			],
			target.messageId,
		);
		const payload = yield* external.payload(eventId);
		if (payload === undefined || payload.replyToMessageId === null)
			return {
				_tag: 'Rejected' as const,
				message: 'A resposta original não está disponível.',
			};
		yield* notifications.recoverExpired(eventId, yield* DateTime.now);
		const claim = yield* notifications.claimNext(
			eventId,
			yield* DateTime.now,
			Duration.seconds(30),
		);
		if (claim !== undefined) {
			const status = yield* Dispatch.executeExternalClaim(
				input.botId,
				payload.text,
				claim,
				payload.replyToMessageId,
			);
			yield* notifications
				.summarizeAndComplete(eventId, yield* DateTime.now)
				.pipe(Effect.result);
			return { _tag: 'Routed' as const, status };
		}
		const result = yield* external.result(eventId);
		return { _tag: 'Routed' as const, status: result.status };
	},
	(effect) =>
		effect.pipe(
			Effect.mapError(
				() =>
					new DomainPersistenceError({
						reason: 'PersistenceFailure',
						message: 'Notification reply persistence failed',
					}),
			),
		),
);

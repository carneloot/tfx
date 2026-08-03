import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { Telegram } from 'tfx/Telegram';
import { describe, expect, it } from 'vitest';

import * as RouteNotificationReply from '../../src/application/RouteNotificationReply.js';
import {
	BotId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../../src/domain/Ids.js';
import { DeliveryId } from '../../src/domain/notifications/NotificationDelivery.js';
import { EventId } from '../../src/domain/notifications/NotificationEvent.js';
import { NotificationRepository } from '../../src/ports/NotificationRepository.js';

const botId = Schema.decodeUnknownSync(BotId)('carneloot');
const ownerId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000001',
);
const subscriberId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000002',
);
const eventId = Schema.decodeUnknownSync(EventId)(
	'00000000-0000-4000-8000-000000000003',
);
const deliveryId = Schema.decodeUnknownSync(DeliveryId)(
	'00000000-0000-4000-8000-000000000004',
);
const ownerDeliveryId = Schema.decodeUnknownSync(DeliveryId)(
	'00000000-0000-4000-8000-000000000005',
);
const input = {
	actorId: subscriberId,
	botId,
	telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(2),
	chatId: Schema.decodeUnknownSync(TelegramChatId)(200),
	updateId: 1,
	messageId: 2,
	messageDate: DateTime.makeUnsafe('2026-07-16T12:00:00Z'),
	repliedMessageId: 10,
	text: 'Recebi, obrigado.',
};
const event = {
	id: eventId,
	botId,
	kind: 'external-notification',
	ownerUserId: ownerId,
	petId: null,
	foodEntryId: null,
	scheduledFor: null,
	status: 'completed' as const,
	dedupeKey: 'event',
	jobId: null,
	recipientsMaterializedAt: null,
	foodTimestampExplicit: false,
	createdAt: DateTime.makeUnsafe(0),
	updatedAt: DateTime.makeUnsafe(0),
	completedAt: null,
	cancelledAt: null,
};
const delivery = (
	recipientUserId: typeof UserId.Type,
	role: 'owner' | 'subscriber',
) => ({
	id: role === 'owner' ? ownerDeliveryId : deliveryId,
	eventId,
	recipientUserId,
	recipientChatId: Schema.decodeUnknownSync(TelegramChatId)(
		role === 'owner' ? 100 : 200,
	),
	recipientRole: role,
	channel: 'telegram' as const,
	status: 'sent' as const,
	attemptGeneration: 1,
	attemptCount: 1,
	sendingStartedAt: null,
	sendingLeaseExpiresAt: null,
	retryAt: null,
	retryable: false,
	telegramBotId: botId,
	telegramMessageId: role === 'owner' ? 20 : 10,
	safeError: null,
	sentAt: DateTime.makeUnsafe(0),
	failedAt: null,
	unknownAt: null,
	createdAt: DateTime.makeUnsafe(0),
	updatedAt: DateTime.makeUnsafe(0),
});

const run = (
	context:
		| {
				readonly delivery: ReturnType<typeof delivery>;
				readonly event: typeof event;
		  }
		| undefined,
	sent: unknown[],
	owner: ReturnType<typeof delivery> | null = delivery(ownerId, 'owner'),
) =>
	Effect.runPromise(
		RouteNotificationReply.execute(input).pipe(
			Effect.provide(
				Layer.merge(
					Layer.succeed(NotificationRepository, {
						findSentByTelegramMessage: () => Effect.succeed(context),
						findSentOwnerByEvent: () => Effect.succeed(owner ?? undefined),
					} as never),
					Layer.succeed(Telegram, {
						sendMessage: (message: unknown) => {
							sent.push(message);
							return Effect.succeed({ message_id: 21 });
						},
					} as never),
				),
			),
		) as never,
	);

describe('RouteNotificationReply', () => {
	it('forwards subscriber text as a reply to same event owner message', async () => {
		const sent: unknown[] = [];
		await expect(
			run({ delivery: delivery(subscriberId, 'subscriber'), event }, sent),
		).resolves.toEqual({
			_tag: 'NotificationForwarded',
		});
		expect(sent).toEqual([
			{
				chat_id: 100,
				text: 'Recebi, obrigado.',
				reply_parameters: { message_id: 20 },
			},
		]);
	});

	it('returns Unrelated when external subscriber reply has no sent owner', async () => {
		const sent: unknown[] = [];
		await expect(
			run(
				{ delivery: delivery(subscriberId, 'subscriber'), event },
				sent,
				null,
			),
		).resolves.toEqual({ _tag: 'Unrelated' });
		expect(sent).toEqual([]);
	});

	it('returns typed permanent rejection for owner self-reply', async () => {
		const sent: unknown[] = [];
		const result = await Effect.runPromise(
			Effect.flip(
				RouteNotificationReply.execute({ ...input, actorId: ownerId }).pipe(
					Effect.provide(
						Layer.merge(
							Layer.succeed(NotificationRepository, {
								findSentByTelegramMessage: () =>
									Effect.succeed({
										delivery: delivery(ownerId, 'owner'),
										event,
									}),
							} as never),
							Layer.succeed(Telegram, {
								sendMessage: () => Effect.die('unexpected'),
							} as never),
						),
					),
				),
			) as never,
		);
		expect(result).toMatchObject({
			_tag: 'NotificationReplyRejected',
			reason: 'OwnerSelfReply',
		});
		expect(sent).toEqual([]);
	});
});

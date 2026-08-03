import { Effect, Layer, Schema } from 'effect';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import { describe, expect, it } from 'vitest';

import { BotId, TelegramChatId, TelegramUserId } from '../../src/domain/Ids.js';
import { DeliveryId } from '../../src/domain/notifications/NotificationDelivery.js';
import { EventId } from '../../src/domain/notifications/NotificationEvent.js';
import {
	owner,
	subscriber,
} from '../../src/domain/notifications/RecipientRole.js';
import { NotificationRepository } from '../../src/ports/NotificationRepository.js';
import { UserRepository } from '../../src/ports/UserRepository.js';
import * as RepositoriesLive from '../../src/postgres/RepositoriesLive.js';
import * as DeterministicCrypto from '../internal/DeterministicCrypto.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const layer = Layer.provideMerge(
	RepositoriesLive.layer,
	Layer.merge(PostgresTestLayer.layer, DeterministicCrypto.layer()),
);
const botId = Schema.decodeUnknownSync(BotId)('carneloot');
const eventId = () => Schema.decodeUnknownSync(EventId)(crypto.randomUUID());
const deliveryId = () =>
	Schema.decodeUnknownSync(DeliveryId)(crypto.randomUUID());

if (!enabled)
	describe.skip('RouteNotificationReply PostgreSQL', () =>
		it('requires database', () => {}));
else
	describe('RouteNotificationReply PostgreSQL', () => {
		it('finds sent subscriber reply context and sent owner for same external event', async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const users = yield* UserRepository;
					const base = Math.floor(Math.random() * 1_000_000) + 30_000_000;
					const registeredOwner = yield* users.registerTelegramProfile({
						botId,
						telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(base),
						username: null,
						firstName: 'owner',
						lastName: null,
						privateChatId: Schema.decodeUnknownSync(TelegramChatId)(base),
					});
					const registeredSubscriber = yield* users.registerTelegramProfile({
						botId,
						telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(base + 1),
						username: null,
						firstName: 'subscriber',
						lastName: null,
						privateChatId: Schema.decodeUnknownSync(TelegramChatId)(base + 1),
					});
					const notifications = yield* NotificationRepository;
					const created = yield* notifications.createExternalEvent(
						{
							id: eventId(),
							botId,
							kind: 'external-notification',
							ownerUserId: registeredOwner.user.id,
							petId: null,
							foodEntryId: null,
							scheduledFor: null,
							foodTimestampExplicit: false,
							dedupeKey: `reply-${crypto.randomUUID()}`,
							now: DateTime.makeUnsafe(1_000),
						},
						{ templateId: null, renderedMessage: 'message' },
						[
							{
								_tag: 'Reachable',
								id: deliveryId(),
								recipientUserId: registeredOwner.user.id,
								recipientChatId: registeredOwner.profile.privateChatId,
								recipientRole: owner,
								channel: 'telegram',
							},
							{
								_tag: 'Reachable',
								id: deliveryId(),
								recipientUserId: registeredSubscriber.user.id,
								recipientChatId: registeredSubscriber.profile.privateChatId,
								recipientRole: subscriber,
								channel: 'telegram',
							},
						],
					);
					for (const messageId of [101, 102]) {
						const claim = yield* notifications.claimNext(
							created.event.id,
							DateTime.makeUnsafe(1_001),
							Duration.seconds(30),
						);
						if (claim === undefined) throw new Error('missing delivery claim');
						yield* notifications.finalizeSent(
							claim.token,
							botId,
							messageId,
							DateTime.makeUnsafe(1_002),
						);
					}
					const context = yield* notifications.findSentByTelegramMessage(
						botId,
						registeredSubscriber.profile.privateChatId,
						102,
					);
					const sentOwner = yield* notifications.findSentOwnerByEvent(
						created.event.id,
					);
					return { context, sentOwner };
				}).pipe(Effect.provide(layer)),
			);
			expect(result.context).toMatchObject({
				event: { kind: 'external-notification' },
				delivery: { recipientRole: 'subscriber', status: 'sent' },
			});
			expect(result.sentOwner).toMatchObject({
				recipientRole: 'owner',
				telegramMessageId: 101,
				status: 'sent',
			});
		});
	});

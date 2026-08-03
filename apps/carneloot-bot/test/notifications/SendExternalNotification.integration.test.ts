import { Effect, Layer, Schema } from 'effect';
import * as DateTime from 'effect/DateTime';
import { describe, expect, it } from 'vitest';

import { BotId, TelegramChatId, TelegramUserId } from '../../src/domain/Ids.js';
import { DeliveryId } from '../../src/domain/notifications/NotificationDelivery.js';
import { EventId } from '../../src/domain/notifications/NotificationEvent.js';
import { owner } from '../../src/domain/notifications/RecipientRole.js';
import { NotificationRepository } from '../../src/ports/NotificationRepository.js';
import { UserRepository } from '../../src/ports/UserRepository.js';
import * as RepositoriesLive from '../../src/postgres/RepositoriesLive.js';
import * as DeterministicCrypto from '../internal/DeterministicCrypto.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

const enabled = process.env.TEST_DATABASE_URL !== undefined || process.env.RUN_TESTCONTAINERS === 'true';
const layer = Layer.provideMerge(RepositoriesLive.layer, Layer.merge(PostgresTestLayer.layer, DeterministicCrypto.layer()));
const botId = Schema.decodeUnknownSync(BotId)('carneloot');
const eventId = () => Schema.decodeUnknownSync(EventId)(crypto.randomUUID());
const deliveryId = () => Schema.decodeUnknownSync(DeliveryId)(crypto.randomUUID());

if (!enabled) describe.skip('SendExternalNotification PostgreSQL', () => it('requires database', () => {}));
else describe('SendExternalNotification PostgreSQL', () => {
	it('persists frozen external event and initial recipient delivery atomically', async () => {
		const result = await Effect.runPromise(Effect.gen(function* () {
			const users = yield* UserRepository;
			const telegramId = Math.floor(Math.random() * 1_000_000) + 20_000_000;
			const registered = yield* users.registerTelegramProfile({ botId, telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(telegramId), username: null, firstName: 'external', lastName: null, privateChatId: Schema.decodeUnknownSync(TelegramChatId)(telegramId) });
			const notifications = yield* NotificationRepository;
			return yield* notifications.createExternalEvent({ id: eventId(), botId, kind: 'external-notification', ownerUserId: registered.user.id, petId: null, foodEntryId: null, scheduledFor: null, foodTimestampExplicit: false, dedupeKey: `external-${crypto.randomUUID()}`, now: DateTime.makeUnsafe(1_000) }, { templateId: null, renderedMessage: 'frozen message' }, [{ _tag: 'Reachable', id: deliveryId(), recipientUserId: registered.user.id, recipientChatId: registered.profile.privateChatId, recipientRole: owner, channel: 'telegram' }]);
		}).pipe(Effect.provide(layer)));
		expect(result.event.kind).toBe('external-notification');
		expect(result.deliveries).toMatchObject([{ status: 'pending', recipientChatId: expect.any(Number) }]);
	});
});

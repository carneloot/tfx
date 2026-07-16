import * as Schema from 'effect/Schema';

import { BotId, TelegramChatId, UserId } from '../Ids.js';
import { SafeError } from './DeliveryOutcome.js';
import { EventId } from './NotificationEvent.js';
import { RecipientRole } from './RecipientRole.js';

const uuid =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const DeliveryId = Schema.String.check(Schema.isPattern(uuid)).pipe(
	Schema.brand('NotificationDeliveryId'),
);
export type DeliveryId = typeof DeliveryId.Type;
export const DeliveryChannel = Schema.String.check(
	Schema.makeFilter(
		(value) =>
			new TextEncoder().encode(value).byteLength >= 1 &&
			new TextEncoder().encode(value).byteLength <= 64 &&
			/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value),
		{ message: 'Expected a lowercase kebab delivery channel' },
	),
);
export const DeliveryStatus = Schema.Literals([
	'pending',
	'sending',
	'sent',
	'failed',
	'unknown',
]);
export type DeliveryStatus = typeof DeliveryStatus.Type;
export const NotificationDelivery = Schema.Struct({
	id: DeliveryId,
	eventId: EventId,
	recipientUserId: UserId,
	recipientChatId: Schema.NullOr(TelegramChatId),
	recipientRole: RecipientRole,
	channel: DeliveryChannel,
	status: DeliveryStatus,
	attemptGeneration: Schema.Number,
	attemptCount: Schema.Number,
	sendingStartedAt: Schema.NullOr(Schema.DateTimeUtc),
	sendingLeaseExpiresAt: Schema.NullOr(Schema.DateTimeUtc),
	retryAt: Schema.NullOr(Schema.DateTimeUtc),
	retryable: Schema.Boolean,
	telegramBotId: Schema.NullOr(BotId),
	telegramMessageId: Schema.NullOr(Schema.Number),
	safeError: Schema.NullOr(SafeError),
	sentAt: Schema.NullOr(Schema.DateTimeUtc),
	failedAt: Schema.NullOr(Schema.DateTimeUtc),
	unknownAt: Schema.NullOr(Schema.DateTimeUtc),
	createdAt: Schema.DateTimeUtc,
	updatedAt: Schema.DateTimeUtc,
});
export type NotificationDelivery = typeof NotificationDelivery.Type;

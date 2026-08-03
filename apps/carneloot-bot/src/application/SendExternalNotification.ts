import * as Crypto from 'effect/Crypto';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Encoding from 'effect/Encoding';
import * as Schema from 'effect/Schema';

import { botId } from '../bot/Declaration.js';
import { BotId } from '../domain/Ids.js';
import {
	InitialNotificationPersistenceUnavailable,
	InvalidApiKey,
	MissingTemplateVariables,
	type ExternalNotificationInput,
	type ExternalNotificationResult,
	TemplateNotFound,
	classifyOutcome,
	renderNotificationTemplate,
} from '../domain/notifications/ExternalNotification.js';
import { ApiKeyHash } from '../domain/notifications/ApiKey.js';
import { DeliveryId } from '../domain/notifications/NotificationDelivery.js';
import { EventId } from '../domain/notifications/NotificationEvent.js';
import { NotificationKeyword } from '../domain/notifications/NotificationTemplate.js';
import { owner, subscriber } from '../domain/notifications/RecipientRole.js';
import { ApiKeyRepository } from '../ports/ApiKeyRepository.js';
import { NotificationRecipients } from '../ports/NotificationRecipients.js';
import { NotificationRepository } from '../ports/NotificationRepository.js';
import { NotificationTemplateRepository } from '../ports/NotificationTemplateRepository.js';
import * as DispatchNotificationDelivery from './DispatchNotificationDelivery.js';

const encoder = new TextEncoder();
const directConcurrency = 4;

type GenericDispatchOutcome = 'sent' | 'failed' | 'unknown';

export const fallbackCounts = (
	deliveries: ReadonlyArray<{ readonly status: string }>,
	reachable: ReadonlyArray<unknown>,
	outcomes: ReadonlyArray<GenericDispatchOutcome>,
) => {
	const counts = { sent: 0, failed: 0, unknown: 0 };
	for (const delivery of deliveries)
		if (!reachable.includes(delivery)) {
			if (delivery.status === 'sent') counts.sent++;
			else if (delivery.status === 'failed') counts.failed++;
			else counts.unknown++;
		}
	for (const outcome of outcomes) counts[outcome]++;

	if (counts.unknown === 0) {
		if (counts.sent > 0) counts.sent--;
		else if (counts.failed > 0) counts.failed--;
		else return counts;
		counts.unknown++;
	}
	return counts;
};

export const execute = Effect.fn('SendExternalNotification.execute')(
	function* (input: ExternalNotificationInput) {
		const crypto = yield* Crypto.Crypto;
		const keys = yield* ApiKeyRepository;
		const digest = yield* crypto
			.digest('SHA-256', encoder.encode(input.apiKey))
			.pipe(Effect.orDie);
		const keyHash = Schema.decodeUnknownSync(ApiKeyHash)(
			Encoding.encodeHex(digest),
		);
		const ownerUserId = yield* keys.findUserIdByHash(keyHash).pipe(
			Effect.mapError(
				() => new InvalidApiKey({ message: 'Invalid API key' }),
			),
		);
		if (ownerUserId === undefined)
			return yield* Effect.fail(new InvalidApiKey({ message: 'Invalid API key' }));

		const keyword = yield* Effect.try({
			try: () => Schema.decodeUnknownSync(NotificationKeyword)(input.keyword),
			catch: () =>
				new TemplateNotFound({ message: 'Notification template not found' }),
		});
		const canonicalBotId = Schema.decodeUnknownSync(BotId)(botId);
		const templates = yield* NotificationTemplateRepository;
		const resolved = yield* templates.findByOwnerAndKeyword(ownerUserId, keyword).pipe(
			Effect.mapError(
				() => new TemplateNotFound({ message: 'Notification template not found' }),
			),
		);
		if (resolved === undefined)
			return yield* Effect.fail(
				new TemplateNotFound({ message: 'Notification template not found' }),
			);
		const rendered = renderNotificationTemplate(
			resolved.template.message,
			input.variables,
		);
		if (rendered instanceof MissingTemplateVariables) return yield* Effect.fail(rendered);

		const recipients = yield* NotificationRecipients;
		const subscriberIds = resolved.subscriberUserIds.filter(
			(userId) => userId !== ownerUserId,
		);
		const resolutions = yield* Effect.all([
			recipients.resolveUser(canonicalBotId, ownerUserId, owner),
			...subscriberIds.map((userId) =>
				recipients.resolveUser(canonicalBotId, userId, subscriber),
			),
		]);
		const eventId = Schema.decodeUnknownSync(EventId)(
			yield* crypto.randomUUIDv4.pipe(Effect.orDie),
		);
		const recipientInputs = yield* Effect.forEach(resolutions, (resolution) =>
			Effect.map(crypto.randomUUIDv4.pipe(Effect.orDie), (id) => ({
				...resolution,
				id: Schema.decodeUnknownSync(DeliveryId)(id),
			})),
		);
		const now = yield* DateTime.now;
		const notifications = yield* NotificationRepository;
		const created = yield* notifications
			.createExternalEvent(
				{
					id: eventId,
					botId: canonicalBotId,
					kind: 'external-notification',
					ownerUserId,
					petId: null,
					foodEntryId: null,
					scheduledFor: null,
					foodTimestampExplicit: false,
					dedupeKey: eventId,
					now,
				},
				{ templateId: resolved.template.id, renderedMessage: rendered },
				recipientInputs,
			)
			.pipe(
				Effect.mapError(
					() =>
						new InitialNotificationPersistenceUnavailable({
							message: 'Initial notification persistence unavailable',
						}),
				),
			);

		const reachable = created.deliveries.filter(
			(delivery) => delivery.recipientChatId !== null && delivery.status === 'pending',
		);
		const outcomes = yield* Effect.forEach(
			reachable,
			() =>
				DispatchNotificationDelivery.executeGeneric({
					eventId: created.event.id,
					botId: canonicalBotId,
					text: rendered,
				}).pipe(Effect.catch(() => Effect.succeed('unknown' as const))),
			{ concurrency: directConcurrency },
		);
		const finalizedAt = yield* DateTime.now;
		const finalizeError = {
			code: 'DirectDispatchIncomplete',
			message: 'Direct notification dispatch ended before delivery',
		};
		yield* notifications
			.finalizeUnattempted(created.event.id, finalizeError, finalizedAt)
			.pipe(Effect.catch(() => Effect.void));
		const summary = yield* notifications
			.summarizeAndComplete(created.event.id, finalizedAt)
			.pipe(Effect.orElseSucceed(() => undefined));
		if (summary === undefined) {
			const counts = fallbackCounts(created.deliveries, reachable, outcomes);
			return {
				eventId: created.event.id,
				...classifyOutcome(counts),
				counts,
				failures: [],
			} satisfies ExternalNotificationResult;
		}
		const counts = {
			sent: summary.sent,
			failed: summary.failed,
			unknown: summary.unknown + summary.pending + summary.sending,
		};
		return {
			eventId: created.event.id,
			...classifyOutcome(counts),
			counts,
			failures: summary.failures,
		} satisfies ExternalNotificationResult;
	},
);

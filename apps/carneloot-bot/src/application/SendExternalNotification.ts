import * as Crypto from 'effect/Crypto';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

import type { BotId } from '../domain/Ids.js';
import {
	classifyOutcome,
	type ExternalNotificationInput,
	type ExternalNotificationResult,
	InitialNotificationPersistenceUnavailable,
	InvalidApiKey,
	render,
	TemplateNotFound,
} from '../domain/notifications/ExternalNotification.js';
import { DeliveryId } from '../domain/notifications/NotificationDelivery.js';
import { EventId } from '../domain/notifications/NotificationEvent.js';
import { ApiKeyRepository } from '../ports/ApiKeyRepository.js';
import { ExternalNotificationRepository } from '../ports/ExternalNotificationRepository.js';
import { NotificationRepository } from '../ports/NotificationRepository.js';
import { NotificationTemplateRepository } from '../ports/NotificationTemplateRepository.js';
import * as DispatchNotificationDelivery from './DispatchNotificationDelivery.js';
import * as GenerateApiKey from './GenerateApiKey.js';

export const execute = Effect.fn('SendExternalNotification.execute')(function* (
	botId: BotId,
	input: ExternalNotificationInput,
) {
	const keys = yield* ApiKeyRepository;
	const templates = yield* NotificationTemplateRepository;
	const external = yield* ExternalNotificationRepository;
	const notifications = yield* NotificationRepository;
	const crypto = yield* Crypto.Crypto;
	const unavailable = () => new InitialNotificationPersistenceUnavailable();
	const ownerId = yield* keys
		.findOwner(yield* GenerateApiKey.hash(input.apiKey))
		.pipe(Effect.mapError(unavailable));
	if (ownerId === undefined) return yield* new InvalidApiKey();
	const template = yield* templates
		.find(botId, ownerId, input.keyword)
		.pipe(Effect.mapError(unavailable));
	if (template === undefined) return yield* new TemplateNotFound();
	const text = yield* render(template.message, input.variables);
	const eventId = Schema.decodeUnknownSync(EventId)(
		yield* crypto.randomUUIDv4().pipe(Effect.orDie),
	);
	const recipients = yield* Effect.forEach(
		template.recipients,
		Effect.fnUntraced(function* (recipient) {
			return {
				...recipient,
				id: Schema.decodeUnknownSync(DeliveryId)(
					yield* crypto.randomUUIDv4().pipe(Effect.orDie),
				),
			};
		}),
	);
	yield* external
		.create(
			{
				id: eventId,
				botId,
				kind: 'external',
				ownerUserId: ownerId,
				petId: null,
				foodEntryId: null,
				scheduledFor: null,
				foodTimestampExplicit: false,
				dedupeKey: `external:${eventId}`,
				now: yield* DateTime.now,
			},
			template.id,
			text,
			recipients,
		)
		.pipe(Effect.mapError(unavailable));

	// From this point onward 503 would be unsafe: output may already be accepted.
	// Keep confirmed durable outcomes if the final DB read fails; everything else is unknown.
	const observed = new Map<DeliveryId, 'sent' | 'failed' | 'unknown'>(
		recipients
			.filter((r) => r._tag === 'Unreachable')
			.map((r) => [r.id, 'failed']),
	);
	const worker = Effect.fnUntraced(function* () {
		while (true) {
			const claim = yield* notifications.claimNext(
				eventId,
				yield* DateTime.now,
				Duration.seconds(30),
			);
			if (claim === undefined) return;
			const status = yield* DispatchNotificationDelivery.executeExternalClaim(
				botId,
				text,
				claim,
			);
			observed.set(claim.delivery.id, status);
		}
	});
	yield* Effect.forEach([0, 1, 2, 3], () => worker().pipe(Effect.result), {
		concurrency: 4,
	});
	yield* external.failPending(eventId).pipe(Effect.result);
	yield* notifications
		.summarizeAndComplete(eventId, yield* DateTime.now)
		.pipe(Effect.result);
	const persisted = yield* external.result(eventId).pipe(Effect.result);
	if (persisted._tag === 'Success') return persisted.success;
	const counts = { sent: 0, failed: 0, unknown: 0 };
	const failures: ExternalNotificationResult['failures'][number][] = [];
	for (const recipient of recipients) {
		const status = observed.get(recipient.id) ?? 'unknown';
		counts[status]++;
		if (status !== 'sent')
			failures.push({
				deliveryId: recipient.id,
				code: status === 'failed' ? 'DeliveryFailed' : 'PersistenceUncertain',
			});
	}
	return { eventId, status: classifyOutcome(counts).status, counts, failures };
});

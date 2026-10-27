import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';

import { TelegramChatId } from '../domain/Ids.js';
import { classifyOutcome } from '../domain/notifications/ExternalNotification.js';
import {
	DeliveryId,
	DeliveryStatus,
} from '../domain/notifications/NotificationDelivery.js';
import { ExternalNotificationRepository } from '../ports/ExternalNotificationRepository.js';
import {
	NotificationRepository,
	NotificationRepositoryError,
} from '../ports/NotificationRepository.js';

const protect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.mapError(
			() =>
				new NotificationRepositoryError({
					reason: 'PersistenceFailure',
					message: 'External notification persistence failed',
				}),
		),
	);
const ResultRow = Schema.Struct({
	id: DeliveryId,
	status: DeliveryStatus,
	safe_error_json: Schema.NullOr(Schema.Struct({ code: Schema.String })),
});

export const layer = Layer.effect(
	ExternalNotificationRepository,
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const notifications = yield* NotificationRepository;
		return ExternalNotificationRepository.of({
			create: Effect.fn('ExternalNotificationRepository.create')(
				function* (event, templateId, text, recipients, replyToMessageId) {
					return yield* protect(
						sql.withTransaction(
							Effect.gen(function* () {
								const persisted = yield* notifications.createEvent(event);
								const inserted =
									yield* sql`INSERT INTO carneloot.notification_event_payloads (event_id,template_id,rendered_message,reply_to_message_id) VALUES (${persisted.id}::uuid,${templateId}::uuid,${text},${replyToMessageId ?? null}) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`;
								if (inserted.length > 0) {
									yield* notifications.materializeRecipients(
										persisted.id,
										recipients,
										event.now,
									);
									yield* notifications.markRecipientsMaterialized(
										persisted.id,
										event.now,
									);
								}
								return persisted.id;
							}),
						),
					);
				},
			),
			payload: Effect.fn('ExternalNotificationRepository.payload')(
				function* (eventId) {
					const rows = yield* protect(
						sql`SELECT rendered_message,reply_to_message_id FROM carneloot.notification_event_payloads WHERE event_id=${eventId}::uuid`,
					);
					if (rows[0] === undefined) return undefined;
					return yield* protect(
						Schema.decodeUnknownEffect(
							Schema.Struct({
								text: Schema.String,
								replyToMessageId: Schema.NullOr(
									Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
								),
							}),
						)({
							text: rows[0].rendered_message,
							replyToMessageId:
								rows[0].reply_to_message_id === null
									? null
									: Number(rows[0].reply_to_message_id),
						}),
					);
				},
			),
			result: Effect.fn('ExternalNotificationRepository.result')(
				function* (eventId) {
					const rows = yield* protect(
						sql`SELECT id,status,safe_error_json FROM carneloot.notification_deliveries WHERE event_id=${eventId}::uuid ORDER BY id`,
					);
					const deliveries = yield* protect(
						Schema.decodeUnknownEffect(Schema.Array(ResultRow))(rows),
					);
					const counts = { sent: 0, failed: 0, unknown: 0 };
					const failures: Array<{
						deliveryId: typeof DeliveryId.Type;
						code: string;
					}> = [];
					for (const delivery of deliveries) {
						if (delivery.status === 'sent') counts.sent++;
						else if (delivery.status === 'failed') counts.failed++;
						else counts.unknown++;
						if (delivery.status !== 'sent')
							failures.push({
								deliveryId: delivery.id,
								code: delivery.safe_error_json?.code ?? 'DeliveryUnsettled',
							});
					}
					return {
						eventId,
						status: classifyOutcome(counts).status,
						counts,
						failures,
					};
				},
			),
			failPending: Effect.fn('ExternalNotificationRepository.failPending')(
				function* (eventId) {
					// These rows have never been claimed, so output is known not to have started.
					yield* protect(
						sql`UPDATE carneloot.notification_deliveries SET status='failed',sending_started_at=now(),failed_at=now(),updated_at=now(),safe_error_json='{"code":"DispatchNotStarted","message":"Delivery was not attempted"}'::jsonb WHERE event_id=${eventId}::uuid AND status='pending'`,
					);
				},
			),
			ownerMessage: Effect.fn('ExternalNotificationRepository.ownerMessage')(
				function* (eventId, botId) {
					const rows = yield* protect(sql`
				SELECT d.recipient_chat_id,d.telegram_message_id FROM carneloot.notification_deliveries d
				JOIN carneloot.notification_events e ON e.id=d.event_id
				WHERE e.id=${eventId}::uuid AND e.bot_id=${botId} AND e.kind='external'
				AND d.recipient_user_id=e.owner_user_id AND d.recipient_role='owner'
				AND d.channel='telegram' AND d.status='sent' AND d.telegram_bot_id=${botId}`);
					if (rows[0] === undefined) return undefined;
					return yield* protect(
						Schema.decodeUnknownEffect(
							Schema.Struct({
								chatId: TelegramChatId,
								messageId: Schema.Number.check(
									Schema.isInt(),
									Schema.isGreaterThan(0),
								),
							}),
						)({
							chatId: Number(rows[0].recipient_chat_id),
							messageId: Number(rows[0].telegram_message_id),
						}),
					);
				},
			),
		});
	}),
);

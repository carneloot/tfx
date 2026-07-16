import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';

import { BotId, PetId, TelegramChatId, UserId } from '../domain/Ids.js';
import { SafeError } from '../domain/notifications/DeliveryOutcome.js';
import {
	DeliveryChannel,
	DeliveryId,
	DeliveryStatus,
	type NotificationDelivery,
} from '../domain/notifications/NotificationDelivery.js';
import {
	EventId,
	EventStatus,
	type NotificationEvent,
} from '../domain/notifications/NotificationEvent.js';
import { RecipientRole } from '../domain/notifications/RecipientRole.js';
import { FoodEntryId } from '../domain/pet-food/PetFood.js';
import {
	NotificationRepository,
	NotificationRepositoryError,
	type NotificationRepositoryService,
} from '../ports/NotificationRepository.js';
import { migrate } from './AppMigrator.js';

const Timestamp = Schema.Union([
	Schema.DateTimeUtcFromDate,
	Schema.DateTimeUtcFromString,
	Schema.DateTimeUtcFromMillis,
]);
const NullableTimestamp = Schema.NullOr(Timestamp);
const nullableDateTimeEquals = (
	left: DateTime.Utc | null,
	right: DateTime.Utc | null,
) =>
	left === null || right === null
		? left === right
		: DateTime.Equivalence(left, right);
const integer = Schema.Union([Schema.String, Schema.Number]);
const nullableInteger = Schema.NullOr(integer);
const EventRow = Schema.Struct({
	id: EventId,
	bot_id: BotId,
	kind: Schema.String,
	owner_user_id: UserId,
	pet_id: Schema.NullOr(PetId),
	food_entry_id: Schema.NullOr(FoodEntryId),
	scheduled_for: NullableTimestamp,
	status: EventStatus,
	dedupe_key: Schema.String,
	job_id: Schema.NullOr(Schema.String),
	created_at: Timestamp,
	updated_at: Timestamp,
	completed_at: NullableTimestamp,
	cancelled_at: NullableTimestamp,
});
const DeliveryRow = Schema.Struct({
	id: DeliveryId,
	event_id: EventId,
	recipient_user_id: UserId,
	recipient_chat_id: nullableInteger,
	recipient_role: RecipientRole,
	channel: DeliveryChannel,
	status: DeliveryStatus,
	attempt_generation: integer,
	attempt_count: integer,
	sending_started_at: NullableTimestamp,
	sending_lease_expires_at: NullableTimestamp,
	retry_at: NullableTimestamp,
	retryable: Schema.Boolean,
	telegram_bot_id: Schema.NullOr(BotId),
	telegram_message_id: nullableInteger,
	safe_error_json: Schema.Unknown,
	sent_at: NullableTimestamp,
	failed_at: NullableTimestamp,
	unknown_at: NullableTimestamp,
	created_at: Timestamp,
	updated_at: Timestamp,
});
const safeInteger = (value: string | number, minimum?: number) => {
	const result = Number(value);
	if (
		!Number.isSafeInteger(result) ||
		(minimum !== undefined && result < minimum)
	)
		throw new Error('Unsafe integer');
	return result;
};
const decodeEventSync = (raw: unknown): NotificationEvent => {
	const row = Schema.decodeUnknownSync(EventRow)(raw);
	return {
		id: row.id,
		botId: row.bot_id,
		kind: row.kind,
		ownerUserId: row.owner_user_id,
		petId: row.pet_id,
		foodEntryId: row.food_entry_id,
		scheduledFor: row.scheduled_for,
		status: row.status,
		dedupeKey: row.dedupe_key,
		jobId: row.job_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		completedAt: row.completed_at,
		cancelledAt: row.cancelled_at,
	};
};
const decodeDeliverySync = (raw: unknown): NotificationDelivery => {
	const row = Schema.decodeUnknownSync(DeliveryRow)(raw);
	return {
		id: row.id,
		eventId: row.event_id,
		recipientUserId: row.recipient_user_id,
		recipientChatId:
			row.recipient_chat_id === null
				? null
				: Schema.decodeUnknownSync(TelegramChatId)(
						safeInteger(row.recipient_chat_id),
					),
		recipientRole: row.recipient_role,
		channel: row.channel,
		status: row.status,
		attemptGeneration: safeInteger(row.attempt_generation, 0),
		attemptCount: safeInteger(row.attempt_count, 0),
		sendingStartedAt: row.sending_started_at,
		sendingLeaseExpiresAt: row.sending_lease_expires_at,
		retryAt: row.retry_at,
		retryable: row.retryable,
		telegramBotId: row.telegram_bot_id,
		telegramMessageId:
			row.telegram_message_id === null
				? null
				: safeInteger(row.telegram_message_id, 1),
		safeError:
			row.safe_error_json === null
				? null
				: Schema.decodeUnknownSync(SafeError)(row.safe_error_json),
		sentAt: row.sent_at,
		failedAt: row.failed_at,
		unknownAt: row.unknown_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
};
const error = (
	reason: NotificationRepositoryError['reason'],
	message: string,
	cause?: unknown,
) =>
	new NotificationRepositoryError({
		reason,
		message,
		...(cause === undefined ? {} : { cause }),
	});
const protect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.mapError((cause) =>
			cause instanceof NotificationRepositoryError
				? cause
				: error('PersistenceFailure', 'Notification repository failed', cause),
		),
	);
const decodeEvent = (raw: unknown) =>
	Effect.try({
		try: () => decodeEventSync(raw),
		catch: (cause) =>
			error('InvariantViolation', 'Malformed notification event row', cause),
	});
const decodeDelivery = (raw: unknown) =>
	Effect.try({
		try: () => decodeDeliverySync(raw),
		catch: (cause) =>
			error('InvariantViolation', 'Malformed notification delivery row', cause),
	});

export const layer = Layer.effect(
	NotificationRepository,
	Effect.andThen(
		migrate.pipe(
			Effect.mapError((cause) =>
				error('PersistenceFailure', 'Notification migration failed', cause),
			),
		),
		Effect.map(PgClient.PgClient, (sql) => {
			const oneEvent = (rows: ReadonlyArray<unknown>) =>
				rows[0] === undefined
					? Effect.fail(error('InvariantViolation', 'Expected event row'))
					: decodeEvent(rows[0]);
			const oneDelivery = (rows: ReadonlyArray<unknown>) =>
				rows[0] === undefined
					? Effect.fail(error('InvariantViolation', 'Expected delivery row'))
					: decodeDelivery(rows[0]);
			const service = {
				createEvent: (input) =>
					protect(
						sql.withTransaction(
							Effect.gen(function* () {
								const inserted = yield* sql<
									Record<string, unknown>
								>`INSERT INTO carneloot.notification_events (id,bot_id,kind,owner_user_id,pet_id,food_entry_id,scheduled_for,status,dedupe_key,job_id,created_at,updated_at,completed_at,cancelled_at) VALUES (${input.id}::uuid,${input.botId},${input.kind},${input.ownerUserId}::uuid,${input.petId}::uuid,${input.foodEntryId}::uuid,${input.scheduledFor === null ? null : DateTime.toDateUtc(input.scheduledFor)},'scheduled',${input.dedupeKey},NULL,${DateTime.toDateUtc(input.now)},${DateTime.toDateUtc(input.now)},NULL,NULL) ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`;
								if (inserted[0] !== undefined) return yield* oneEvent(inserted);
								const existingRows = yield* sql<
									Record<string, unknown>
								>`SELECT * FROM carneloot.notification_events WHERE dedupe_key=${input.dedupeKey} FOR UPDATE`;
								const existing = yield* oneEvent(existingRows);
								if (
									existing.botId !== input.botId ||
									existing.kind !== input.kind ||
									existing.ownerUserId !== input.ownerUserId ||
									existing.petId !== input.petId ||
									existing.foodEntryId !== input.foodEntryId ||
									!nullableDateTimeEquals(
										existing.scheduledFor,
										input.scheduledFor,
									)
								)
									return yield* Effect.fail(
										error(
											'Conflict',
											'Notification dedupe key has different immutable identity',
										),
									);
								return existing;
							}),
						),
					),
				cancelActiveForPet: (botId, petId, now) =>
					protect(
						sql.withTransaction(
							Effect.gen(function* () {
								const rows = yield* sql<{
									id: string;
									job_id: string | null;
								}>`SELECT id,job_id FROM carneloot.notification_events WHERE bot_id=${botId} AND pet_id=${petId}::uuid AND status IN ('scheduled','dispatching') FOR UPDATE`;
								if (rows.length > 0)
									yield* sql`UPDATE carneloot.notification_events SET status='cancelled',cancelled_at=${DateTime.toDateUtc(now)},completed_at=NULL,updated_at=${DateTime.toDateUtc(now)} WHERE bot_id=${botId} AND pet_id=${petId}::uuid AND status IN ('scheduled','dispatching')`;
								return rows.map((row) => ({
									eventId: Schema.decodeUnknownSync(EventId)(row.id),
									jobId: row.job_id,
								}));
							}),
						),
					),
				reviveCancelledEvent: (id, now) =>
					protect(
						Effect.map(
							sql`UPDATE carneloot.notification_events e SET status='scheduled',cancelled_at=NULL,completed_at=NULL,job_id=NULL,updated_at=${DateTime.toDateUtc(now)} WHERE e.id=${id}::uuid AND e.status='cancelled' AND NOT EXISTS (SELECT 1 FROM carneloot.notification_deliveries d WHERE d.event_id=e.id) RETURNING e.id`,
							(rows) => rows.length > 0,
						),
					),
				cancelEvent: (id, now) =>
					protect(
						Effect.map(
							sql`UPDATE carneloot.notification_events SET status='cancelled',cancelled_at=${DateTime.toDateUtc(now)},completed_at=NULL,updated_at=${DateTime.toDateUtc(now)} WHERE id=${id}::uuid AND status IN ('scheduled','dispatching') RETURNING id`,
							(rows) => rows.length > 0,
						),
					),
				attachJob: (id, jobId, now) =>
					protect(
						Effect.map(
							sql`UPDATE carneloot.notification_events SET job_id=${jobId}::uuid,updated_at=${DateTime.toDateUtc(now)} WHERE id=${id}::uuid AND status='scheduled' AND job_id IS NULL RETURNING id`,
							(rows) => rows.length > 0,
						),
					),
				getDispatchContext: (id) =>
					protect(
						Effect.flatMap(
							sql<
								Record<string, unknown>
							>`SELECT * FROM carneloot.notification_events WHERE id=${id}::uuid`,
							(rows) =>
								rows[0] === undefined
									? Effect.succeed(undefined)
									: decodeEvent(rows[0]),
						),
					),
				materializeRecipients: (eventId, recipients, now) =>
					protect(
						sql.withTransaction(
							Effect.gen(function* () {
								const active =
									yield* sql`SELECT id FROM carneloot.notification_events WHERE id=${eventId}::uuid AND status IN ('scheduled','dispatching') FOR UPDATE`;
								if (active.length === 0)
									return yield* Effect.fail(
										error('Conflict', 'Notification event is not active'),
									);
								return yield* Effect.forEach(recipients, (recipient) =>
									Effect.flatMap(
										recipient._tag === 'Reachable'
											? sql<
													Record<string, unknown>
												>`INSERT INTO carneloot.notification_deliveries (id,event_id,recipient_user_id,recipient_chat_id,recipient_role,channel,status,attempt_generation,attempt_count,retryable,created_at,updated_at) VALUES (${recipient.id}::uuid,${eventId}::uuid,${recipient.recipientUserId}::uuid,${recipient.recipientChatId},${recipient.recipientRole},${recipient.channel},'pending',0,0,false,${DateTime.toDateUtc(now)},${DateTime.toDateUtc(now)}) ON CONFLICT (event_id,recipient_user_id,channel) DO UPDATE SET event_id=EXCLUDED.event_id RETURNING *`
											: sql<
													Record<string, unknown>
												>`INSERT INTO carneloot.notification_deliveries (id,event_id,recipient_user_id,recipient_chat_id,recipient_role,channel,status,attempt_generation,attempt_count,retryable,safe_error_json,failed_at,created_at,updated_at) VALUES (${recipient.id}::uuid,${eventId}::uuid,${recipient.recipientUserId}::uuid,NULL,${recipient.recipientRole},${recipient.channel},'failed',0,0,false,${sql.json(recipient.error)},${DateTime.toDateUtc(now)},${DateTime.toDateUtc(now)},${DateTime.toDateUtc(now)}) ON CONFLICT (event_id,recipient_user_id,channel) DO UPDATE SET event_id=EXCLUDED.event_id RETURNING *`,
										oneDelivery,
									),
								);
							}),
						),
					),
				recoverExpired: (eventId, now) =>
					protect(
						Effect.map(
							sql`UPDATE carneloot.notification_deliveries SET status='unknown',sending_lease_expires_at=NULL,retryable=false,retry_at=NULL,safe_error_json=${sql.json({ code: 'SendingLeaseExpired', message: 'Sending lease expired' })},unknown_at=${DateTime.toDateUtc(now)},updated_at=${DateTime.toDateUtc(now)} WHERE event_id=${eventId}::uuid AND status='sending' AND sending_lease_expires_at<=${DateTime.toDateUtc(now)} RETURNING id`,
							(rows) => rows.length,
						),
					),
				recoverAllExpired: (now) =>
					protect(
						Effect.map(
							sql`UPDATE carneloot.notification_deliveries SET status='unknown',sending_lease_expires_at=NULL,retryable=false,retry_at=NULL,safe_error_json=${sql.json({ code: 'SendingLeaseExpired', message: 'Sending lease expired' })},unknown_at=${DateTime.toDateUtc(now)},updated_at=${DateTime.toDateUtc(now)} WHERE status='sending' AND sending_lease_expires_at<=${DateTime.toDateUtc(now)} RETURNING id`,
							(rows) => rows.length,
						),
					),
				claimNext: (eventId, now, leaseDuration) =>
					protect(
						sql.withTransaction(
							Effect.gen(function* () {
								const leaseExpiresAt = DateTime.addDuration(now, leaseDuration);
								const rows = yield* sql<
									Record<string, unknown>
								>`WITH candidate AS (SELECT d.id FROM carneloot.notification_deliveries d JOIN carneloot.notification_events e ON e.id=d.event_id WHERE d.event_id=${eventId}::uuid AND e.status IN ('scheduled','dispatching') AND (d.status='pending' OR (d.status='failed' AND d.retryable=true AND d.retry_at<=${DateTime.toDateUtc(now)})) ORDER BY d.retry_at NULLS FIRST,d.created_at,d.id FOR UPDATE OF d SKIP LOCKED LIMIT 1) UPDATE carneloot.notification_deliveries d SET status='sending',attempt_generation=d.attempt_generation+1,attempt_count=d.attempt_count+1,sending_started_at=${DateTime.toDateUtc(now)},sending_lease_expires_at=${DateTime.toDateUtc(leaseExpiresAt)},retry_at=NULL,retryable=false,safe_error_json=NULL,failed_at=NULL,updated_at=${DateTime.toDateUtc(now)} FROM candidate WHERE d.id=candidate.id RETURNING d.*`;
								if (rows[0] === undefined) return undefined;
								yield* sql`UPDATE carneloot.notification_events SET status='dispatching',updated_at=${DateTime.toDateUtc(now)} WHERE id=${eventId}::uuid AND status='scheduled'`;
								const delivery = yield* decodeDelivery(rows[0]);
								return {
									delivery,
									token: {
										id: delivery.id,
										generation: delivery.attemptGeneration,
									},
								};
							}),
						),
					),
				finalizeSent: (token, botId, messageId, now) =>
					protect(
						Effect.map(
							sql`UPDATE carneloot.notification_deliveries SET status='sent',sending_lease_expires_at=NULL,telegram_bot_id=${botId},telegram_message_id=${messageId},sent_at=${DateTime.toDateUtc(now)},updated_at=${DateTime.toDateUtc(now)} WHERE id=${token.id}::uuid AND attempt_generation=${token.generation} AND status='sending' RETURNING id`,
							(rows) => rows.length > 0,
						),
					),
				finalizeFailed: (token, safeError, retryable, retryAt, now) =>
					retryable !== (retryAt !== null)
						? Effect.fail(
								error(
									'InvariantViolation',
									'Retryable failures require retryAt and permanent failures forbid it',
								),
							)
						: protect(
								Effect.map(
									sql`UPDATE carneloot.notification_deliveries SET status='failed',sending_lease_expires_at=NULL,retryable=${retryable},retry_at=${retryAt === null ? null : DateTime.toDateUtc(retryAt)},safe_error_json=${sql.json(safeError)},failed_at=${DateTime.toDateUtc(now)},updated_at=${DateTime.toDateUtc(now)} WHERE id=${token.id}::uuid AND attempt_generation=${token.generation} AND status='sending' RETURNING id`,
									(rows) => rows.length > 0,
								),
							),
				finalizeUnknown: (token, safeError, now) =>
					protect(
						Effect.map(
							sql`UPDATE carneloot.notification_deliveries SET status='unknown',sending_lease_expires_at=NULL,retryable=false,retry_at=NULL,safe_error_json=${sql.json(safeError)},unknown_at=${DateTime.toDateUtc(now)},updated_at=${DateTime.toDateUtc(now)} WHERE id=${token.id}::uuid AND attempt_generation=${token.generation} AND status='sending' RETURNING id`,
							(rows) => rows.length > 0,
						),
					),
				reconcileUnknownAsSent: (token, botId, messageId, now) =>
					protect(
						Effect.map(
							sql`UPDATE carneloot.notification_deliveries SET status='sent',telegram_bot_id=${botId},telegram_message_id=${messageId},safe_error_json=NULL,unknown_at=NULL,sent_at=${DateTime.toDateUtc(now)},updated_at=${DateTime.toDateUtc(now)} WHERE id=${token.id}::uuid AND attempt_generation=${token.generation} AND status='unknown' RETURNING id`,
							(rows) => rows.length > 0,
						),
					),
				summarizeAndComplete: (eventId, now) =>
					protect(
						sql.withTransaction(
							Effect.gen(function* () {
								const events = yield* sql<{
									status:
										| 'scheduled'
										| 'dispatching'
										| 'completed'
										| 'cancelled';
								}>`SELECT status FROM carneloot.notification_events WHERE id=${eventId}::uuid FOR UPDATE`;
								const event = events[0];
								if (event === undefined)
									return yield* Effect.fail(
										error('NotFound', 'Notification event does not exist'),
									);
								const rows = yield* sql<{
									pending: number;
									sending: number;
									retryable_failed: number;
									terminal: number;
									earliest_retry_at: Date | null;
									earliest_sending_lease_expiry: Date | null;
								}>`SELECT count(*) FILTER (WHERE status='pending')::int pending,count(*) FILTER (WHERE status='sending')::int sending,count(*) FILTER (WHERE status='failed' AND retryable=true)::int retryable_failed,count(*) FILTER (WHERE status='sent' OR status='unknown' OR (status='failed' AND retryable=false))::int terminal,min(retry_at) FILTER (WHERE status='failed' AND retryable=true) earliest_retry_at,min(sending_lease_expires_at) FILTER (WHERE status='sending') earliest_sending_lease_expiry FROM carneloot.notification_deliveries WHERE event_id=${eventId}::uuid`;
								const row = rows[0];
								if (row === undefined)
									return yield* Effect.fail(
										error(
											'InvariantViolation',
											'Missing delivery aggregate row',
										),
									);
								const canComplete =
									(event.status === 'scheduled' ||
										event.status === 'dispatching') &&
									row.pending === 0 &&
									row.sending === 0 &&
									row.retryable_failed === 0;
								if (canComplete)
									yield* sql`UPDATE carneloot.notification_events SET status='completed',completed_at=${DateTime.toDateUtc(now)},cancelled_at=NULL,updated_at=${DateTime.toDateUtc(now)} WHERE id=${eventId}::uuid AND status IN ('scheduled','dispatching')`;
								return {
									pending: row.pending,
									sending: row.sending,
									retryableFailed: row.retryable_failed,
									terminal: row.terminal,
									completed: event.status === 'completed' || canComplete,
									earliestRetryAt:
										row.earliest_retry_at === null
											? null
											: Schema.decodeUnknownSync(Timestamp)(
													row.earliest_retry_at,
												),
									earliestSendingLeaseExpiry:
										row.earliest_sending_lease_expiry === null
											? null
											: Schema.decodeUnknownSync(Timestamp)(
													row.earliest_sending_lease_expiry,
												),
								};
							}),
						),
					),
			} satisfies NotificationRepositoryService;
			return service;
		}),
	),
);

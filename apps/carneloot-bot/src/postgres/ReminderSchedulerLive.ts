import * as PgClient from '@effect/sql-pg/PgClient';
import * as Crypto from 'effect/Crypto';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { JobRuntime } from 'tfx/JobRuntime';

import type { BotId, PetId } from '../domain/Ids.js';
import { EventId } from '../domain/notifications/NotificationEvent.js';
import * as FeedingReminderJob from '../jobs/FeedingReminderJob.js';
import { NotificationRepository } from '../ports/NotificationRepository.js';
import { PetFoodRepository } from '../ports/PetFoodRepository.js';
import {
	ReminderScheduler,
	ReminderSchedulerError,
	type ReminderSchedulerService,
} from '../ports/ReminderScheduler.js';

const Timestamp = Schema.Union([
	Schema.DateTimeUtcFromDate,
	Schema.DateTimeUtcFromString,
]);

const safeCause = (cause: unknown) => {
	if (typeof cause !== 'object' || cause === null)
		return { message: String(cause) };
	return {
		...('_tag' in cause && typeof cause._tag === 'string'
			? { tag: cause._tag }
			: {}),
		...('reason' in cause && typeof cause.reason === 'string'
			? { reason: cause.reason }
			: {}),
		...('code' in cause && typeof cause.code === 'string'
			? { code: cause.code }
			: {}),
	};
};
const schedulerError = (
	message: string,
	cause?: unknown,
	reason: 'PersistenceFailure' | 'InvariantViolation' = 'PersistenceFailure',
) =>
	new ReminderSchedulerError({
		reason,
		message,
		...(cause === undefined ? {} : { cause: safeCause(cause) }),
	});

export const layer = Layer.effect(
	ReminderScheduler,
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const notifications = yield* NotificationRepository;
		const food = yield* PetFoodRepository;
		const jobs = yield* JobRuntime;
		const crypto = yield* Crypto.Crypto;
		const cancelJobs = (
			events: ReadonlyArray<{ readonly jobId: string | null }>,
		) =>
			Effect.forEach(events, (event) =>
				event.jobId === null
					? Effect.void
					: Effect.asVoid(jobs.cancel(event.jobId)),
			);
		const cancelLocked = (botId: BotId, petId: PetId, now: DateTime.Utc) =>
			Effect.flatMap(
				notifications.cancelActiveForPet(botId, petId, now),
				cancelJobs,
			);
		const service = {
			replaceForLatest: (request) =>
				sql
					.withTransaction(
						Effect.gen(function* () {
							const now = yield* DateTime.now;
							const lockKey = JSON.stringify([request.botId, request.petId]);
							yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
							const settings = yield* food.getSettings(request.petId);
							const latest = yield* food.latestEntry(request.petId);
							const valid =
								settings?.reminderDelay !== null &&
								settings?.reminderDelay !== undefined &&
								latest?.id === request.foodEntryId &&
								DateTime.Equivalence(
									DateTime.addDuration(latest.fedAt, settings.reminderDelay),
									request.runAt,
								);
							if (!valid) {
								yield* cancelLocked(request.botId, request.petId, now);
								return;
							}
							const sent =
								yield* sql`SELECT 1 FROM carneloot.notification_events e JOIN carneloot.notification_deliveries d ON d.event_id=e.id WHERE e.bot_id=${request.botId} AND e.owner_user_id=${request.ownerUserId}::uuid AND e.pet_id=${request.petId}::uuid AND e.food_entry_id=${request.foodEntryId}::uuid AND e.kind='feeding-reminder' AND d.status='sent' LIMIT 1`;
							if (sent.length > 0) {
								yield* cancelLocked(request.botId, request.petId, now);
								return;
							}
							const active = yield* sql<{
								id: string;
								food_entry_id: string | null;
								scheduled_for: Date | string | null;
								job_id: string | null;
								status: 'scheduled' | 'dispatching';
							}>`SELECT id,food_entry_id,scheduled_for,job_id,status FROM carneloot.notification_events WHERE bot_id=${request.botId} AND pet_id=${request.petId}::uuid AND status IN ('scheduled','dispatching') FOR UPDATE`;
							if (
								active.some(
									(event) =>
										event.food_entry_id === request.foodEntryId &&
										event.status === 'dispatching',
								)
							)
								return;
							const matching = active.find(
								(event) =>
									event.food_entry_id === request.foodEntryId &&
									event.scheduled_for !== null &&
									DateTime.Equivalence(
										Schema.decodeUnknownSync(Timestamp)(event.scheduled_for),
										request.runAt,
									) &&
									event.job_id !== null,
							);
							if (matching !== undefined && active.length === 1) return;
							const cancelled = yield* notifications.cancelActiveForPet(
								request.botId,
								request.petId,
								now,
							);
							yield* cancelJobs(cancelled);
							const runAtMillis = DateTime.toEpochMillis(request.runAt);
							const baseDedupe = `feeding-reminder:${request.botId}:${request.petId}:${request.foodEntryId}:${runAtMillis}`;
							const id = Schema.decodeUnknownSync(EventId)(
								yield* crypto.randomUUIDv4.pipe(Effect.orDie),
							);
							let event = yield* notifications.createEvent({
								id,
								botId: request.botId,
								kind: 'feeding-reminder',
								ownerUserId: request.ownerUserId,
								petId: request.petId,
								foodEntryId: request.foodEntryId,
								scheduledFor: request.runAt,
								foodTimestampExplicit: false,
								dedupeKey: baseDedupe,
								now,
							});
							if (event.status === 'cancelled') {
								const revived = yield* notifications.reviveCancelledEvent(
									event.id,
									now,
								);
								if (revived) {
									const restored = yield* notifications.getDispatchContext(
										event.id,
									);
									if (restored === undefined)
										return yield* Effect.fail(
											schedulerError(
												'Revived reminder event disappeared',
												undefined,
												'InvariantViolation',
											),
										);
									event = restored;
								} else {
									const generationId = Schema.decodeUnknownSync(EventId)(
										yield* crypto.randomUUIDv4.pipe(Effect.orDie),
									);
									event = yield* notifications.createEvent({
										id: generationId,
										botId: request.botId,
										kind: 'feeding-reminder',
										ownerUserId: request.ownerUserId,
										petId: request.petId,
										foodEntryId: request.foodEntryId,
										scheduledFor: request.runAt,
										foodTimestampExplicit: false,
										dedupeKey: `${baseDedupe}:${generationId}`,
										now,
									});
								}
							} else if (event.status === 'completed') {
								const generationId = Schema.decodeUnknownSync(EventId)(
									yield* crypto.randomUUIDv4.pipe(Effect.orDie),
								);
								event = yield* notifications.createEvent({
									id: generationId,
									botId: request.botId,
									kind: 'feeding-reminder',
									ownerUserId: request.ownerUserId,
									petId: request.petId,
									foodEntryId: request.foodEntryId,
									scheduledFor: request.runAt,
									foodTimestampExplicit: false,
									dedupeKey: `${baseDedupe}:${generationId}`,
									now,
								});
							}
							const scheduled = yield* jobs.schedule(
								FeedingReminderJob.declaration,
								{
									eventId: event.id,
									botId: request.botId,
									petId: request.petId,
									foodEntryId: request.foodEntryId,
								},
								{
									runAt: request.runAt,
									conflictKey: `feeding-reminder:${request.botId}:${request.petId}`,
								},
							);
							const attached = yield* notifications.attachJob(
								event.id,
								scheduled.id,
								now,
							);
							if (!attached)
								return yield* Effect.fail(
									schedulerError(
										'Failed to attach feeding reminder job',
										undefined,
										'InvariantViolation',
									),
								);
						}).pipe(
							Effect.mapError((cause) =>
								cause instanceof ReminderSchedulerError
									? cause
									: schedulerError('Failed to replace feeding reminder', cause),
							),
						),
					)
					.pipe(
						Effect.mapError((cause) =>
							cause instanceof ReminderSchedulerError
								? cause
								: schedulerError('Failed to replace feeding reminder', cause),
						),
					),
			cancelForPet: (request) =>
				sql
					.withTransaction(
						Effect.gen(function* () {
							const now = yield* DateTime.now;
							const lockKey = JSON.stringify([request.botId, request.petId]);
							yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
							yield* cancelLocked(request.botId, request.petId, now);
						}).pipe(
							Effect.mapError((cause) =>
								schedulerError('Failed to cancel feeding reminder', cause),
							),
						),
					)
					.pipe(
						Effect.mapError((cause) =>
							cause instanceof ReminderSchedulerError
								? cause
								: schedulerError('Failed to cancel feeding reminder', cause),
						),
					),
		} satisfies ReminderSchedulerService;
		return service;
	}),
);

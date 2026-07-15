import * as PgClient from '@effect/sql-pg/PgClient';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { JobRuntime } from 'tfx/JobRuntime';

import { EventId } from '../domain/notifications/NotificationEvent.js';
import * as FeedingReminderJob from '../jobs/FeedingReminderJob.js';
import { NotificationRepository } from '../ports/NotificationRepository.js';
import { PetFoodRepository } from '../ports/PetFoodRepository.js';
import {
	ReminderScheduler,
	ReminderSchedulerError,
	type ReminderSchedulerService,
} from '../ports/ReminderScheduler.js';

const safeCause = (cause: unknown): unknown => {
	if (typeof cause !== 'object' || cause === null)
		return { message: String(cause) };
	const value = cause as {
		readonly _tag?: unknown;
		readonly reason?: unknown;
		readonly code?: unknown;
	};
	return {
		...(typeof value._tag === 'string' ? { tag: value._tag } : {}),
		...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
		...(typeof value.code === 'string' ? { code: value.code } : {}),
	};
};
const schedulerError = (message: string, cause?: unknown) =>
	new ReminderSchedulerError({
		message,
		...(cause === undefined ? {} : { cause: safeCause(cause) }),
	});

export const layer: Layer.Layer<
	ReminderScheduler,
	never,
	PgClient.PgClient | NotificationRepository | PetFoodRepository | JobRuntime
> = Layer.effect(
	ReminderScheduler,
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const notifications = yield* NotificationRepository;
		const food = yield* PetFoodRepository;
		const jobs = yield* JobRuntime;
		const cancelJobs = (
			events: ReadonlyArray<{ readonly jobId: string | null }>,
		) =>
			Effect.forEach(events, (event) =>
				event.jobId === null
					? Effect.void
					: Effect.asVoid(jobs.cancel(event.jobId)),
			);
		const cancelLocked = (botId: string, petId: string, now: number) =>
			Effect.flatMap(
				notifications.cancelActiveForPet(botId as never, petId as never, now),
				cancelJobs,
			);
		const service: ReminderSchedulerService = {
			replaceForLatest: (request) =>
				sql
					.withTransaction(
						Effect.gen(function* () {
							const now = yield* Clock.currentTimeMillis;
							const lockKey = JSON.stringify([request.botId, request.petId]);
							yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
							const settings = yield* food.getSettings(request.petId);
							const latest = yield* food.latestEntry(request.petId);
							const valid =
								settings?.reminderDelayMs !== null &&
								settings?.reminderDelayMs !== undefined &&
								latest?.id === request.foodEntryId &&
								latest.fedAt + settings.reminderDelayMs === request.runAt;
							if (!valid) {
								yield* cancelLocked(request.botId, request.petId, now);
								return;
							}
							const active = yield* sql<{
								id: string;
								food_entry_id: string | null;
								scheduled_for: Date | string | null;
								job_id: string | null;
							}>`SELECT id,food_entry_id,scheduled_for,job_id FROM carneloot.notification_events WHERE bot_id=${request.botId} AND pet_id=${request.petId}::uuid AND status IN ('scheduled','dispatching') FOR UPDATE`;
							const matching = active.find(
								(event) =>
									event.food_entry_id === request.foodEntryId &&
									event.scheduled_for !== null &&
									new Date(event.scheduled_for).getTime() === request.runAt &&
									event.job_id !== null,
							);
							if (matching !== undefined && active.length === 1) return;
							const cancelled = yield* notifications.cancelActiveForPet(
								request.botId,
								request.petId,
								now,
							);
							yield* cancelJobs(cancelled);
							const baseDedupe = `feeding-reminder:${request.botId}:${request.petId}:${request.foodEntryId}:${request.runAt}`;
							const id = Schema.decodeUnknownSync(EventId)(crypto.randomUUID());
							let event = yield* notifications.createEvent({
								id,
								botId: request.botId,
								kind: 'feeding-reminder',
								ownerUserId: request.ownerUserId,
								petId: request.petId,
								foodEntryId: request.foodEntryId,
								scheduledFor: request.runAt,
								dedupeKey: baseDedupe,
								now,
							});
							if (event.status === 'cancelled') {
								const revived = yield* notifications.reviveCancelledEvent(
									event.id,
									now,
								);
								if (revived)
									event = (yield* notifications.getDispatchContext(event.id))!;
								else {
									const generationId = Schema.decodeUnknownSync(EventId)(
										crypto.randomUUID(),
									);
									event = yield* notifications.createEvent({
										id: generationId,
										botId: request.botId,
										kind: 'feeding-reminder',
										ownerUserId: request.ownerUserId,
										petId: request.petId,
										foodEntryId: request.foodEntryId,
										scheduledFor: request.runAt,
										dedupeKey: `${baseDedupe}:${generationId}`,
										now,
									});
								}
							} else if (event.status === 'completed') {
								const generationId = Schema.decodeUnknownSync(EventId)(
									crypto.randomUUID(),
								);
								event = yield* notifications.createEvent({
									id: generationId,
									botId: request.botId,
									kind: 'feeding-reminder',
									ownerUserId: request.ownerUserId,
									petId: request.petId,
									foodEntryId: request.foodEntryId,
									scheduledFor: request.runAt,
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
									schedulerError('Failed to attach feeding reminder job'),
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
							const now = yield* Clock.currentTimeMillis;
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
		};
		return service;
	}),
);

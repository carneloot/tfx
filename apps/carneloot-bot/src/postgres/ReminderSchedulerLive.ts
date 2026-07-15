import * as PgClient from '@effect/sql-pg/PgClient';
import * as Clock from 'effect/Clock';
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
const schedulerError = (message: string, cause?: unknown) =>
	new ReminderSchedulerError({
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
		const cancelJobs = (
			events: ReadonlyArray<{ readonly jobId: string | null }>,
		) =>
			Effect.forEach(events, (event) =>
				event.jobId === null
					? Effect.void
					: Effect.asVoid(jobs.cancel(event.jobId)),
			);
		const cancelLocked = (botId: BotId, petId: PetId, now: number) =>
			Effect.flatMap(
				notifications.cancelActiveForPet(botId, petId, now),
				cancelJobs,
			);
		const service = {
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
								if (revived) {
									const restored = yield* notifications.getDispatchContext(
										event.id,
									);
									if (restored === undefined)
										return yield* Effect.fail(
											schedulerError('Revived reminder event disappeared'),
										);
									event = restored;
								} else {
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
		} satisfies ReminderSchedulerService;
		return service;
	}),
);

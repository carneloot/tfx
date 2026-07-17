import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { JobRuntime } from 'tfx/JobRuntime';

import { DeliveryId } from '../domain/notifications/NotificationDelivery.js';
import { EventId } from '../domain/notifications/NotificationEvent.js';
import * as FoodAddedNotificationJob from '../jobs/FoodAddedNotificationJob.js';
import {
	FoodNotificationScheduler,
	FoodNotificationSchedulerError,
	type FoodNotificationSchedulerService,
} from '../ports/FoodNotificationScheduler.js';
import { NotificationRecipients } from '../ports/NotificationRecipients.js';
import {
	NotificationRepository,
	NotificationRepositoryError,
	type RecipientInput,
} from '../ports/NotificationRepository.js';

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
	};
};
const schedulerError = (
	message: string,
	cause?: unknown,
	reason: 'PersistenceFailure' | 'InvariantViolation' = cause instanceof
		NotificationRepositoryError &&
	(cause.reason === 'Conflict' || cause.reason === 'InvariantViolation')
		? 'InvariantViolation'
		: 'PersistenceFailure',
) =>
	new FoodNotificationSchedulerError({
		reason,
		message,
		...(cause === undefined ? {} : { cause: safeCause(cause) }),
	});

export const layer = Layer.effect(
	FoodNotificationScheduler,
	Effect.gen(function* () {
		const recipients = yield* NotificationRecipients;
		const notifications = yield* NotificationRepository;
		const jobs = yield* JobRuntime;

		const service = {
			scheduleAdded: (request) =>
				Effect.gen(function* () {
					const resolved = yield* recipients.resolvePetRecipients(
						request.botId,
						request.petId,
						{ excludeUserId: request.actorUserId },
					);
					if (resolved.length === 0) return;

					const now = yield* DateTime.now;
					const event = yield* notifications.createEvent({
						id: Schema.decodeUnknownSync(EventId)(crypto.randomUUID()),
						botId: request.botId,
						kind: 'food-added',
						ownerUserId: request.ownerUserId,
						petId: request.petId,
						foodEntryId: request.foodEntryId,
						scheduledFor: now,
						foodTimestampExplicit: request.timestampExplicit,
						dedupeKey: `food-added:${request.botId}:${request.petId}:${request.sourceUpdateId}`,
						now,
					});
					if (event.recipientsMaterializedAt !== null) return;

					const inputs: ReadonlyArray<RecipientInput> = resolved.map(
						({ resolution }) => ({
							...resolution,
							id: Schema.decodeUnknownSync(DeliveryId)(crypto.randomUUID()),
						}),
					);
					yield* notifications.materializeRecipients(event.id, inputs, now);
					const marked = yield* notifications.markRecipientsMaterialized(
						event.id,
						now,
					);
					if (!marked)
						return yield* Effect.fail(
							schedulerError(
								'Failed to freeze food-added recipients',
								undefined,
								'InvariantViolation',
							),
						);
					const scheduled = yield* jobs.schedule(
						FoodAddedNotificationJob.declaration,
						{
							eventId: event.id,
							botId: request.botId,
							petId: request.petId,
							foodEntryId: request.foodEntryId,
						},
						{
							runAt: now,
							conflictKey: `food-added:${request.botId}:${request.petId}:${request.sourceUpdateId}`,
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
								'Failed to attach food-added notification job',
								undefined,
								'InvariantViolation',
							),
						);
				}).pipe(
					Effect.mapError((cause) =>
						cause instanceof FoodNotificationSchedulerError
							? cause
							: schedulerError(
									'Failed to schedule food-added notification',
									cause,
								),
					),
				),
		} satisfies FoodNotificationSchedulerService;
		return service;
	}),
);

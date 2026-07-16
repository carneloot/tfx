import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { Telegram } from 'tfx/Telegram';
import type { TelegramError } from 'tfx/TelegramError';

import type { BotId, PetId } from '../domain/Ids.js';
import type { SafeError } from '../domain/notifications/DeliveryOutcome.js';
import { DeliveryId } from '../domain/notifications/NotificationDelivery.js';
import type { EventId } from '../domain/notifications/NotificationEvent.js';
import * as DayBoundary from '../domain/pet-food/DayBoundary.js';
import type { FoodEntryId } from '../domain/pet-food/PetFood.js';
import {
	FeedingReminderPermanentError,
	FeedingReminderRetryError,
} from '../jobs/FeedingReminderJob.js';
import { NotificationRecipients } from '../ports/NotificationRecipients.js';
import {
	NotificationRepository,
	NotificationRepositoryError,
} from '../ports/NotificationRepository.js';
import { PetFoodRepository } from '../ports/PetFoodRepository.js';
import { PetRepository } from '../ports/PetRepository.js';

export type TelegramDisposition =
	| {
			readonly _tag: 'Retryable';
			readonly delay: Duration.Duration;
			readonly error: SafeError;
	  }
	| { readonly _tag: 'Permanent'; readonly error: SafeError }
	| { readonly _tag: 'Unknown'; readonly error: SafeError };
const safe = (reason: TelegramError['reason']): SafeError => ({
	code: 'errorCode' in reason ? String(reason.errorCode) : reason._tag,
	message: reason._tag,
});
export const classifyTelegramError = (
	error: TelegramError,
): TelegramDisposition => {
	const reason = error.reason;
	switch (reason._tag) {
		case 'RateLimitError':
			return {
				_tag: 'Retryable',
				delay: reason.retryAfter,
				error: safe(reason),
			};
		case 'InternalTelegramError':
		case 'ConflictError':
			return {
				_tag: 'Retryable',
				delay: Duration.seconds(30),
				error: safe(reason),
			};
		case 'AuthenticationError':
		case 'ForbiddenError':
		case 'InvalidRequestError':
		case 'ChatMigrationError':
			return { _tag: 'Permanent', error: safe(reason) };
		case 'NetworkError':
		case 'InvalidResponseError':
		case 'UnknownError':
			return { _tag: 'Unknown', error: safe(reason) };
	}
};
const grams = (milligrams: number) => {
	const value = milligrams / 1_000;
	return Number.isInteger(value)
		? String(value)
		: value.toFixed(3).replace(/0+$/u, '').replace(/\.$/u, '');
};
export const reminderText = (petName: string, totalMg: number) =>
	totalMg > 0
		? `🚨 Hora de dar comida para o pet ${petName}. Já foram ${grams(totalMg)} g hoje.`
		: `🚨 Hora de dar comida para o pet ${petName}. Ainda não foi dada ração hoje.`;

export interface DispatchPayload {
	readonly eventId: EventId;
	readonly botId: BotId;
	readonly petId: PetId;
	readonly foodEntryId: FoodEntryId;
}
const mapRepositoryError = (
	error: NotificationRepositoryError,
): FeedingReminderRetryError | FeedingReminderPermanentError =>
	error.reason === 'PersistenceFailure'
		? new FeedingReminderRetryError({
				message: 'Reminder delivery persistence failed',
				retryAfter: Duration.seconds(1),
			})
		: new FeedingReminderPermanentError({
				message: `Reminder delivery ${error.reason}`,
			});

export const execute = Effect.fn('DispatchNotificationDelivery.execute')(
	function* (
		payload: DispatchPayload,
		options: { readonly leaseDuration?: Duration.Input } = {},
	) {
		const leaseDuration = Duration.fromInputUnsafe(
			options.leaseDuration ?? Duration.seconds(30),
		);
		if (
			!Duration.isFinite(leaseDuration) ||
			!Duration.isPositive(leaseDuration)
		)
			return yield* Effect.fail(
				new FeedingReminderPermanentError({
					message: 'Delivery lease duration must be finite and positive',
				}),
			);
		const logContext = {
			eventId: payload.eventId,
			petId: payload.petId,
			foodEntryId: payload.foodEntryId,
		};
		const now = yield* DateTime.now;
		const notifications = yield* NotificationRepository;
		const event = yield* notifications.getDispatchContext(payload.eventId);
		if (
			event === undefined ||
			(event.status !== 'scheduled' && event.status !== 'dispatching')
		) {
			yield* Effect.logDebug('carneloot.delivery.ignored').pipe(
				Effect.annotateLogs({
					...logContext,
					reason: event === undefined ? 'event_missing' : 'event_inactive',
					...(event === undefined ? {} : { status: event.status }),
				}),
			);
			return;
		}
		if (
			event.botId !== payload.botId ||
			event.petId !== payload.petId ||
			event.foodEntryId !== payload.foodEntryId
		) {
			yield* notifications.cancelEvent(event.id, now);
			yield* Effect.logError('carneloot.delivery.cancelled').pipe(
				Effect.annotateLogs({ ...logContext, reason: 'payload_mismatch' }),
			);
			return yield* Effect.fail(
				new FeedingReminderPermanentError({
					message: 'Reminder payload does not match persisted event',
				}),
			);
		}
		const food = yield* PetFoodRepository;
		const latest = yield* food.latestEntry(payload.petId);
		if (latest?.id !== payload.foodEntryId) {
			yield* notifications.cancelEvent(payload.eventId, now);
			yield* Effect.logInfo('carneloot.delivery.cancelled').pipe(
				Effect.annotateLogs({ ...logContext, reason: 'stale_food_entry' }),
			);
			return;
		}
		const pets = yield* PetRepository;
		const pet = yield* pets.findById(payload.petId);
		if (pet === undefined || pet.ownerId !== event.ownerUserId) {
			yield* notifications.cancelEvent(payload.eventId, now);
			yield* Effect.logWarning('carneloot.delivery.cancelled').pipe(
				Effect.annotateLogs({ ...logContext, reason: 'pet_owner_missing' }),
			);
			return;
		}
		const settings = yield* food.getSettings(payload.petId);
		if (
			settings === undefined ||
			settings.dayStart === null ||
			settings.timeZone === null
		) {
			yield* notifications.cancelEvent(payload.eventId, now);
			yield* Effect.logInfo('carneloot.delivery.cancelled').pipe(
				Effect.annotateLogs({ ...logContext, reason: 'pet_setup_incomplete' }),
			);
			return;
		}
		const recipient = yield* (yield* NotificationRecipients).resolveOwner(
			event.botId,
			event.ownerUserId,
		);
		yield* notifications.materializeRecipients(
			event.id,
			[
				{
					...recipient,
					id: Schema.decodeUnknownSync(DeliveryId)(crypto.randomUUID()),
				},
			],
			now,
		);
		const recovered = yield* notifications.recoverExpired(event.id, now);
		yield* Effect.logInfo('carneloot.delivery.prepared').pipe(
			Effect.annotateLogs({
				...logContext,
				recipientReachable: recipient._tag === 'Reachable',
				recoveredLeases: recovered,
			}),
		);
		const window = DayBoundary.current(now, {
			localTime: settings.dayStart,
			timeZone: settings.timeZone,
		});
		const status = yield* food.status(payload.petId, window.start, window.end);
		const text = reminderText(pet.name, status.totalMg);
		const telegram = yield* Telegram;
		const loop: Effect.Effect<
			void,
			| NotificationRepositoryError
			| FeedingReminderRetryError
			| FeedingReminderPermanentError
		> = Effect.suspend(() =>
			Effect.gen(function* () {
				const claimNow = yield* DateTime.now;
				const claim = yield* notifications.claimNext(
					event.id,
					claimNow,
					leaseDuration,
				);
				if (claim === undefined) return;
				const attemptContext = {
					...logContext,
					deliveryId: claim.delivery.id,
					attempt: claim.delivery.attemptCount,
				};
				if (claim.delivery.recipientChatId === null) {
					yield* Effect.logError('carneloot.delivery.unreachable_claimed').pipe(
						Effect.annotateLogs(attemptContext),
					);
					return yield* Effect.fail(
						new FeedingReminderPermanentError({
							message: 'Claimed unreachable recipient',
						}),
					);
				}
				yield* Effect.logInfo('carneloot.delivery.sending').pipe(
					Effect.annotateLogs(attemptContext),
				);
				const sent = yield* Effect.result(
					telegram.sendMessage({
						chat_id: claim.delivery.recipientChatId,
						text,
					}),
				);
				const completedAt = yield* DateTime.now;
				const persistenceRetry = () =>
					new FeedingReminderRetryError({
						message: 'Delivery finalization persistence failed',
						retryAfter: Duration.max(
							Duration.millis(1),
							DateTime.distance(
								completedAt,
								claim.delivery.sendingLeaseExpiresAt ??
									DateTime.addDuration(completedAt, Duration.millis(1)),
							),
						),
					});
				if (sent._tag === 'Success') {
					const finalized = yield* notifications
						.finalizeSent(
							claim.token,
							event.botId,
							sent.success.message_id,
							completedAt,
						)
						.pipe(Effect.mapError(persistenceRetry));
					if (!finalized) {
						yield* Effect.logWarning('carneloot.delivery.fence_lost').pipe(
							Effect.annotateLogs(attemptContext),
						);
						return yield* Effect.fail(
							new FeedingReminderRetryError({
								message: 'Delivery success fence was lost',
								retryAfter: Duration.max(
									Duration.millis(1),
									DateTime.distance(
										completedAt,
										claim.delivery.sendingLeaseExpiresAt ??
											DateTime.addDuration(completedAt, Duration.millis(1)),
									),
								),
							}),
						);
					}
					yield* Effect.logInfo('carneloot.delivery.sent').pipe(
						Effect.annotateLogs(attemptContext),
					);
				} else {
					const disposition = classifyTelegramError(sent.failure);
					if (disposition._tag === 'Unknown') {
						const finalized = yield* notifications
							.finalizeUnknown(claim.token, disposition.error, completedAt)
							.pipe(Effect.mapError(persistenceRetry));
						if (!finalized) return yield* Effect.fail(persistenceRetry());
						yield* Effect.logError('carneloot.delivery.outcome_unknown').pipe(
							Effect.annotateLogs({
								...attemptContext,
								reason: disposition.error.message,
								code: disposition.error.code,
							}),
						);
					} else {
						const retryable =
							disposition._tag === 'Retryable' &&
							claim.delivery.attemptCount < 8;
						const finalized = yield* notifications
							.finalizeFailed(
								claim.token,
								disposition.error,
								retryable,
								retryable
									? DateTime.addDuration(completedAt, disposition.delay)
									: null,
								completedAt,
							)
							.pipe(Effect.mapError(persistenceRetry));
						if (!finalized) return yield* Effect.fail(persistenceRetry());
						const log = retryable ? Effect.logWarning : Effect.logError;
						yield* log(
							retryable
								? 'carneloot.delivery.retry_scheduled'
								: 'carneloot.delivery.failed',
						).pipe(
							Effect.annotateLogs({
								...attemptContext,
								reason: disposition.error.message,
								code: disposition.error.code,
							}),
						);
					}
				}
				yield* loop;
			}),
		);
		yield* loop;
		const summaryNow = yield* DateTime.now;
		const summary = yield* notifications.summarizeAndComplete(
			event.id,
			summaryNow,
		);
		const summaryContext = {
			...logContext,
			pending: summary.pending,
			sending: summary.sending,
			retryableFailed: summary.retryableFailed,
			terminal: summary.terminal,
		};
		if (summary.completed) {
			yield* Effect.logInfo('carneloot.delivery.event_completed').pipe(
				Effect.annotateLogs(summaryContext),
			);
			return;
		}
		yield* Effect.logWarning('carneloot.delivery.event_incomplete').pipe(
			Effect.annotateLogs(summaryContext),
		);
		const target =
			summary.earliestRetryAt ??
			summary.earliestSendingLeaseExpiry ??
			DateTime.addDuration(summaryNow, Duration.seconds(1));
		return yield* Effect.fail(
			new FeedingReminderRetryError({
				message: 'Notification event still has active deliveries',
				retryAfter: Duration.max(
					Duration.millis(1),
					DateTime.distance(summaryNow, target),
				),
			}),
		);
	},
	(effect) =>
		effect.pipe(
			Effect.mapError((cause) =>
				cause instanceof FeedingReminderRetryError ||
				cause instanceof FeedingReminderPermanentError
					? cause
					: cause instanceof NotificationRepositoryError
						? mapRepositoryError(cause)
						: new FeedingReminderRetryError({
								message: 'Reminder delivery infrastructure failed',
								retryAfter: Duration.seconds(1),
							}),
			),
		),
);

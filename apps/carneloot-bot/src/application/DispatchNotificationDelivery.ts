import * as Clock from 'effect/Clock';
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
import { NotificationRepository } from '../ports/NotificationRepository.js';
import { PetFoodRepository } from '../ports/PetFoodRepository.js';
import { PetRepository } from '../ports/PetRepository.js';

export type TelegramDisposition =
	| {
			readonly _tag: 'Retryable';
			readonly delay: number;
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
				delay: Math.max(1, Duration.toMillis(reason.retryAfter)),
				error: safe(reason),
			};
		case 'InternalTelegramError':
		case 'ConflictError':
			return { _tag: 'Retryable', delay: 30_000, error: safe(reason) };
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
export const execute = (
	payload: DispatchPayload,
	options: { readonly leaseDuration?: number } = {},
) =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis;
		const leaseDuration = options.leaseDuration ?? 30_000;
		const notifications = yield* NotificationRepository;
		const event = yield* notifications.getDispatchContext(payload.eventId);
		if (
			event === undefined ||
			(event.status !== 'scheduled' && event.status !== 'dispatching')
		)
			return;
		if (
			event.botId !== payload.botId ||
			event.petId !== payload.petId ||
			event.foodEntryId !== payload.foodEntryId
		)
			return yield* Effect.fail(
				new FeedingReminderPermanentError({
					message: 'Reminder payload does not match persisted event',
				}),
			);
		const food = yield* PetFoodRepository;
		const latest = yield* food.latestEntry(payload.petId);
		if (latest?.id !== payload.foodEntryId) {
			yield* notifications.cancelEvent(payload.eventId, now);
			return;
		}
		const pets = yield* PetRepository;
		const pet = yield* pets.findById(payload.petId);
		if (pet === undefined || pet.ownerId !== event.ownerUserId) {
			yield* notifications.cancelEvent(payload.eventId, now);
			return;
		}
		const settings = yield* food.getSettings(payload.petId);
		if (
			settings === undefined ||
			settings.dayStart === null ||
			settings.timeZone === null
		) {
			yield* notifications.cancelEvent(payload.eventId, now);
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
		yield* notifications.recoverExpired(event.id, now);
		const window = DayBoundary.current(now, {
			localTime: settings.dayStart,
			timeZone: settings.timeZone,
		});
		const status = yield* food.status(payload.petId, window.start, window.end);
		const text = reminderText(pet.name, status.totalMg);
		const telegram = yield* Telegram;
		const loop: Effect.Effect<void, unknown, never> = Effect.suspend(() =>
			Effect.gen(function* () {
				const claimNow = yield* Clock.currentTimeMillis;
				const claim = yield* notifications.claimNext(
					event.id,
					claimNow,
					leaseDuration,
				);
				if (claim === undefined) return;
				if (claim.delivery.recipientChatId === null)
					return yield* Effect.fail(
						new FeedingReminderPermanentError({
							message: 'Claimed unreachable recipient',
						}),
					);
				const sent = yield* Effect.result(
					telegram.sendMessage({
						chat_id: claim.delivery.recipientChatId,
						text,
					}),
				);
				const completedAt = yield* Clock.currentTimeMillis;
				const persistenceRetry = () =>
					new FeedingReminderRetryError({
						message: 'Delivery finalization persistence failed',
						retryAfter: Math.max(
							1,
							(claim.delivery.sendingLeaseExpiresAt ?? completedAt + 1) -
								completedAt,
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
					if (!finalized)
						return yield* Effect.fail(
							new FeedingReminderRetryError({
								message: 'Delivery success fence was lost',
								retryAfter: Math.max(
									1,
									(claim.delivery.sendingLeaseExpiresAt ?? completedAt + 1) -
										completedAt,
								),
							}),
						);
				} else {
					const disposition = classifyTelegramError(sent.failure);
					if (disposition._tag === 'Unknown') {
						const finalized = yield* notifications
							.finalizeUnknown(claim.token, disposition.error, completedAt)
							.pipe(Effect.mapError(persistenceRetry));
						if (!finalized) return yield* Effect.fail(persistenceRetry());
					} else {
						const retryable =
							disposition._tag === 'Retryable' &&
							claim.delivery.attemptCount < 8;
						const finalized = yield* notifications
							.finalizeFailed(
								claim.token,
								disposition.error,
								retryable,
								retryable ? completedAt + disposition.delay : null,
								completedAt,
							)
							.pipe(Effect.mapError(persistenceRetry));
						if (!finalized) return yield* Effect.fail(persistenceRetry());
					}
				}
				yield* loop;
			}),
		);
		yield* loop;
		const summaryNow = yield* Clock.currentTimeMillis;
		const summary = yield* notifications.summarizeAndComplete(
			event.id,
			summaryNow,
		);
		if (summary.completed) return;
		const target =
			summary.earliestRetryAt ??
			summary.earliestSendingLeaseExpiry ??
			(summary.pending > 0 ? summaryNow + 1_000 : summaryNow + 1_000);
		return yield* Effect.fail(
			new FeedingReminderRetryError({
				message: 'Notification event still has active deliveries',
				retryAfter: Math.max(1, target - summaryNow),
			}),
		);
	}).pipe(
		Effect.mapError((cause) =>
			cause instanceof FeedingReminderRetryError ||
			cause instanceof FeedingReminderPermanentError
				? cause
				: new FeedingReminderRetryError({
						message: 'Reminder delivery infrastructure failed',
						retryAfter: 1_000,
					}),
		),
	);

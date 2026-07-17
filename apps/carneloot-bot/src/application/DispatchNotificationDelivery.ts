import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { Telegram } from 'tfx/Telegram';
import type { TelegramError } from 'tfx/TelegramError';

import {
	DomainPersistenceError,
	UserNotRegistered,
} from '../domain/DomainError.js';
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
import {
	FoodAddedNotificationPermanentError,
	FoodAddedNotificationRetryError,
} from '../jobs/FoodAddedNotificationJob.js';
import { NotificationRecipients } from '../ports/NotificationRecipients.js';
import {
	NotificationRepository,
	NotificationRepositoryError,
} from '../ports/NotificationRepository.js';
import { PetCaregiverRepository } from '../ports/PetCaregiverRepository.js';
import { PetFoodRepository } from '../ports/PetFoodRepository.js';
import { PetRepository } from '../ports/PetRepository.js';
import { UserRepository } from '../ports/UserRepository.js';

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

const localizedFoodTime = (date: Date, timeZone: string) => {
	const parts = new Intl.DateTimeFormat('pt-BR', {
		timeZone,
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(date);
	const value = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value ?? '';
	return `${value('day')}/${value('month')}/${value('year')} ${value('hour')}:${value('minute')}`;
};

export const foodAddedText = (
	actorName: string,
	petName: string,
	amountMg: number,
	fedAt?: { readonly date: Date; readonly timeZone: string },
) =>
	`${actorName} colocou ${grams(amountMg)} g de ração para ${petName}${
		fedAt === undefined
			? ''
			: ` em ${localizedFoodTime(fedAt.date, fedAt.timeZone)}`
	}.`;

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
		if (event.kind !== 'feeding-reminder')
			return yield* Effect.fail(
				new FeedingReminderPermanentError({
					message: 'Unsupported notification event kind',
				}),
			);
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
		const recipients = yield* NotificationRecipients;
		const sql = yield* PgClient.PgClient;
		const materialized = yield* sql.withTransaction(
			Effect.gen(function* () {
				const locked = yield* notifications.lockForMaterialization(event.id);
				if (locked === undefined) return false;
				if (locked.recipientsMaterializedAt !== null) return true;
				const resolved = yield* recipients.resolvePetRecipients(
					locked.botId,
					payload.petId,
				);
				yield* notifications.materializeRecipients(
					locked.id,
					resolved.map(({ resolution }) => ({
						...resolution,
						id: Schema.decodeUnknownSync(DeliveryId)(crypto.randomUUID()),
					})),
					now,
				);
				return yield* notifications.markRecipientsMaterialized(locked.id, now);
			}),
		);
		if (!materialized) return;
		const recovered = yield* notifications.recoverExpired(event.id, now);
		yield* Effect.logInfo('carneloot.delivery.prepared').pipe(
			Effect.annotateLogs({
				...logContext,
				recipientsMaterialized: true,
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
		const caregivers = yield* PetCaregiverRepository;
		const loop: Effect.Effect<
			void,
			| NotificationRepositoryError
			| DomainPersistenceError
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
				if (claim.delivery.recipientRole === 'caregiver') {
					const relation = yield* caregivers.find(
						payload.petId,
						claim.delivery.recipientUserId,
					);
					if (relation?.status !== 'accepted') {
						const finalizedAt = yield* DateTime.now;
						yield* notifications.finalizeFailed(
							claim.token,
							{
								code: 'caregiver-access-revoked',
								message: 'Caregiver access was revoked before delivery',
							},
							false,
							null,
							finalizedAt,
						);
						return yield* loop;
					}
				} else {
					const currentPet = yield* pets.findById(payload.petId);
					if (currentPet?.ownerId !== claim.delivery.recipientUserId) {
						const finalizedAt = yield* DateTime.now;
						yield* notifications.finalizeFailed(
							claim.token,
							{
								code: 'pet-owner-changed',
								message: 'Pet owner changed before delivery',
							},
							false,
							null,
							finalizedAt,
						);
						return yield* loop;
					}
				}
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

const mapFoodRepositoryError = (
	error: NotificationRepositoryError,
): FoodAddedNotificationRetryError | FoodAddedNotificationPermanentError =>
	error.reason === 'PersistenceFailure'
		? new FoodAddedNotificationRetryError({
				message: 'Food notification persistence failed',
				retryAfter: Duration.seconds(1),
			})
		: new FoodAddedNotificationPermanentError({
				message: `Food notification ${error.reason}`,
			});

export const executeFoodAdded = Effect.fn(
	'DispatchNotificationDelivery.executeFoodAdded',
)(
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
				new FoodAddedNotificationPermanentError({
					message: 'Delivery lease duration must be finite and positive',
				}),
			);
		const notifications = yield* NotificationRepository;
		const event = yield* notifications.getDispatchContext(payload.eventId);
		if (
			event === undefined ||
			(event.status !== 'scheduled' && event.status !== 'dispatching')
		)
			return;
		const payloadMatches =
			event.kind === 'food-added' &&
			event.botId === payload.botId &&
			event.petId === payload.petId &&
			event.foodEntryId === payload.foodEntryId;

		const food = yield* PetFoodRepository;
		const pets = yield* PetRepository;
		const users = yield* UserRepository;
		const entry = yield* food.lockEntry(payload.petId, payload.foodEntryId);
		const pet = yield* pets.findById(payload.petId);
		const settings = yield* food.getSettings(payload.petId);
		const actor = yield* users
			.findById(payload.botId, entry?.recordedBy ?? event.ownerUserId)
			.pipe(
				Effect.catchTag('UserNotRegistered', () => Effect.succeed(undefined)),
			);
		const timeZone = settings?.timeZone ?? undefined;
		const contextValid =
			payloadMatches &&
			entry !== undefined &&
			entry.petId === payload.petId &&
			pet !== undefined &&
			pet.ownerId === event.ownerUserId &&
			actor !== undefined &&
			(!event.foodTimestampExplicit || timeZone !== undefined);
		const recoveredAt = yield* DateTime.now;
		yield* notifications.recoverExpired(event.id, recoveredAt);
		const telegram = yield* Telegram;
		const caregivers = yield* PetCaregiverRepository;

		const failRemaining = (
			error: SafeError,
		): Effect.Effect<void, NotificationRepositoryError> =>
			Effect.suspend(() =>
				Effect.gen(function* () {
					const claim = yield* notifications.claimNext(
						event.id,
						yield* DateTime.now,
						leaseDuration,
					);
					if (claim === undefined) return;
					yield* notifications.finalizeFailed(
						claim.token,
						error,
						false,
						null,
						yield* DateTime.now,
					);
					yield* failRemaining(error);
				}),
			);
		if (!contextValid) {
			yield* failRemaining({
				code: 'food-context-missing',
				message: 'Food notification context is missing or invalid',
			});
			yield* notifications.summarizeAndComplete(event.id, yield* DateTime.now);
			return;
		}
		const actorName = [actor.profile.firstName, actor.profile.lastName]
			.filter((part): part is string => part !== null && part.length > 0)
			.join(' ');
		const text = foodAddedText(
			actorName,
			pet.name,
			entry.amountMg,
			event.foodTimestampExplicit && timeZone !== undefined
				? {
						date: DateTime.toDateUtc(entry.fedAt),
						timeZone,
					}
				: undefined,
		);
		const loop: Effect.Effect<
			void,
			| NotificationRepositoryError
			| DomainPersistenceError
			| FoodAddedNotificationRetryError
			| FoodAddedNotificationPermanentError
		> = Effect.suspend(() =>
			Effect.gen(function* () {
				const claim = yield* notifications.claimNext(
					event.id,
					yield* DateTime.now,
					leaseDuration,
				);
				if (claim === undefined) return;
				if (claim.delivery.recipientRole === 'caregiver') {
					const relation = yield* caregivers.find(
						payload.petId,
						claim.delivery.recipientUserId,
					);
					if (relation?.status !== 'accepted') {
						yield* notifications.finalizeFailed(
							claim.token,
							{
								code: 'caregiver-access-revoked',
								message: 'Caregiver access was revoked before delivery',
							},
							false,
							null,
							yield* DateTime.now,
						);
						return yield* loop;
					}
				} else {
					const currentPet = yield* pets.findById(payload.petId);
					if (currentPet?.ownerId !== claim.delivery.recipientUserId) {
						yield* notifications.finalizeFailed(
							claim.token,
							{
								code: 'pet-owner-changed',
								message: 'Pet owner changed before delivery',
							},
							false,
							null,
							yield* DateTime.now,
						);
						return yield* loop;
					}
				}
				if (claim.delivery.recipientChatId === null)
					return yield* Effect.fail(
						new FoodAddedNotificationPermanentError({
							message: 'Claimed unreachable recipient',
						}),
					);
				const sent = yield* Effect.result(
					telegram.sendMessage({
						chat_id: claim.delivery.recipientChatId,
						text,
						disable_notification: true,
					}),
				);
				const completedAt = yield* DateTime.now;
				const retry = () =>
					new FoodAddedNotificationRetryError({
						message: 'Food delivery finalization persistence failed',
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
						.pipe(Effect.mapError(retry));
					if (!finalized) return yield* Effect.fail(retry());
				} else {
					const disposition = classifyTelegramError(sent.failure);
					if (disposition._tag === 'Unknown') {
						const finalized = yield* notifications
							.finalizeUnknown(claim.token, disposition.error, completedAt)
							.pipe(Effect.mapError(retry));
						if (!finalized) return yield* Effect.fail(retry());
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
							.pipe(Effect.mapError(retry));
						if (!finalized) return yield* Effect.fail(retry());
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
		if (summary.completed) return;
		const target =
			summary.earliestRetryAt ??
			summary.earliestSendingLeaseExpiry ??
			DateTime.addDuration(summaryNow, Duration.seconds(1));
		return yield* Effect.fail(
			new FoodAddedNotificationRetryError({
				message: 'Food notification event still has active deliveries',
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
				cause instanceof FoodAddedNotificationRetryError ||
				cause instanceof FoodAddedNotificationPermanentError
					? cause
					: cause instanceof NotificationRepositoryError
						? mapFoodRepositoryError(cause)
						: cause instanceof DomainPersistenceError
							? cause.reason === 'PersistenceFailure'
								? new FoodAddedNotificationRetryError({
										message: 'Food notification persistence failed',
										retryAfter: Duration.seconds(1),
									})
								: new FoodAddedNotificationPermanentError({
										message: 'Food notification context is invalid',
									})
							: cause instanceof UserNotRegistered
								? new FoodAddedNotificationPermanentError({
										message: 'Food notification actor is missing',
									})
								: new FoodAddedNotificationRetryError({
										message: 'Food notification infrastructure failed',
										retryAfter: Duration.seconds(1),
									}),
			),
		),
);

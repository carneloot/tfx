import { Effect, Fiber, Layer, Schema } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { Telegram } from 'tfx/Telegram';
import {
	AuthenticationError,
	ChatMigrationError,
	ConflictError,
	ForbiddenError,
	InternalTelegramError,
	InvalidRequestError,
	InvalidResponseError,
	NetworkError,
	RateLimitError,
	TelegramError,
	UnknownError,
} from 'tfx/TelegramError';
import { describe, expect, it } from 'vitest';

import * as Dispatch from '../../src/application/DispatchNotificationDelivery.js';
import { BotId, PetId, TelegramChatId, UserId } from '../../src/domain/Ids.js';
import { DeliveryId } from '../../src/domain/notifications/NotificationDelivery.js';
import { EventId } from '../../src/domain/notifications/NotificationEvent.js';
import { owner } from '../../src/domain/notifications/RecipientRole.js';
import { FoodEntryId } from '../../src/domain/pet-food/PetFood.js';
import { PetName } from '../../src/domain/Pet.js';
import { NotificationRecipients } from '../../src/ports/NotificationRecipients.js';
import {
	NotificationRepository,
	type NotificationRepositoryService,
} from '../../src/ports/NotificationRepository.js';
import {
	PetFoodRepository,
	type PetFoodRepositoryService,
} from '../../src/ports/PetFoodRepository.js';
import { PetRepository } from '../../src/ports/PetRepository.js';

const eventId = Schema.decodeUnknownSync(EventId)(
	'00000000-0000-4000-8000-000000000001',
);
const petId = Schema.decodeUnknownSync(PetId)(
	'00000000-0000-4000-8000-000000000002',
);
const foodEntryId = Schema.decodeUnknownSync(FoodEntryId)(
	'00000000-0000-4000-8000-000000000003',
);
const deliveryId = Schema.decodeUnknownSync(DeliveryId)(
	'00000000-0000-4000-8000-000000000004',
);
const ownerId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000005',
);
const botId = Schema.decodeUnknownSync(BotId)('carneloot');
const chatId = Schema.decodeUnknownSync(TelegramChatId)(42);
const payload = { eventId, botId, petId, foodEntryId };
const telegramError = (reason: TelegramError['reason']) =>
	new TelegramError({ module: 'Telegram', method: 'sendMessage', reason });

describe('Telegram delivery classification', () => {
	it('classifies exact Telegram reasons', () => {
		expect(
			Dispatch.classifyTelegramError(
				telegramError(
					new RateLimitError({
						errorCode: 429,
						description: 'later',
						retryAfterSeconds: 2,
					}),
				),
			),
		).toMatchObject({ _tag: 'Retryable', delay: 2_000 });
		for (const reason of [
			new InternalTelegramError({ errorCode: 500, description: 'internal' }),
			new ConflictError({ errorCode: 409, description: 'conflict' }),
		])
			expect(
				Dispatch.classifyTelegramError(telegramError(reason)),
			).toMatchObject({ _tag: 'Retryable', delay: 30_000 });
		for (const reason of [
			new InvalidRequestError({ errorCode: 400, description: 'bad' }),
			new ForbiddenError({ errorCode: 403, description: 'no' }),
			new AuthenticationError({ errorCode: 401, description: 'auth' }),
			new ChatMigrationError({
				errorCode: 400,
				description: 'move',
				migrateToChatId: 3,
			}),
		])
			expect(Dispatch.classifyTelegramError(telegramError(reason))._tag).toBe(
				'Permanent',
			);
		for (const reason of [
			new NetworkError({ message: 'network token:secret' }),
			new InvalidResponseError({ message: 'malformed' }),
			new UnknownError({ message: 'unknown' }),
		])
			expect(Dispatch.classifyTelegramError(telegramError(reason))._tag).toBe(
				'Unknown',
			);
	});
	it('formats reminder totals', () => {
		expect(Dispatch.reminderText('Rex', 120_000)).toBe(
			'🚨 Hora de dar comida para o pet Rex. Já foram 120 g hoje.',
		);
		expect(Dispatch.reminderText('Rex', 0)).toBe(
			'🚨 Hora de dar comida para o pet Rex. Ainda não foi dada ração hoje.',
		);
	});
});

const harness = (
	send: Effect.Effect<{ readonly message_id: number }, TelegramError>,
) => {
	let state: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' = 'pending';
	let calls = 0;
	const repository: NotificationRepositoryService = {
		createEvent: () => Effect.die('unused'),
		cancelActiveForPet: () => Effect.die('unused'),
		reviveCancelledEvent: () => Effect.die('unused'),
		cancelEvent: () => Effect.succeed(true),
		attachJob: () => Effect.die('unused'),
		getDispatchContext: () =>
			Effect.succeed({
				id: eventId,
				botId,
				kind: 'feeding-reminder',
				ownerUserId: ownerId,
				petId,
				foodEntryId,
				scheduledFor: 0,
				status: 'scheduled',
				dedupeKey: 'key',
				jobId: null,
				createdAt: 0,
				updatedAt: 0,
				completedAt: null,
				cancelledAt: null,
			}),
		materializeRecipients: () => Effect.succeed([]),
		recoverExpired: () => Effect.succeed(0),
		claimNext: () =>
			state === 'pending'
				? Effect.sync(() => {
						state = 'sending';
						return {
							token: { id: deliveryId, generation: 1 },
							delivery: {
								id: deliveryId,
								eventId,
								recipientUserId: ownerId,
								recipientChatId: chatId,
								recipientRole: owner,
								channel: 'telegram',
								status: 'sending',
								attemptGeneration: 1,
								attemptCount: 1,
								sendingStartedAt: 0,
								sendingLeaseExpiresAt: 30_000,
								retryAt: null,
								retryable: false,
								telegramBotId: null,
								telegramMessageId: null,
								safeError: null,
								sentAt: null,
								failedAt: null,
								unknownAt: null,
								createdAt: 0,
								updatedAt: 0,
							},
						};
					})
				: Effect.succeed(undefined),
		finalizeSent: () =>
			Effect.sync(() => {
				state = 'sent';
				return true;
			}),
		finalizeFailed: (_token, _error, retryable) =>
			Effect.sync(() => {
				state = retryable ? 'failed' : 'sent';
				return true;
			}),
		finalizeUnknown: () =>
			Effect.sync(() => {
				state = 'unknown';
				return true;
			}),
		reconcileUnknownAsSent: () => Effect.die('unused'),
		summarizeAndComplete: () =>
			Effect.succeed({
				pending: state === 'pending' ? 1 : 0,
				sending: state === 'sending' ? 1 : 0,
				retryableFailed: state === 'failed' ? 1 : 0,
				terminal: state === 'sent' || state === 'unknown' ? 1 : 0,
				completed: state === 'sent' || state === 'unknown',
				earliestRetryAt: state === 'failed' ? 2_000 : null,
				earliestSendingLeaseExpiry: state === 'sending' ? 30_000 : null,
			}),
	};
	const food: PetFoodRepositoryService = {
		lockOwnedPet: () => Effect.die('unused'),
		getSettings: () =>
			Effect.succeed({
				petId,
				dayStart: '00:00' as never,
				timeZone: 'UTC' as never,
				reminderDelayMs: 1_000 as never,
				createdAt: 0,
				updatedAt: 0,
			}),
		setDayStart: () => Effect.die('unused'),
		setReminderDelay: () => Effect.die('unused'),
		clearReminderDelay: () => Effect.die('unused'),
		latestEntry: () =>
			Effect.succeed({
				id: foodEntryId,
				petId,
				recordedBy: ownerId,
				amountMg: 1_000 as never,
				fedAt: 0,
				sourceBotId: botId,
				sourceUpdateId: 1,
				sourceMessageChatId: null,
				sourceMessageId: null,
				createdAt: 0,
				updatedAt: 0,
			}),
		findBySource: () => Effect.die('unused'),
		findBusinessDuplicate: () => Effect.die('unused'),
		insert: () => Effect.die('unused'),
		status: () => Effect.succeed({ totalMg: 120_000, latestFedAt: 0 }),
	};
	const layer = Layer.mergeAll(
		Layer.succeed(NotificationRepository, repository),
		Layer.succeed(NotificationRecipients, {
			resolveOwner: () =>
				Effect.succeed({
					_tag: 'Reachable',
					recipientUserId: ownerId,
					recipientChatId: chatId,
					recipientRole: owner,
					channel: 'telegram',
				}),
		}),
		Layer.succeed(PetFoodRepository, food),
		Layer.succeed(PetRepository, {
			findById: () =>
				Effect.succeed({
					id: petId,
					ownerId,
					name: Schema.decodeUnknownSync(PetName)('Rex'),
					createdAt: 0,
					updatedAt: 0,
				}),
			addOwned: () => Effect.die('unused'),
			listOwned: () => Effect.die('unused'),
		}),
		Layer.succeed(Telegram, {
			sendMessage: () =>
				Effect.sync(() => {
					calls++;
				}).pipe(Effect.andThen(send)),
		} as never),
		TestClock.layer(),
	);
	return { layer, state: () => state, calls: () => calls };
};

describe('delivery dispatcher', () => {
	it('sends and finalizes success', async () => {
		const h = harness(Effect.succeed({ message_id: 7 }));
		await Effect.runPromise(Effect.provide(Dispatch.execute(payload), h.layer));
		expect(h.calls()).toBe(1);
		expect(h.state()).toBe('sent');
	});
	it('returns the exact typed retry delay for rate limits', async () => {
		const h = harness(
			Effect.fail(
				telegramError(
					new RateLimitError({
						errorCode: 429,
						description: 'later',
						retryAfterSeconds: 2,
					}),
				),
			),
		);
		const result = await Effect.runPromise(
			Effect.provide(Effect.result(Dispatch.execute(payload)), h.layer),
		);
		expect(result).toMatchObject({
			_tag: 'Failure',
			failure: {
				_tag: 'FeedingReminderRetryError',
				retryAfter: 2_000,
			},
		});
	});

	it('marks ambiguous network outcomes unknown and never resends', async () => {
		const h = harness(
			Effect.fail(telegramError(new NetworkError({ message: 'network' }))),
		);
		await Effect.runPromise(Effect.provide(Dispatch.execute(payload), h.layer));
		await Effect.runPromise(Effect.provide(Dispatch.execute(payload), h.layer));
		expect(h.calls()).toBe(1);
		expect(h.state()).toBe('unknown');
	});
	it('preserves interruption with a committed sending fence', async () => {
		const h = harness(Effect.never);
		await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const fiber = yield* Effect.forkChild(Dispatch.execute(payload));
					yield* Effect.yieldNow;
					yield* Fiber.interrupt(fiber);
				}),
				h.layer,
			),
		);
		expect(h.state()).toBe('sending');
	});
});

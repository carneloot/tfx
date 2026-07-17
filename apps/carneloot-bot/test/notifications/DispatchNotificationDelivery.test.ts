import * as PgClient from '@effect/sql-pg/PgClient';
import {
	Deferred,
	Effect,
	Fiber,
	Layer,
	Logger,
	References,
	Schema,
} from 'effect';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
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
	NotificationRepositoryError,
	type NotificationRepositoryService,
} from '../../src/ports/NotificationRepository.js';
import { PetCaregiverRepository } from '../../src/ports/PetCaregiverRepository.js';
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
		).toMatchObject({ _tag: 'Retryable', delay: Duration.seconds(2) });
		for (const reason of [
			new InternalTelegramError({ errorCode: 500, description: 'internal' }),
			new ConflictError({ errorCode: 409, description: 'conflict' }),
		])
			expect(
				Dispatch.classifyTelegramError(telegramError(reason)),
			).toMatchObject({ _tag: 'Retryable', delay: Duration.seconds(30) });
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

interface CapturedLog {
	readonly message: unknown;
	readonly level: string;
	readonly annotations: Readonly<Record<string, unknown>>;
}
const captureLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
	const logs: Array<CapturedLog> = [];
	const logger = Logger.make((options) => {
		logs.push({
			message:
				Array.isArray(options.message) && options.message.length === 1
					? options.message[0]
					: options.message,
			level: options.logLevel,
			annotations: options.fiber.getRef(References.CurrentLogAnnotations),
		});
	});
	return Effect.as(
		Effect.provideService(effect, Logger.CurrentLoggers, new Set([logger])),
		logs,
	);
};

interface HarnessOptions {
	readonly attemptCount?: number;
	readonly reachable?: boolean;
	readonly latest?: boolean;
	readonly eventStatus?: 'scheduled' | 'completed' | 'cancelled';
	readonly initialState?: 'pending' | 'sending' | 'failed' | 'sent' | 'unknown';
	readonly finalize?: 'success' | 'false' | 'error';
	readonly mismatchedEvent?: boolean;
	readonly repositoryFailure?: NotificationRepositoryError['reason'];
}
const unused = () => Effect.die('unused');
const harness = (
	send: Effect.Effect<{ readonly message_id: number }, TelegramError>,
	options: HarnessOptions = {},
) => {
	let state:
		| 'pending'
		| 'sending'
		| 'sent'
		| 'failed'
		| 'permanent'
		| 'unknown' = options.initialState ?? 'pending';
	let calls = 0;
	let lastError: unknown;
	let lastRetryAt: DateTime.Utc | null = null;
	let cancelled = false;
	let materializations = 0;
	let recipientsMaterialized = false;
	const persistedEvent = {
		id: eventId,
		botId: options.mismatchedEvent
			? Schema.decodeUnknownSync(BotId)('another-bot')
			: botId,
		kind: 'feeding-reminder',
		ownerUserId: ownerId,
		petId,
		foodEntryId,
		scheduledFor: DateTime.makeUnsafe(0),
		status: options.eventStatus ?? 'scheduled',
		dedupeKey: 'key',
		jobId: null,
		recipientsMaterializedAt: null,
		foodTimestampExplicit: false,
		createdAt: DateTime.makeUnsafe(0),
		updatedAt: DateTime.makeUnsafe(0),
		completedAt: null,
		cancelledAt: null,
	} as const;
	const repository: NotificationRepositoryService = {
		createEvent: () => Effect.die('unused'),
		cancelActiveForPet: () => Effect.die('unused'),
		reviveCancelledEvent: () => Effect.die('unused'),
		cancelEvent: () =>
			Effect.sync(() => {
				cancelled = true;
				return true;
			}),
		attachJob: () => Effect.die('unused'),
		getDispatchContext: () =>
			options.repositoryFailure === undefined
				? Effect.succeed(persistedEvent)
				: Effect.fail(
						new NotificationRepositoryError({
							reason: options.repositoryFailure,
							message: 'repository test failure',
						}),
					),
		lockForMaterialization: () =>
			Effect.succeed({
				...persistedEvent,
				recipientsMaterializedAt: recipientsMaterialized
					? DateTime.makeUnsafe(0)
					: null,
			}),
		markRecipientsMaterialized: () =>
			Effect.sync(() => {
				recipientsMaterialized = true;
				return true;
			}),
		materializeRecipients: (_eventId, recipients) =>
			Effect.sync(() => {
				materializations++;
				if (recipients[0]?._tag === 'Unreachable') state = 'permanent';
				return [];
			}),
		recoverExpired: () => Effect.succeed(0),
		recoverAllExpired: () => Effect.succeed(0),
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
								attemptCount: options.attemptCount ?? 1,
								sendingStartedAt: DateTime.makeUnsafe(0),
								sendingLeaseExpiresAt: DateTime.makeUnsafe(30_000),
								retryAt: null,
								retryable: false,
								telegramBotId: null,
								telegramMessageId: null,
								safeError: null,
								sentAt: null,
								failedAt: null,
								unknownAt: null,
								createdAt: DateTime.makeUnsafe(0),
								updatedAt: DateTime.makeUnsafe(0),
							},
						};
					})
				: Effect.succeed(undefined),
		finalizeSent: () =>
			options.finalize === 'error'
				? Effect.fail(
						new NotificationRepositoryError({
							reason: 'PersistenceFailure',
							message: 'finalization failed',
						}),
					)
				: Effect.sync(() => {
						if (options.finalize !== 'false') state = 'sent';
						return options.finalize !== 'false';
					}),
		finalizeFailed: (_token, error, retryable, retryAt) =>
			Effect.sync(() => {
				lastError = error;
				lastRetryAt = retryAt;
				state = retryable ? 'failed' : 'permanent';
				return true;
			}),
		finalizeUnknown: (_token, error) =>
			Effect.sync(() => {
				lastError = error;
				state = 'unknown';
				return true;
			}),
		reconcileUnknownAsSent: () => Effect.die('unused'),
		findSentByTelegramMessage: () => unused(),
		summarizeAndComplete: () =>
			Effect.succeed({
				pending: state === 'pending' ? 1 : 0,
				sending: state === 'sending' ? 1 : 0,
				retryableFailed: state === 'failed' ? 1 : 0,
				terminal:
					state === 'sent' || state === 'unknown' || state === 'permanent'
						? 1
						: 0,
				completed:
					state === 'sent' || state === 'unknown' || state === 'permanent',
				earliestRetryAt:
					state === 'failed'
						? (lastRetryAt ?? DateTime.makeUnsafe(2_000))
						: null,
				earliestSendingLeaseExpiry:
					state === 'sending' ? DateTime.makeUnsafe(30_000) : null,
			}),
	};
	const food: PetFoodRepositoryService = {
		lockOwnedPet: () => Effect.die('unused'),
		getSettings: () =>
			Effect.succeed({
				petId,
				dayStart: '00:00' as never,
				timeZone: 'UTC' as never,
				reminderDelay: Duration.seconds(1),
				createdAt: DateTime.makeUnsafe(0),
				updatedAt: DateTime.makeUnsafe(0),
			}),
		setDayStart: () => Effect.die('unused'),
		setReminderDelay: () => Effect.die('unused'),
		clearReminderDelay: () => Effect.die('unused'),
		latestEntry: () =>
			Effect.succeed({
				id:
					options.latest === false
						? Schema.decodeUnknownSync(FoodEntryId)(
								'00000000-0000-4000-8000-000000000099',
							)
						: foodEntryId,
				petId,
				recordedBy: ownerId,
				amountMg: 1_000 as never,
				fedAt: DateTime.makeUnsafe(0),
				sourceBotId: botId,
				sourceUpdateId: 1,
				sourceMessageChatId: null,
				sourceMessageId: null,
				createdAt: DateTime.makeUnsafe(0),
				updatedAt: DateTime.makeUnsafe(0),
			}),
		findBySource: () => Effect.die('unused'),
		findBusinessDuplicate: () => Effect.die('unused'),
		findBusinessDuplicateExcluding: unused,
		insert: () => Effect.die('unused'),
		listEntries: unused,
		lockEntry: unused,
		updateEntry: unused,
		deleteEntry: unused,
		status: () =>
			Effect.succeed({ totalMg: 120_000, latestFedAt: DateTime.makeUnsafe(0) }),
	};
	const layer = Layer.mergeAll(
		Layer.succeed(NotificationRepository, repository),
		Layer.succeed(NotificationRecipients, {
			resolvePetRecipients: () =>
				Effect.succeed([
					{
						userId: ownerId,
						role: 'owner' as const,
						resolution:
							options.reachable === false
								? {
										_tag: 'Unreachable' as const,
										recipientUserId: ownerId,
										recipientRole: owner,
										channel: 'telegram' as const,
										error: {
											code: 'MissingTelegramIdentity',
											message: 'No identity',
										},
									}
								: {
										_tag: 'Reachable' as const,
										recipientUserId: ownerId,
										recipientChatId: chatId,
										recipientRole: owner,
										channel: 'telegram' as const,
									},
					},
				]),
			resolveOwner: () =>
				Effect.succeed(
					options.reachable === false
						? {
								_tag: 'Unreachable' as const,
								recipientUserId: ownerId,
								recipientRole: owner,
								channel: 'telegram' as const,
								error: {
									code: 'MissingTelegramIdentity',
									message: 'No identity',
								},
							}
						: {
								_tag: 'Reachable' as const,
								recipientUserId: ownerId,
								recipientChatId: chatId,
								recipientRole: owner,
								channel: 'telegram' as const,
							},
				),
		}),
		Layer.succeed(PetFoodRepository, food),
		Layer.succeed(PetCaregiverRepository, {
			find: () => Effect.succeed(undefined),
			lock: unused,
			insertPending: unused,
			setPendingResponse: unused,
			remove: unused,
			listForPet: unused,
			listPendingForUser: unused,
			listAcceptedForUser: unused,
		}),
		Layer.succeed(PgClient.PgClient, {
			withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
		} as never),
		Layer.succeed(PetRepository, {
			findById: () =>
				Effect.succeed({
					id: petId,
					ownerId,
					name: Schema.decodeUnknownSync(PetName)('Rex'),
					createdAt: DateTime.makeUnsafe(0),
					updatedAt: DateTime.makeUnsafe(0),
				}),
			lockById: () =>
				Effect.succeed({
					id: petId,
					ownerId,
					name: Schema.decodeUnknownSync(PetName)('Rex'),
					createdAt: DateTime.makeUnsafe(0),
					updatedAt: DateTime.makeUnsafe(0),
				}),
			deleteOwned: () => Effect.die('unused'),
			addOwned: () => Effect.die('unused'),
			listOwned: () => Effect.die('unused'),
			listAccessible: () => Effect.die('unused'),
		}),
		Layer.succeed(Telegram, {
			sendMessage: () =>
				Effect.sync(() => {
					calls++;
				}).pipe(Effect.andThen(send)),
		} as never),
		TestClock.layer(),
	);
	return {
		layer,
		state: () => state,
		calls: () => calls,
		lastError: () => lastError,
		lastRetryAt: () => lastRetryAt,
		cancelled: () => cancelled,
		materializations: () => materializations,
	};
};

describe('delivery dispatcher', () => {
	it('retries repository persistence failures', async () => {
		const h = harness(Effect.succeed({ message_id: 1 }), {
			repositoryFailure: 'PersistenceFailure',
		});
		const result = await Effect.runPromise(
			Effect.provide(Effect.result(Dispatch.execute(payload)), h.layer),
		);
		expect(result).toMatchObject({
			_tag: 'Failure',
			failure: {
				_tag: 'FeedingReminderRetryError',
				retryAfter: Duration.seconds(1),
			},
		});
		expect(h.calls()).toBe(0);
	});

	it.each(['InvariantViolation', 'NotFound', 'Conflict'] as const)(
		'makes repository %s failures permanent',
		async (repositoryFailure) => {
			const h = harness(Effect.succeed({ message_id: 1 }), {
				repositoryFailure,
			});
			const result = await Effect.runPromise(
				Effect.provide(Effect.result(Dispatch.execute(payload)), h.layer),
			);
			expect(result).toMatchObject({
				_tag: 'Failure',
				failure: { _tag: 'FeedingReminderPermanentError' },
			});
			expect(h.calls()).toBe(0);
		},
	);

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		'rejects invalid lease %s before recipient side effects',
		async (leaseDuration) => {
			const h = harness(Effect.succeed({ message_id: 7 }));
			const result = await Effect.runPromise(
				Effect.provide(
					Effect.result(Dispatch.execute(payload, { leaseDuration })),
					h.layer,
				),
			);
			expect(result).toMatchObject({
				_tag: 'Failure',
				failure: { _tag: 'FeedingReminderPermanentError' },
			});
			expect(h.materializations()).toBe(0);
			expect(h.calls()).toBe(0);
		},
	);

	it('cancels a mismatched persisted event before permanent failure', async () => {
		const h = harness(Effect.succeed({ message_id: 7 }), {
			mismatchedEvent: true,
		});
		const result = await Effect.runPromise(
			Effect.provide(Effect.result(Dispatch.execute(payload)), h.layer),
		);
		expect(result).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'FeedingReminderPermanentError' },
		});
		expect(h.cancelled()).toBe(true);
		expect(h.materializations()).toBe(0);
		expect(h.calls()).toBe(0);
	});

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
				retryAfter: Duration.millis(2_000),
			},
		});
	});

	it('finalizes definitive permanent failures without retry', async () => {
		for (const reason of [
			new InvalidRequestError({
				errorCode: 400,
				description: 'bad token:secret',
			}),
			new ForbiddenError({
				errorCode: 403,
				description: 'forbidden token:secret',
			}),
			new AuthenticationError({
				errorCode: 401,
				description: 'auth token:secret',
			}),
			new ChatMigrationError({
				errorCode: 400,
				description: 'move token:secret',
				migrateToChatId: 3,
			}),
		]) {
			const h = harness(Effect.fail(telegramError(reason)));
			await Effect.runPromise(
				Effect.provide(Dispatch.execute(payload), h.layer),
			);
			expect(h.state()).toBe('permanent');
			expect(h.lastRetryAt()).toBeNull();
			expect(JSON.stringify(h.lastError())).not.toContain('token:secret');
		}
	});

	it('uses the exact fallback for internal/conflict and makes attempt eight permanent', async () => {
		for (const reason of [
			new InternalTelegramError({ errorCode: 500, description: 'internal' }),
			new ConflictError({ errorCode: 409, description: 'conflict' }),
		]) {
			const h = harness(Effect.fail(telegramError(reason)));
			const result = await Effect.runPromise(
				Effect.provide(Effect.result(Dispatch.execute(payload)), h.layer),
			);
			expect(result).toMatchObject({
				_tag: 'Failure',
				failure: {
					_tag: 'FeedingReminderRetryError',
					retryAfter: Duration.millis(30_000),
				},
			});
			expect(DateTime.toEpochMillis(h.lastRetryAt()!)).toBe(30_000);
		}
		const final = harness(
			Effect.fail(
				telegramError(
					new InternalTelegramError({ errorCode: 500, description: 'last' }),
				),
			),
			{ attemptCount: 8 },
		);
		await Effect.runPromise(
			Effect.provide(Dispatch.execute(payload), final.layer),
		);
		expect(final.state()).toBe('permanent');
	});

	it('audits unreachable recipients and cancels stale latest food without Telegram', async () => {
		const unreachable = harness(Effect.succeed({ message_id: 1 }), {
			reachable: false,
		});
		await Effect.runPromise(
			Effect.provide(Dispatch.execute(payload), unreachable.layer),
		);
		expect(unreachable.calls()).toBe(0);
		expect(unreachable.state()).toBe('permanent');
		const stale = harness(Effect.succeed({ message_id: 1 }), { latest: false });
		await Effect.runPromise(
			Effect.provide(Dispatch.execute(payload), stale.layer),
		);
		expect(stale.calls()).toBe(0);
		expect(stale.cancelled()).toBe(true);
	});

	it('uses earliest future retry and active sending lease delays', async () => {
		for (const [initialState, retryAfter] of [
			['failed', Duration.seconds(2)],
			['sending', Duration.seconds(30)],
		] as const) {
			const h = harness(Effect.succeed({ message_id: 1 }), { initialState });
			const result = await Effect.runPromise(
				Effect.provide(Effect.result(Dispatch.execute(payload)), h.layer),
			);
			expect(result).toMatchObject({
				_tag: 'Failure',
				failure: { _tag: 'FeedingReminderRetryError', retryAfter },
			});
			expect(h.calls()).toBe(0);
		}
	});

	it.each(['false', 'error'] as const)(
		'retries at the lease fence when finalization returns %s',
		async (finalize) => {
			const h = harness(Effect.succeed({ message_id: 7 }), { finalize });
			const result = await Effect.runPromise(
				Effect.provide(Effect.result(Dispatch.execute(payload)), h.layer),
			);
			expect(result).toMatchObject({
				_tag: 'Failure',
				failure: {
					_tag: 'FeedingReminderRetryError',
					retryAfter: Duration.millis(30_000),
				},
			});
			expect(h.state()).toBe('sending');
		},
	);

	it('logs sanitized ambiguous outcomes and never resends', async () => {
		const h = harness(
			Effect.fail(
				telegramError(new NetworkError({ message: 'network token:secret' })),
			),
		);
		const logs = await Effect.runPromise(
			captureLogs(
				Effect.provide(
					Effect.andThen(Dispatch.execute(payload), Dispatch.execute(payload)),
					h.layer,
				),
			),
		);
		expect(h.calls()).toBe(1);
		expect(h.state()).toBe('unknown');
		expect(logs).toContainEqual({
			message: 'carneloot.delivery.outcome_unknown',
			level: 'Error',
			annotations: {
				eventId,
				petId,
				foodEntryId,
				deliveryId,
				attempt: 1,
				reason: 'NetworkError',
				code: 'NetworkError',
			},
		});
		expect(JSON.stringify(logs)).not.toContain('token:secret');
		expect(JSON.stringify(logs)).not.toContain(String(chatId));
	});
	it('preserves interruption with a committed sending fence', async () => {
		const started = Deferred.makeUnsafe<void>();
		const h = harness(
			Effect.andThen(Deferred.succeed(started, undefined), Effect.never),
		);
		await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const fiber = yield* Effect.forkChild(Dispatch.execute(payload));
					yield* Deferred.await(started);
					yield* Fiber.interrupt(fiber);
				}),
				h.layer,
			),
		);
		expect(h.state()).toBe('sending');
	});
});

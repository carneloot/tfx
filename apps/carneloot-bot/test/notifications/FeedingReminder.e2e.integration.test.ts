import * as PgClient from '@effect/sql-pg/PgClient';
import * as PostgresJobStore from '@tfx/postgres/PostgresJobStore';
import { Deferred, Effect, Fiber, Layer, Schema } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { JobRuntime } from 'tfx/JobRuntime';
import * as JobRuntimeLive from 'tfx/JobRuntime';
import { Telegram } from 'tfx/Telegram';
import { NetworkError, RateLimitError, TelegramError } from 'tfx/TelegramError';
import { describe, expect, it } from 'vitest';

import { BotId, TelegramChatId, TelegramUserId } from '../../src/domain/Ids.js';
import { EventId } from '../../src/domain/notifications/NotificationEvent.js';
import { FoodAmountMg } from '../../src/domain/pet-food/FoodAmount.js';
import { FoodEntryId } from '../../src/domain/pet-food/PetFood.js';
import { PetName } from '../../src/domain/Pet.js';
import * as FeedingReminderJobLive from '../../src/jobs/FeedingReminderJobLive.js';
import { NotificationRepository } from '../../src/ports/NotificationRepository.js';
import { PetFoodRepository } from '../../src/ports/PetFoodRepository.js';
import { PetRepository } from '../../src/ports/PetRepository.js';
import { ReminderScheduler } from '../../src/ports/ReminderScheduler.js';
import { UserRepository } from '../../src/ports/UserRepository.js';
import * as NotificationRecipientsLive from '../../src/postgres/NotificationRecipientsLive.js';
import * as NotificationRepositoryLive from '../../src/postgres/NotificationRepositoryLive.js';
import * as PetFoodRepositoryLive from '../../src/postgres/PetFoodRepositoryLive.js';
import * as PetRepositoryLive from '../../src/postgres/PetRepositoryLive.js';
import * as ReminderSchedulerLive from '../../src/postgres/ReminderSchedulerLive.js';
import * as UserRepositoryLive from '../../src/postgres/UserRepositoryLive.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
type Mode = 'success' | 'network' | 'rate' | 'block';
const control: {
	mode: Mode;
	calls: number;
	started: Deferred.Deferred<void> | undefined;
} = { mode: 'success', calls: 0, started: undefined };
const botId = Schema.decodeUnknownSync(BotId)('carneloot');
const telegram = Layer.succeed(Telegram, {
	sendMessage: () =>
		Effect.suspend(() => {
			control.calls++;
			if (control.mode === 'block')
				return Effect.andThen(
					Deferred.succeed(control.started!, undefined),
					Effect.never,
				);
			if (control.mode === 'network')
				return Effect.fail(
					new TelegramError({
						module: 'Telegram',
						method: 'sendMessage',
						reason: new NetworkError({ message: 'network' }),
					}),
				);
			if (control.mode === 'rate')
				return Effect.fail(
					new TelegramError({
						module: 'Telegram',
						method: 'sendMessage',
						reason: new RateLimitError({
							errorCode: 429,
							description: 'later',
							retryAfterSeconds: 2,
						}),
					}),
				);
			return Effect.succeed({ message_id: 77 });
		}),
} as never);
const pg = PostgresTestLayer.layer;
const stores = Layer.provideMerge(
	Layer.mergeAll(
		UserRepositoryLive.layer,
		PetRepositoryLive.layer,
		PetFoodRepositoryLive.layer,
		NotificationRepositoryLive.layer,
		NotificationRecipientsLive.layer,
		PostgresJobStore.layer({ schema: 'tfx_feeding_e2e', tablePrefix: 'case_' }),
	),
	pg,
);
const runtime = Layer.provideMerge(
	JobRuntimeLive.layer(FeedingReminderJobLive.implementation),
	Layer.merge(stores, telegram),
);
const scheduler = Layer.provideMerge(
	ReminderSchedulerLive.layer,
	Layer.merge(stores, runtime),
);
const layer = Layer.mergeAll(
	stores,
	runtime,
	scheduler,
	telegram,
	TestClock.layer(),
);

const scheduleFixture = Effect.gen(function* () {
	const suffix = crypto.randomUUID();
	const telegramId = Math.floor(Math.random() * 1_000_000_000) + 1;
	const user = yield* (yield* UserRepository).registerTelegramProfile({
		botId,
		telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(telegramId),
		username: null,
		firstName: 'Reminder',
		lastName: null,
		privateChatId: Schema.decodeUnknownSync(TelegramChatId)(telegramId),
	});
	const pet = yield* (yield* PetRepository).addOwned(
		user.user.id,
		Schema.decodeUnknownSync(PetName)(`Reminder ${suffix}`),
	);
	const food = yield* PetFoodRepository;
	yield* food.setDayStart(pet.id, '00:00' as never, 'UTC' as never, 1_000);
	yield* food.setReminderDelay(pet.id, 1_000 as never, 1_000);
	const entry = yield* food.insert({
		id: Schema.decodeUnknownSync(FoodEntryId)(crypto.randomUUID()),
		petId: pet.id,
		recordedBy: user.user.id,
		amountMg: Schema.decodeUnknownSync(FoodAmountMg)(50_000),
		fedAt: 2_000,
		source: {
			botId,
			updateId: telegramId,
			messageChatId: null,
			messageId: null,
		},
		now: 2_000,
	});
	yield* (yield* ReminderScheduler).replaceForLatest({
		botId,
		ownerUserId: user.user.id,
		petId: pet.id,
		foodEntryId: entry.id,
		runAt: 3_000,
	});
	const sql = yield* PgClient.PgClient;
	const [event] = yield* sql<{
		id: string;
		job_id: string;
	}>`SELECT id,job_id FROM carneloot.notification_events WHERE pet_id=${pet.id}::uuid AND status='scheduled'`;
	return { user, pet, entry, event: event! };
});
const runFresh = Effect.provide(
	Effect.flatMap(JobRuntime, (jobs) => jobs.runOne({ leaseDuration: 100 })),
	Layer.fresh(runtime),
);

if (!enabled)
	describe.skip('feeding reminder e2e PostgreSQL', () => {
		it('requires TEST_DATABASE_URL or RUN_TESTCONTAINERS=true', () => {});
	});
else
	describe('feeding reminder e2e PostgreSQL', () => {
		it('persists sent delivery and completes event through a rebuilt runtime', async () => {
			control.mode = 'success';
			control.calls = 0;
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(2_000);
				const fixture = yield* scheduleFixture;
				yield* TestClock.setTime(3_000);
				expect(yield* runFresh).toMatchObject({ status: 'completed' });
				const sql = yield* PgClient.PgClient;
				const [delivery] = yield* sql<{
					status: string;
					telegram_message_id: string;
				}>`SELECT status,telegram_message_id FROM carneloot.notification_deliveries WHERE event_id=${fixture.event.id}::uuid`;
				const [event] = yield* sql<{
					status: string;
				}>`SELECT status FROM carneloot.notification_events WHERE id=${fixture.event.id}::uuid`;
				expect(delivery).toMatchObject({
					status: 'sent',
					telegram_message_id: '77',
				});
				expect(event?.status).toBe('completed');
			});
			await Effect.runPromise(Effect.provide(program, layer));
			expect(control.calls).toBe(1);
		});

		it('audits missing identity and skips Telegram', async () => {
			control.mode = 'success';
			control.calls = 0;
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(2_000);
				const fixture = yield* scheduleFixture;
				const sql = yield* PgClient.PgClient;
				yield* sql`DELETE FROM carneloot.telegram_identities WHERE user_id=${fixture.user.user.id}::uuid`;
				yield* TestClock.setTime(3_000);
				yield* runFresh;
				const [delivery] = yield* sql<{
					status: string;
					recipient_chat_id: string | null;
				}>`SELECT status,recipient_chat_id FROM carneloot.notification_deliveries WHERE event_id=${fixture.event.id}::uuid`;
				expect(delivery).toEqual({ status: 'failed', recipient_chat_id: null });
			});
			await Effect.runPromise(Effect.provide(program, layer));
			expect(control.calls).toBe(0);
		});

		it('persists unknown without resend and schedules exact rate retry', async () => {
			for (const mode of ['network', 'rate'] as const) {
				control.mode = mode;
				control.calls = 0;
				const program = Effect.gen(function* () {
					yield* TestClock.setTime(2_000);
					const fixture = yield* scheduleFixture;
					yield* TestClock.setTime(3_000);
					const first = yield* runFresh;
					const sql = yield* PgClient.PgClient;
					const [delivery] = yield* sql<{
						status: string;
						retry_at: Date | null;
					}>`SELECT status,retry_at FROM carneloot.notification_deliveries WHERE event_id=${fixture.event.id}::uuid`;
					if (mode === 'network') {
						expect(delivery?.status).toBe('unknown');
						expect(yield* runFresh).toBeUndefined();
					} else {
						expect(first).toMatchObject({ status: 'scheduled', runAt: 5_000 });
						expect(delivery?.retry_at?.getTime()).toBe(5_000);
					}
				});
				await Effect.runPromise(Effect.provide(program, layer));
				expect(control.calls).toBe(1);
			}
		});

		it('recovers an interrupted committed send fence to unknown', async () => {
			control.mode = 'block';
			control.calls = 0;
			control.started = Deferred.makeUnsafe<void>();
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(2_000);
				const fixture = yield* scheduleFixture;
				yield* TestClock.setTime(3_000);
				const fiber = yield* Effect.forkChild(runFresh);
				yield* Deferred.await(control.started!);
				yield* Fiber.interrupt(fiber);
				const sql = yield* PgClient.PgClient;
				const [sending] = yield* sql<{
					status: string;
				}>`SELECT status FROM carneloot.notification_deliveries WHERE event_id=${fixture.event.id}::uuid`;
				expect(sending?.status).toBe('sending');
				yield* TestClock.setTime(3_101);
				yield* (yield* NotificationRepository).recoverExpired(
					Schema.decodeUnknownSync(EventId)(fixture.event.id),
					3_101,
				);
				const [unknown] = yield* sql<{
					status: string;
				}>`SELECT status FROM carneloot.notification_deliveries WHERE event_id=${fixture.event.id}::uuid`;
				expect(unknown?.status).toBe('unknown');
			});
			await Effect.runPromise(Effect.provide(program, layer));
		});

		it('cancels stale latest food before Telegram', async () => {
			control.mode = 'success';
			control.calls = 0;
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(2_000);
				const fixture = yield* scheduleFixture;
				const food = yield* PetFoodRepository;
				yield* food.insert({
					id: Schema.decodeUnknownSync(FoodEntryId)(crypto.randomUUID()),
					petId: fixture.pet.id,
					recordedBy: fixture.user.user.id,
					amountMg: Schema.decodeUnknownSync(FoodAmountMg)(1_000),
					fedAt: 2_500,
					source: {
						botId,
						updateId: Math.floor(Math.random() * 1_000_000_000) + 1_000_000_001,
						messageChatId: null,
						messageId: null,
					},
					now: 2_500,
				});
				yield* TestClock.setTime(3_000);
				yield* runFresh;
				const [event] = yield* (yield* PgClient.PgClient)<{
					status: string;
				}>`SELECT status FROM carneloot.notification_events WHERE id=${fixture.event.id}::uuid`;
				expect(event?.status).toBe('cancelled');
			});
			await Effect.runPromise(Effect.provide(program, layer));
			expect(control.calls).toBe(0);
		});
	});

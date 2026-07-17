import * as PgClient from '@effect/sql-pg/PgClient';
import * as TfxPostgres from '@tfx/postgres/TfxPostgres';
import { Deferred, Effect, Fiber, Layer, Schema } from 'effect';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as TestClock from 'effect/testing/TestClock';
import { JobRuntime } from 'tfx/JobRuntime';
import * as JobRuntimeLive from 'tfx/JobRuntime';
import { Telegram } from 'tfx/Telegram';
import { NetworkError, RateLimitError, TelegramError } from 'tfx/TelegramError';
import { describe, expect, it } from 'vitest';

import * as ConfigureReminderDelay from '../../src/application/ConfigureReminderDelay.js';
import {
	BotId,
	PetId,
	TelegramChatId,
	TelegramUserId,
} from '../../src/domain/Ids.js';
import { EventId } from '../../src/domain/notifications/NotificationEvent.js';
import { FoodAmountMg } from '../../src/domain/pet-food/FoodAmount.js';
import {
	IanaTimeZone,
	LocalTime,
} from '../../src/domain/pet-food/FoodDateTime.js';
import { FoodEntryId } from '../../src/domain/pet-food/PetFood.js';
import { PetName } from '../../src/domain/Pet.js';
import * as FeedingReminderJob from '../../src/jobs/FeedingReminderJob.js';
import * as FeedingReminderJobLive from '../../src/jobs/FeedingReminderJobLive.js';
import { NotificationRepository } from '../../src/ports/NotificationRepository.js';
import { PetFoodRepository } from '../../src/ports/PetFoodRepository.js';
import { PetRepository } from '../../src/ports/PetRepository.js';
import { ReminderScheduler } from '../../src/ports/ReminderScheduler.js';
import { UserRepository } from '../../src/ports/UserRepository.js';
import * as ReminderSchedulerLive from '../../src/postgres/ReminderSchedulerLive.js';
import * as RepositoriesLive from '../../src/postgres/RepositoriesLive.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
type Mode =
	| 'success'
	| 'network'
	| 'rate'
	| 'partial-rate'
	| 'block'
	| 'controlled';
const control: {
	mode: Mode;
	calls: number;
	started: Deferred.Deferred<void> | undefined;
	release: Deferred.Deferred<void> | undefined;
} = { mode: 'success', calls: 0, started: undefined, release: undefined };
const botId = Schema.decodeUnknownSync(BotId)('carneloot');
const PersistedRetryOutcome = Schema.Struct({
	outcome_json: Schema.Struct({
		error: Schema.Struct({
			_tag: Schema.Literal('FeedingReminderRetryError'),
			message: Schema.String,
			retryAfter: Schema.Number,
		}),
	}),
});
const telegram = Layer.succeed(Telegram, {
	sendMessage: () =>
		Effect.suspend(() => {
			control.calls++;
			if (control.mode === 'block')
				return Effect.andThen(
					Deferred.succeed(control.started!, undefined),
					Effect.never,
				);
			if (control.mode === 'controlled')
				return Effect.andThen(
					Deferred.succeed(control.started!, undefined),
					Effect.andThen(
						Deferred.await(control.release!),
						Effect.succeed({ message_id: 77 }),
					),
				);
			if (control.mode === 'network')
				return Effect.fail(
					new TelegramError({
						module: 'Telegram',
						method: 'sendMessage',
						reason: new NetworkError({ message: 'network' }),
					}),
				);
			if (
				control.mode === 'rate' ||
				(control.mode === 'partial-rate' && control.calls === 2)
			)
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
	Layer.merge(
		RepositoriesLive.layer,
		TfxPostgres.layer({ schema: 'tfx_feeding_e2e', tablePrefix: 'case_' }),
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
	const users = yield* UserRepository;
	const user = yield* users.registerTelegramProfile({
		botId,
		telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(telegramId),
		username: null,
		firstName: 'Reminder',
		lastName: null,
		privateChatId: Schema.decodeUnknownSync(TelegramChatId)(telegramId),
	});
	const pets = yield* PetRepository;
	const pet = yield* pets.addOwned(
		user.user.id,
		Schema.decodeUnknownSync(PetName)(`Reminder ${suffix}`),
	);
	const food = yield* PetFoodRepository;
	yield* food.setDayStart(
		pet.id,
		Schema.decodeUnknownSync(LocalTime)('00:00'),
		Schema.decodeUnknownSync(IanaTimeZone)('UTC'),
		DateTime.makeUnsafe(1_000),
	);
	yield* food.setReminderDelay(
		pet.id,
		Duration.seconds(1),
		DateTime.makeUnsafe(1_000),
	);
	const entry = yield* food.insert({
		id: Schema.decodeUnknownSync(FoodEntryId)(crypto.randomUUID()),
		petId: pet.id,
		recordedBy: user.user.id,
		amountMg: Schema.decodeUnknownSync(FoodAmountMg)(50_000),
		fedAt: DateTime.makeUnsafe(2_000),
		source: {
			botId,
			updateId: telegramId,
			messageChatId: null,
			messageId: null,
		},
		now: DateTime.makeUnsafe(2_000),
	});
	const scheduler = yield* ReminderScheduler;
	yield* scheduler.replaceForLatest({
		botId,
		ownerUserId: user.user.id,
		petId: pet.id,
		foodEntryId: entry.id,
		runAt: DateTime.makeUnsafe(3_000),
	});
	const sql = yield* PgClient.PgClient;
	const [event] = yield* sql<{
		id: string;
		job_id: string;
	}>`SELECT id,job_id FROM carneloot.notification_events WHERE pet_id=${pet.id}::uuid AND status='scheduled'`;
	return { user, pet, entry, event: event! };
});
const addCaregiver = (petId: PetId) =>
	Effect.gen(function* () {
		const telegramId = Math.floor(Math.random() * 1_000_000_000) + 1;
		const users = yield* UserRepository;
		const caregiver = yield* users.registerTelegramProfile({
			botId,
			telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(telegramId),
			username: null,
			firstName: 'Caregiver',
			lastName: null,
			privateChatId: Schema.decodeUnknownSync(TelegramChatId)(telegramId),
		});
		const sql = yield* PgClient.PgClient;
		yield* sql`INSERT INTO carneloot.pet_caregivers (pet_id,caregiver_user_id,status,created_at,updated_at) VALUES (${petId}::uuid,${caregiver.user.id}::uuid,'accepted',now(),now())`;
		return caregiver;
	});

const runOne = Effect.flatMap(JobRuntime, (jobs) =>
	jobs.runOne({ leaseDuration: Duration.millis(100) }),
);
const runFresh = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const sharedPg = Layer.succeed(PgClient.PgClient, sql);
	const freshStores = Layer.provideMerge(
		Layer.merge(
			RepositoriesLive.layer,
			TfxPostgres.layer({
				schema: 'tfx_feeding_e2e',
				tablePrefix: 'case_',
			}),
		),
		sharedPg,
	);
	const freshRuntime = Layer.provideMerge(
		JobRuntimeLive.layer(FeedingReminderJobLive.implementation),
		Layer.merge(freshStores, telegram),
	);
	return yield* Effect.provide(runOne, Layer.fresh(freshRuntime));
});

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

		it('freezes and sends owner plus accepted caregivers independently', async () => {
			control.mode = 'success';
			control.calls = 0;
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(2_000);
				const fixture = yield* scheduleFixture;
				yield* addCaregiver(fixture.pet.id);
				yield* addCaregiver(fixture.pet.id);
				yield* TestClock.setTime(3_000);
				expect(yield* runFresh).toMatchObject({ status: 'completed' });
				const sql = yield* PgClient.PgClient;
				const deliveries = yield* sql<{
					recipient_role: string;
					status: string;
				}>`SELECT recipient_role,status FROM carneloot.notification_deliveries WHERE event_id=${fixture.event.id}::uuid ORDER BY recipient_role DESC,recipient_user_id`;
				expect(deliveries).toEqual([
					{ recipient_role: 'owner', status: 'sent' },
					{ recipient_role: 'caregiver', status: 'sent' },
					{ recipient_role: 'caregiver', status: 'sent' },
				]);
			});
			await Effect.runPromise(Effect.provide(program, layer));
			expect(control.calls).toBe(3);
		});

		it('retries only the failed caregiver after an owner send succeeds', async () => {
			control.mode = 'partial-rate';
			control.calls = 0;
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(2_000);
				const fixture = yield* scheduleFixture;
				yield* addCaregiver(fixture.pet.id);
				yield* TestClock.setTime(3_000);
				expect(yield* runFresh).toMatchObject({
					status: 'scheduled',
					runAt: DateTime.makeUnsafe(5_000),
				});
				const sql = yield* PgClient.PgClient;
				const first = yield* sql<{
					recipient_role: string;
					status: string;
					attempt_count: number;
				}>`SELECT recipient_role,status,attempt_count FROM carneloot.notification_deliveries WHERE event_id=${fixture.event.id}::uuid ORDER BY recipient_role DESC`;
				expect(first).toEqual([
					{ recipient_role: 'owner', status: 'sent', attempt_count: 1 },
					{ recipient_role: 'caregiver', status: 'failed', attempt_count: 1 },
				]);
				control.mode = 'success';
				yield* TestClock.setTime(5_000);
				expect(yield* runFresh).toMatchObject({ status: 'completed' });
				const final = yield* sql<{
					recipient_role: string;
					status: string;
					attempt_count: number;
				}>`SELECT recipient_role,status,attempt_count FROM carneloot.notification_deliveries WHERE event_id=${fixture.event.id}::uuid ORDER BY recipient_role DESC`;
				expect(final).toEqual([
					{ recipient_role: 'owner', status: 'sent', attempt_count: 1 },
					{ recipient_role: 'caregiver', status: 'sent', attempt_count: 2 },
				]);
			});
			await Effect.runPromise(Effect.provide(program, layer));
			expect(control.calls).toBe(3);
		});

		it('does not add a caregiver accepted after recipient freeze', async () => {
			control.mode = 'controlled';
			control.calls = 0;
			control.started = Deferred.makeUnsafe<void>();
			control.release = Deferred.makeUnsafe<void>();
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(2_000);
				const fixture = yield* scheduleFixture;
				yield* TestClock.setTime(3_000);
				const send = yield* Effect.forkChild(runFresh);
				yield* Deferred.await(control.started!);
				yield* addCaregiver(fixture.pet.id);
				yield* Deferred.succeed(control.release!, undefined);
				expect(yield* Fiber.join(send)).toMatchObject({ status: 'completed' });
				const sql = yield* PgClient.PgClient;
				const [counts] = yield* sql<{
					deliveries: number;
				}>`SELECT count(*)::int deliveries FROM carneloot.notification_deliveries WHERE event_id=${fixture.event.id}::uuid`;
				expect(counts?.deliveries).toBe(1);
			});
			await Effect.runPromise(Effect.provide(program, layer));
			expect(control.calls).toBe(1);
		});

		it('permanently fails a caregiver revoked after recipient freeze', async () => {
			control.mode = 'controlled';
			control.calls = 0;
			control.started = Deferred.makeUnsafe<void>();
			control.release = Deferred.makeUnsafe<void>();
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(2_000);
				const fixture = yield* scheduleFixture;
				const caregiver = yield* addCaregiver(fixture.pet.id);
				yield* TestClock.setTime(3_000);
				const send = yield* Effect.forkChild(runFresh);
				yield* Deferred.await(control.started!);
				const sql = yield* PgClient.PgClient;
				yield* sql`UPDATE carneloot.pet_caregivers SET status='rejected',updated_at=now() WHERE pet_id=${fixture.pet.id}::uuid AND caregiver_user_id=${caregiver.user.id}::uuid`;
				yield* Deferred.succeed(control.release!, undefined);
				expect(yield* Fiber.join(send)).toMatchObject({ status: 'completed' });
				const [delivery] = yield* sql<{
					status: string;
					safe_error_json: { readonly code: string };
				}>`SELECT status,safe_error_json FROM carneloot.notification_deliveries WHERE event_id=${fixture.event.id}::uuid AND recipient_role='caregiver'`;
				expect(delivery).toMatchObject({
					status: 'failed',
					safe_error_json: { code: 'caregiver-access-revoked' },
				});
			});
			await Effect.runPromise(Effect.provide(program, layer));
			expect(control.calls).toBe(1);
		});

		it('does not resend a completed reminder after its delay changes', async () => {
			control.mode = 'success';
			control.calls = 0;
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(2_000);
				const fixture = yield* scheduleFixture;
				yield* TestClock.setTime(3_000);
				expect(yield* runFresh).toMatchObject({ status: 'completed' });
				yield* ConfigureReminderDelay.set(
					{
						actorId: fixture.user.user.id,
						botId,
						telegramUserId: fixture.user.profile.telegramUserId,
						petId: fixture.pet.id,
					},
					Duration.seconds(2),
				);
				yield* TestClock.setTime(4_000);
				expect(yield* runFresh).toBeUndefined();
				const sql = yield* PgClient.PgClient;
				const [counts] = yield* sql<{
					events: number;
					sent: number;
				}>`SELECT count(DISTINCT e.id)::int events,count(d.id) FILTER (WHERE d.status='sent')::int sent FROM carneloot.notification_events e LEFT JOIN carneloot.notification_deliveries d ON d.event_id=e.id WHERE e.bot_id=${botId} AND e.pet_id=${fixture.pet.id}::uuid AND e.food_entry_id=${fixture.entry.id}::uuid`;
				expect(counts).toEqual({ events: 1, sent: 1 });
			});
			await Effect.runPromise(Effect.provide(program, layer));
			expect(control.calls).toBe(1);
		});

		it('does not replace a reminder while its send is in flight', async () => {
			control.mode = 'controlled';
			control.calls = 0;
			control.started = Deferred.makeUnsafe<void>();
			control.release = Deferred.makeUnsafe<void>();
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(2_000);
				const fixture = yield* scheduleFixture;
				yield* TestClock.setTime(3_000);
				const send = yield* Effect.forkChild(runFresh);
				yield* Deferred.await(control.started!);
				yield* ConfigureReminderDelay.set(
					{
						actorId: fixture.user.user.id,
						botId,
						telegramUserId: fixture.user.profile.telegramUserId,
						petId: fixture.pet.id,
					},
					Duration.seconds(2),
				);
				yield* Deferred.succeed(control.release!, undefined);
				expect(yield* Fiber.join(send)).toMatchObject({ status: 'completed' });
				yield* TestClock.setTime(4_000);
				expect(yield* runFresh).toBeUndefined();
				const sql = yield* PgClient.PgClient;
				const events = yield* sql<{
					status: string;
				}>`SELECT status FROM carneloot.notification_events WHERE bot_id=${botId} AND pet_id=${fixture.pet.id}::uuid AND food_entry_id=${fixture.entry.id}::uuid`;
				expect(events).toEqual([{ status: 'completed' }]);
			});
			await Effect.runPromise(Effect.provide(program, layer));
			expect(control.calls).toBe(1);
		});

		it('audits an unreachable caregiver while still sending the owner', async () => {
			control.mode = 'success';
			control.calls = 0;
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(2_000);
				const fixture = yield* scheduleFixture;
				const caregiver = yield* addCaregiver(fixture.pet.id);
				const sql = yield* PgClient.PgClient;
				yield* sql`DELETE FROM carneloot.telegram_identities WHERE user_id=${caregiver.user.id}::uuid`;
				yield* TestClock.setTime(3_000);
				yield* runFresh;
				const deliveries = yield* sql<{
					recipient_role: string;
					status: string;
					recipient_chat_id: string | null;
				}>`SELECT recipient_role,status,recipient_chat_id FROM carneloot.notification_deliveries WHERE event_id=${fixture.event.id}::uuid ORDER BY recipient_role DESC`;
				expect(deliveries).toEqual([
					{
						recipient_role: 'owner',
						status: 'sent',
						recipient_chat_id: String(fixture.user.profile.privateChatId),
					},
					{
						recipient_role: 'caregiver',
						status: 'failed',
						recipient_chat_id: null,
					},
				]);
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
			const legacyError = Schema.decodeUnknownSync(
				FeedingReminderJob.FeedingReminderError,
			)({
				_tag: 'FeedingReminderRetryError',
				message: 'legacy retry',
				retryAfter: 2_000,
			});
			if (
				legacyError._tag !== 'FeedingReminderRetryError' ||
				legacyError.retryAfter === undefined
			)
				throw new Error('expected retry error with delay');
			expect(Duration.equals(legacyError.retryAfter, Duration.seconds(2))).toBe(
				true,
			);

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
						expect(first).toMatchObject({
							status: 'scheduled',
							runAt: DateTime.makeUnsafe(5_000),
						});
						expect(delivery?.retry_at?.getTime()).toBe(5_000);
						const [rawOutcome] = yield* sql<
							Record<string, unknown>
						>`SELECT outcome_json FROM tfx_feeding_e2e.case_jobs WHERE id=${fixture.event.job_id}::uuid`;
						const persisted = Schema.decodeUnknownSync(PersistedRetryOutcome)(
							rawOutcome,
						);
						expect(persisted.outcome_json.error.retryAfter).toBe(2_000);
						const decodedError = Schema.decodeUnknownSync(
							FeedingReminderJob.FeedingReminderError,
						)(persisted.outcome_json.error);
						if (
							decodedError._tag !== 'FeedingReminderRetryError' ||
							decodedError.retryAfter === undefined
						)
							throw new Error('expected persisted retry error with delay');
						expect(
							Duration.equals(decodedError.retryAfter, Duration.seconds(2)),
						).toBe(true);
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
				yield* TestClock.setTime(33_001);
				const notifications = yield* NotificationRepository;
				yield* notifications.recoverExpired(
					Schema.decodeUnknownSync(EventId)(fixture.event.id),
					DateTime.makeUnsafe(33_001),
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
					fedAt: DateTime.makeUnsafe(2_500),
					source: {
						botId,
						updateId: Math.floor(Math.random() * 1_000_000_000) + 1_000_000_001,
						messageChatId: null,
						messageId: null,
					},
					now: DateTime.makeUnsafe(2_500),
				});
				yield* TestClock.setTime(3_000);
				yield* runFresh;
				const sql = yield* PgClient.PgClient;
				const [event] = yield* sql<{
					status: string;
				}>`SELECT status FROM carneloot.notification_events WHERE id=${fixture.event.id}::uuid`;
				expect(event?.status).toBe('cancelled');
			});
			await Effect.runPromise(Effect.provide(program, layer));
			expect(control.calls).toBe(0);
		});
	});

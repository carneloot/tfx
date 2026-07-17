import * as PgClient from '@effect/sql-pg/PgClient';
import * as TfxPostgres from '@tfx/postgres/TfxPostgres';
import { Effect, Layer, Schema } from 'effect';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as TestClock from 'effect/testing/TestClock';
import * as Job from 'tfx/Job';
import { JobRuntime, type JobRuntimeService } from 'tfx/JobRuntime';
import * as JobRuntimeLive from 'tfx/JobRuntime';
import { JobStoreError } from 'tfx/JobStore';
import { describe, expect, it } from 'vitest';

import * as AddFood from '../../src/application/AddFood.js';
import { BotId, TelegramChatId, TelegramUserId } from '../../src/domain/Ids.js';
import { EventId } from '../../src/domain/notifications/NotificationEvent.js';
import { FoodAmountMg } from '../../src/domain/pet-food/FoodAmount.js';
import { FoodAmount } from '../../src/domain/pet-food/FoodAmount.js';
import {
	IanaTimeZone,
	LocalTime,
} from '../../src/domain/pet-food/FoodDateTime.js';
import { FoodEntryId } from '../../src/domain/pet-food/PetFood.js';
import { PetName } from '../../src/domain/Pet.js';
import * as FeedingReminderJob from '../../src/jobs/FeedingReminderJob.js';
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
const executeAddFood = (
	access: Parameters<typeof AddFood.execute>[0],
	amount: string,
	when: string,
	source: AddFood.SourceInput,
) =>
	AddFood.execute(
		access,
		{
			amountMg: Schema.decodeUnknownSync(FoodAmount)(amount),
			when,
			messageDate: DateTime.makeUnsafe('2024-01-02T12:00:00Z'),
		},
		source,
	);
const implementation = Job.implement(
	FeedingReminderJob.declaration,
	() => Effect.void,
);
const pg = PostgresTestLayer.layer;
const stores = Layer.provideMerge(
	Layer.merge(
		RepositoriesLive.layer,
		TfxPostgres.layer({
			schema: 'tfx_feeding_test',
			tablePrefix: 'case_',
		}),
	),
	pg,
);
const runtime = Layer.provideMerge(
	JobRuntimeLive.layer(implementation),
	stores,
);
const scheduler = Layer.provideMerge(
	ReminderSchedulerLive.layer,
	Layer.merge(stores, runtime),
);
const layer = Layer.mergeAll(stores, runtime, scheduler, TestClock.layer());
const botId = Schema.decodeUnknownSync(BotId)('carneloot');

const fixture = Effect.gen(function* () {
	const suffix = crypto.randomUUID();
	const telegramId = Math.floor(Math.random() * 1_000_000_000) + 1;
	const user = yield* (yield* UserRepository).registerTelegramProfile({
		botId,
		telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(telegramId),
		username: null,
		firstName: 'Scheduler',
		lastName: null,
		privateChatId: Schema.decodeUnknownSync(TelegramChatId)(telegramId),
	});
	const pet = yield* (yield* PetRepository).addOwned(
		user.user.id,
		Schema.decodeUnknownSync(PetName)(`Pet ${suffix}`),
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
	return { user, pet, entry };
});

if (!enabled)
	describe.skip('feeding reminder scheduling PostgreSQL', () => {
		it('requires TEST_DATABASE_URL or RUN_TESTCONTAINERS=true', () => {});
	});
else
	describe('feeding reminder scheduling PostgreSQL', () => {
		it('atomically schedules, idempotently replaces, cancels, and survives runtime rebuild', async () => {
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(2_000);
				const { user, pet, entry } = yield* fixture;
				const scheduler = yield* ReminderScheduler;
				const request = {
					botId,
					ownerUserId: user.user.id,
					petId: pet.id,
					foodEntryId: entry.id,
					runAt: DateTime.makeUnsafe(3_000),
				} as const;
				yield* Effect.all(
					[
						scheduler.replaceForLatest(request),
						scheduler.replaceForLatest(request),
					],
					{ concurrency: 'unbounded' },
				);
				const sql = yield* PgClient.PgClient;
				const active = yield* sql<{
					id: string;
					job_id: string;
					food_entry_id: string;
					scheduled_for: Date;
				}>`SELECT id,job_id,food_entry_id,scheduled_for FROM carneloot.notification_events WHERE bot_id=${botId} AND pet_id=${pet.id}::uuid AND status='scheduled'`;
				const jobs = yield* sql<{
					id: string;
					payload_version: number;
					payload_json: unknown;
					max_attempts: number;
				}>`SELECT id,payload_version,payload_json,max_attempts FROM tfx_feeding_test.case_jobs WHERE conflict_key=${`feeding-reminder:${botId}:${pet.id}`} AND status='scheduled'`;
				expect(active).toHaveLength(1);
				expect(jobs).toHaveLength(1);
				expect(active[0]).toMatchObject({
					job_id: jobs[0]?.id,
					food_entry_id: entry.id,
				});
				expect(jobs[0]).toMatchObject({
					payload_version: 1,
					max_attempts: 8,
					payload_json: {
						eventId: active[0]?.id,
						botId,
						petId: pet.id,
						foodEntryId: entry.id,
					},
				});

				yield* scheduler.cancelForPet({ botId, petId: pet.id });
				const cancelled = yield* sql<{
					status: string;
				}>`SELECT status FROM carneloot.notification_events WHERE id=${active[0]!.id}::uuid`;
				expect(cancelled[0]?.status).toBe('cancelled');
				yield* scheduler.replaceForLatest(request);
				const revived = yield* sql<{
					id: string;
					status: string;
				}>`SELECT id,status FROM carneloot.notification_events WHERE bot_id=${botId} AND pet_id=${pet.id}::uuid AND status='scheduled'`;
				expect(revived).toEqual([{ id: active[0]!.id, status: 'scheduled' }]);

				yield* TestClock.setTime(3_000);
				const restarted = yield* Effect.provide(
					Effect.flatMap(JobRuntime, (runtime) => runtime.runOne()),
					Layer.fresh(JobRuntimeLive.layer(implementation)),
				);
				expect(restarted).toMatchObject({
					status: 'completed',
					attempts: 1,
				});
			});
			await Effect.runPromise(Effect.provide(program, layer));
		});

		it('replaces an unsent reminder when its delay changes', async () => {
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(2_000);
				const { user, pet, entry } = yield* fixture;
				const reminderScheduler = yield* ReminderScheduler;
				yield* reminderScheduler.replaceForLatest({
					botId,
					ownerUserId: user.user.id,
					petId: pet.id,
					foodEntryId: entry.id,
					runAt: DateTime.makeUnsafe(3_000),
				});
				yield* (yield* PetFoodRepository).setReminderDelay(
					pet.id,
					Duration.seconds(2),
					DateTime.makeUnsafe(2_000),
				);
				yield* reminderScheduler.replaceForLatest({
					botId,
					ownerUserId: user.user.id,
					petId: pet.id,
					foodEntryId: entry.id,
					runAt: DateTime.makeUnsafe(4_000),
				});
				const sql = yield* PgClient.PgClient;
				const events = yield* sql<{
					status: string;
					scheduled_for: Date;
				}>`SELECT status,scheduled_for FROM carneloot.notification_events WHERE bot_id=${botId} AND pet_id=${pet.id}::uuid ORDER BY scheduled_for`;
				expect(events).toEqual([
					{ status: 'cancelled', scheduled_for: new Date(3_000) },
					{ status: 'scheduled', scheduled_for: new Date(4_000) },
				]);
				const jobs = yield* sql<{
					status: string;
					run_at: Date;
				}>`SELECT status,run_at FROM tfx_feeding_test.case_jobs WHERE conflict_key=${`feeding-reminder:${botId}:${pet.id}`} ORDER BY run_at`;
				expect(jobs).toEqual([
					{ status: 'cancelled', run_at: new Date(3_000) },
					{ status: 'scheduled', run_at: new Date(4_000) },
				]);
			});
			await Effect.runPromise(Effect.provide(program, layer));
		});

		it('rolls back cancellation when event creation conflicts', async () => {
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(2_000);
				const { user, pet, entry } = yield* fixture;
				const dedupeKey = `feeding-reminder:${botId}:${pet.id}:${entry.id}:3000`;
				const existing = yield* (yield* NotificationRepository).createEvent({
					id: Schema.decodeUnknownSync(EventId)(crypto.randomUUID()),
					botId,
					kind: 'unrelated-kind',
					ownerUserId: user.user.id,
					petId: pet.id,
					foodEntryId: entry.id,
					scheduledFor: DateTime.makeUnsafe(3_000),
					dedupeKey,
					now: DateTime.makeUnsafe(2_000),
				});
				const result = yield* Effect.result(
					Effect.flatMap(ReminderScheduler, (scheduler) =>
						scheduler.replaceForLatest({
							botId,
							ownerUserId: user.user.id,
							petId: pet.id,
							foodEntryId: entry.id,
							runAt: DateTime.makeUnsafe(3_000),
						}),
					),
				);
				expect(result._tag).toBe('Failure');
				expect(
					yield* (yield* NotificationRepository).getDispatchContext(
						existing.id,
					),
				).toMatchObject({ status: 'scheduled' });
				const sql = yield* PgClient.PgClient;
				expect(
					yield* sql`SELECT id FROM tfx_feeding_test.case_jobs WHERE conflict_key=${`feeding-reminder:${botId}:${pet.id}`}`,
				).toHaveLength(0);
			});
			await Effect.runPromise(Effect.provide(program, layer));
		});

		it('rolls back an event when JobStore scheduling fails', async () => {
			const failingJobs: JobRuntimeService = {
				problems: Effect.succeed([]),
				schedule: () =>
					Effect.fail(
						new JobStoreError('PersistenceFailure', 'forced store failure'),
					),
				runOne: () => Effect.succeed(undefined),
				cancel: () => Effect.succeed(false),
				releaseFailed: () => Effect.die('unused'),
			};
			const failingScheduler = Layer.provide(
				ReminderSchedulerLive.layer,
				Layer.succeed(JobRuntime, failingJobs),
			);
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(2_000);
				const { user, pet, entry } = yield* fixture;
				const result = yield* Effect.provide(
					Effect.flatMap(ReminderScheduler, (scheduler) =>
						Effect.result(
							scheduler.replaceForLatest({
								botId,
								ownerUserId: user.user.id,
								petId: pet.id,
								foodEntryId: entry.id,
								runAt: DateTime.makeUnsafe(3_000),
							}),
						),
					),
					Layer.fresh(failingScheduler),
				);
				expect(result._tag).toBe('Failure');
				const sql = yield* PgClient.PgClient;
				expect(
					yield* sql`SELECT id FROM carneloot.notification_events WHERE pet_id=${pet.id}::uuid`,
				).toHaveLength(0);
			});
			await Effect.runPromise(Effect.provide(program, layer));
		});

		it('rolls back event and job with the caller transaction', async () => {
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(2_000);
				const { user, pet, entry } = yield* fixture;
				const sql = yield* PgClient.PgClient;
				yield* TestClock.setTime(4_000);
				const result = yield* Effect.result(
					sql.withTransaction(
						Effect.andThen(
							executeAddFood(
								{
									actorId: user.user.id,
									botId,
									telegramUserId: user.profile.telegramUserId,
									petId: pet.id,
								},
								'10g',
								'',
								{ botId, updateId: 99_000 },
							),
							Effect.fail('forced rollback'),
						),
					),
				);
				expect(result._tag).toBe('Failure');
				const events =
					yield* sql`SELECT id FROM carneloot.notification_events WHERE pet_id=${pet.id}::uuid`;
				const jobs =
					yield* sql`SELECT id FROM tfx_feeding_test.case_jobs WHERE conflict_key=${`feeding-reminder:${botId}:${pet.id}`}`;
				const entries =
					yield* sql`SELECT id FROM carneloot.pet_food_entries WHERE pet_id=${pet.id}::uuid`;
				expect(events).toHaveLength(0);
				expect(jobs).toHaveLength(0);
				expect(entries).toHaveLength(1);
				expect(entries[0]).toMatchObject({ id: entry.id });
			});
			await Effect.runPromise(Effect.provide(program, layer));
		});
	});

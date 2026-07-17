import * as PgClient from '@effect/sql-pg/PgClient';
import * as TfxPostgres from '@tfx/postgres/TfxPostgres';
import { DateTime, Effect, Layer, Schema } from 'effect';
import * as Job from 'tfx/Job';
import * as JobRuntimeLive from 'tfx/JobRuntime';
import { describe, expect, it } from 'vitest';

import * as AddFood from '../../src/application/AddFood.js';
import { BotId, PetId, TelegramUserId, UserId } from '../../src/domain/Ids.js';
import { FoodAmount } from '../../src/domain/pet-food/FoodAmount.js';
import * as FoodAddedNotificationJob from '../../src/jobs/FoodAddedNotificationJob.js';
import { ReminderScheduler } from '../../src/ports/ReminderScheduler.js';
import * as FoodNotificationSchedulerLive from '../../src/postgres/FoodNotificationSchedulerLive.js';
import * as RepositoriesLive from '../../src/postgres/RepositoriesLive.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const implementation = Job.implement(
	FoodAddedNotificationJob.declaration,
	() => Effect.void,
);
const pg = PostgresTestLayer.layer;
const stores = Layer.provideMerge(
	Layer.merge(
		RepositoriesLive.layer,
		TfxPostgres.layer({ schema: 'tfx_food_added_test', tablePrefix: 'case_' }),
	),
	pg,
);
const runtime = Layer.provideMerge(
	JobRuntimeLive.layer(implementation),
	stores,
);
const foodScheduler = Layer.provideMerge(
	FoodNotificationSchedulerLive.layer,
	Layer.merge(stores, runtime),
);
const reminder = Layer.succeed(ReminderScheduler, {
	replaceForLatest: () => Effect.void,
	cancelForPet: () => Effect.void,
});
const liveLayer = Layer.mergeAll(stores, runtime, foodScheduler, reminder);

const setup = (options: { readonly ownerIdentity?: boolean } = {}) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const suffix = crypto.randomUUID();
		const botId = Schema.decodeUnknownSync(BotId)(`food-added-${suffix}`);
		const ownerId = Schema.decodeUnknownSync(UserId)(crypto.randomUUID());
		const caregiverId = Schema.decodeUnknownSync(UserId)(crypto.randomUUID());
		const petId = Schema.decodeUnknownSync(PetId)(crypto.randomUUID());
		const nameKey = `rex-${suffix}`;
		yield* sql`INSERT INTO carneloot.users (id,created_at,updated_at) VALUES (${ownerId}::uuid,now(),now()),(${caregiverId}::uuid,now(),now())`;
		yield* sql`INSERT INTO carneloot.pets (id,owner_id,name,name_key,created_at,updated_at) VALUES (${petId}::uuid,${ownerId}::uuid,'Rex',${nameKey},now(),now())`;
		yield* sql`INSERT INTO carneloot.pet_caregivers (pet_id,caregiver_user_id,status,created_at,updated_at) VALUES (${petId}::uuid,${caregiverId}::uuid,'accepted',now(),now())`;
		yield* sql`INSERT INTO carneloot.telegram_identities (bot_id,telegram_user_id,user_id,username,first_name,last_name,private_chat_id,created_at,updated_at) VALUES (${botId},202,${caregiverId}::uuid,NULL,'Caregiver',NULL,202,now(),now())`;
		if (options.ownerIdentity !== false)
			yield* sql`INSERT INTO carneloot.telegram_identities (bot_id,telegram_user_id,user_id,username,first_name,last_name,private_chat_id,created_at,updated_at) VALUES (${botId},101,${ownerId}::uuid,NULL,'Owner',NULL,101,now(),now())`;
		yield* sql`INSERT INTO carneloot.pet_food_settings (pet_id,day_start,timezone,reminder_delay_ms,created_at,updated_at) VALUES (${petId}::uuid,'00:00','UTC',NULL,now(),now())`;
		return {
			sql,
			botId,
			ownerId,
			caregiverId,
			petId,
			caregiverAccess: {
				actorId: caregiverId,
				petId,
				botId,
				telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(202),
			},
			ownerAccess: {
				actorId: ownerId,
				petId,
				botId,
				telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(101),
			},
		};
	});
const add = (
	access: Parameters<typeof AddFood.execute>[0],
	updateId: number,
	when = '',
) =>
	AddFood.execute(
		access,
		{
			amountMg: Schema.decodeUnknownSync(FoodAmount)('50g'),
			when,
			messageDate: DateTime.makeUnsafe('2026-07-16T11:30:00Z'),
		},
		{ botId: access.botId, updateId },
	);

if (!enabled)
	describe.skip('food-added scheduling PostgreSQL', () => {
		it('requires TEST_DATABASE_URL or RUN_TESTCONTAINERS=true', () => {});
	});
else
	describe('food-added scheduling PostgreSQL', () => {
		it('atomically freezes actor-excluded delivery and schedules once on replay', async () => {
			const program = Effect.gen(function* () {
				const fixture = yield* setup();
				const first = yield* add(fixture.caregiverAccess, 71, '08:30');
				const replay = yield* add(fixture.caregiverAccess, 71, '08:30');
				const events = yield* fixture.sql<{
					id: string;
					job_id: string | null;
					scheduled_for: Date;
					food_timestamp_explicit: boolean;
					recipients_materialized_at: Date | null;
				}>`SELECT id,job_id,scheduled_for,food_timestamp_explicit,recipients_materialized_at FROM carneloot.notification_events WHERE kind='food-added' AND food_entry_id=${first.entry.id}::uuid`;
				const deliveries = yield* fixture.sql<{
					recipient_user_id: string;
					status: string;
				}>`SELECT recipient_user_id,status FROM carneloot.notification_deliveries WHERE event_id=${events[0]?.id}::uuid`;
				const jobs = yield* fixture.sql<{
					declaration: string;
					conflict_key: string | null;
					run_at: Date;
				}>`SELECT declaration,conflict_key,run_at FROM tfx_food_added_test.case_jobs WHERE id=${events[0]?.job_id}::uuid`;
				return { first, replay, events, deliveries, jobs, fixture };
			});
			const result = await Effect.runPromise(
				Effect.provide(program, liveLayer),
			);
			expect(result.replay.replayed).toBe(true);
			expect(result.events).toHaveLength(1);
			expect(result.events[0]).toMatchObject({
				food_timestamp_explicit: true,
			});
			expect(result.events[0]?.job_id).not.toBeNull();
			expect(result.events[0]?.recipients_materialized_at).not.toBeNull();
			expect(result.jobs).toEqual([
				expect.objectContaining({
					declaration: 'food-added-notification',
					conflict_key: `food-added:${result.fixture.botId}:${result.fixture.petId}:71`,
				}),
			]);
			expect(result.jobs[0]?.run_at.getTime()).toBe(
				result.events[0]?.scheduled_for.getTime(),
			);
			expect(result.deliveries).toEqual([
				{ recipient_user_id: result.fixture.ownerId, status: 'pending' },
			]);
		});

		it('audits unreachable recipient and creates no event when actor is sole recipient', async () => {
			const program = Effect.gen(function* () {
				const unreachable = yield* setup({ ownerIdentity: false });
				const caregiverFood = yield* add(unreachable.caregiverAccess, 72);
				const failed = yield* unreachable.sql<{
					status: string;
					recipient_chat_id: number | null;
				}>`SELECT d.status,d.recipient_chat_id FROM carneloot.notification_deliveries d JOIN carneloot.notification_events e ON e.id=d.event_id WHERE e.food_entry_id=${caregiverFood.entry.id}::uuid`;
				const ownerOnly = yield* setup();
				yield* ownerOnly.sql`DELETE FROM carneloot.pet_caregivers WHERE pet_id=${ownerOnly.petId}::uuid`;
				const ownerFood = yield* add(ownerOnly.ownerAccess, 73);
				const ownerEvents =
					yield* ownerOnly.sql`SELECT id FROM carneloot.notification_events WHERE food_entry_id=${ownerFood.entry.id}::uuid`;
				return { failed, ownerEvents };
			});
			const result = await Effect.runPromise(
				Effect.provide(program, liveLayer),
			);
			expect(result.failed).toEqual([
				{ status: 'failed', recipient_chat_id: null },
			]);
			expect(result.ownerEvents).toHaveLength(0);
		});

		it('rolls back food, event, deliveries, and durable job when attach fails', async () => {
			const program = Effect.gen(function* () {
				const fixture = yield* setup();
				yield* fixture.sql`CREATE FUNCTION carneloot.fail_food_added_job_attach() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='food-added' AND NEW.job_id IS NOT NULL THEN RAISE EXCEPTION 'forced attach failure'; END IF; RETURN NEW; END $$`;
				yield* fixture.sql`CREATE TRIGGER fail_food_added_job_attach BEFORE UPDATE ON carneloot.notification_events FOR EACH ROW EXECUTE FUNCTION carneloot.fail_food_added_job_attach()`;
				const result = yield* Effect.result(add(fixture.caregiverAccess, 74));
				const food =
					yield* fixture.sql`SELECT id FROM carneloot.pet_food_entries WHERE pet_id=${fixture.petId}::uuid`;
				const events =
					yield* fixture.sql`SELECT id FROM carneloot.notification_events WHERE pet_id=${fixture.petId}::uuid AND kind='food-added'`;
				const deliveries =
					yield* fixture.sql`SELECT d.id FROM carneloot.notification_deliveries d JOIN carneloot.notification_events e ON e.id=d.event_id WHERE e.pet_id=${fixture.petId}::uuid`;
				const jobs =
					yield* fixture.sql`SELECT id FROM tfx_food_added_test.case_jobs WHERE conflict_key=${`food-added:${fixture.botId}:${fixture.petId}:74`}`;
				return { result, food, events, deliveries, jobs };
			});
			const result = await Effect.runPromise(
				Effect.provide(program, liveLayer),
			);
			expect(result.result).toMatchObject({
				_tag: 'Failure',
				failure: { _tag: 'FoodNotificationSchedulerError' },
			});
			expect(result.food).toHaveLength(0);
			expect(result.events).toHaveLength(0);
			expect(result.deliveries).toHaveLength(0);
			expect(result.jobs).toHaveLength(0);
		});
	});

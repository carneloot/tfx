import * as PgClient from '@effect/sql-pg/PgClient';
import * as TfxPostgres from '@tfx/postgres/TfxPostgres';
import { DateTime, Effect, Layer, Schema } from 'effect';
import { JobRuntime } from 'tfx/JobRuntime';
import * as JobRuntimeLive from 'tfx/JobRuntime';
import { Telegram } from 'tfx/Telegram';
import { describe, expect, it } from 'vitest';

import * as AddFood from '../../src/application/AddFood.js';
import * as DispatchNotificationDelivery from '../../src/application/DispatchNotificationDelivery.js';
import { CurrentUser } from '../../src/bot/CurrentUser.js';
import {
	BotId,
	PetId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../../src/domain/Ids.js';
import { EventId } from '../../src/domain/notifications/NotificationEvent.js';
import { FoodAmount } from '../../src/domain/pet-food/FoodAmount.js';
import type { RegisteredUser } from '../../src/domain/User.js';
import * as FoodAddedNotificationJobLive from '../../src/jobs/FoodAddedNotificationJobLive.js';
import { ReminderScheduler } from '../../src/ports/ReminderScheduler.js';
import * as FoodNotificationSchedulerLive from '../../src/postgres/FoodNotificationSchedulerLive.js';
import * as RepositoriesLive from '../../src/postgres/RepositoriesLive.js';
import * as DeterministicCrypto from '../internal/DeterministicCrypto.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const sent: Array<Record<string, unknown>> = [];
const telegram = Layer.succeed(Telegram, {
	sendMessage: (request: Record<string, unknown>) =>
		Effect.sync(() => {
			sent.push(request);
			return { message_id: sent.length };
		}),
} as never);
const pg = PostgresTestLayer.layer;
const stores = Layer.provideMerge(
	Layer.merge(
		RepositoriesLive.layer,
		TfxPostgres.layer({ schema: 'tfx_food_added_test', tablePrefix: 'case_' }),
	),
	Layer.merge(pg, DeterministicCrypto.layer()),
);
const runtime = Layer.provideMerge(
	JobRuntimeLive.layer(FoodAddedNotificationJobLive.implementation),
	Layer.merge(stores, telegram),
);
const foodScheduler = Layer.provideMerge(
	FoodNotificationSchedulerLive.layer,
	Layer.merge(stores, runtime),
);
const reminder = Layer.succeed(ReminderScheduler, {
	replaceForLatest: () => Effect.void,
	cancelForPet: () => Effect.void,
});
const liveLayer = Layer.mergeAll(
	stores,
	runtime,
	foodScheduler,
	reminder,
	telegram,
);

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
const currentUser = (access: Parameters<typeof AddFood.execute>[0]) => {
	const now = DateTime.makeUnsafe(0);
	return Layer.succeed(CurrentUser, {
		user: {
			id: access.actorId,
			createdAt: now,
			updatedAt: now,
		},
		profile: {
			botId: access.botId,
			telegramUserId: access.telegramUserId,
			username: null,
			firstName: 'Test User',
			lastName: null,
			privateChatId: Schema.decodeUnknownSync(TelegramChatId)(
				access.telegramUserId,
			),
		},
	} satisfies RegisteredUser);
};
const add = (
	access: Parameters<typeof AddFood.execute>[0],
	updateId: number,
	when = '',
) =>
	Effect.provide(
		AddFood.execute(
			access,
			{
				amountMg: Schema.decodeUnknownSync(FoodAmount)('50g'),
				when,
				messageDate: DateTime.makeUnsafe('2026-07-16T11:30:00Z'),
			},
			{ botId: access.botId, updateId },
		),
		currentUser(access),
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

		it('delivers silent localized message and persists exact Telegram identity', async () => {
			const program = Effect.gen(function* () {
				sent.length = 0;
				const fixture = yield* setup();
				const result = yield* add(fixture.caregiverAccess, 75, '08:30');
				const jobs = yield* JobRuntime;
				const records = [
					yield* jobs.runOne(),
					yield* jobs.runOne(),
					yield* jobs.runOne(),
				];
				const deliveries = yield* fixture.sql<{
					status: string;
					telegram_bot_id: string | null;
					telegram_message_id: string | null;
				}>`SELECT d.status,d.telegram_bot_id,d.telegram_message_id FROM carneloot.notification_deliveries d JOIN carneloot.notification_events e ON e.id=d.event_id WHERE e.food_entry_id=${result.entry.id}::uuid`;
				return { fixture, records, deliveries };
			});
			const result = await Effect.runPromise(
				Effect.provide(program, liveLayer),
			);
			expect(
				result.records.some((record) => record?.status === 'completed'),
			).toBe(true);
			const ownMessageIndex = sent.findIndex(
				(request) =>
					request.text ===
					'Caregiver colocou 50 g de ração para Rex em 16/07/2026 08:30.',
			);
			expect(ownMessageIndex).toBeGreaterThanOrEqual(0);
			expect(sent[ownMessageIndex]).toEqual({
				chat_id: 101,
				text: 'Caregiver colocou 50 g de ração para Rex em 16/07/2026 08:30.',
				disable_notification: true,
			});
			expect(result.deliveries).toEqual([
				{
					status: 'sent',
					telegram_bot_id: result.fixture.botId,
					telegram_message_id: String(ownMessageIndex + 1),
				},
			]);
		});

		it('omits timestamp when food time was not explicit', async () => {
			const program = Effect.gen(function* () {
				sent.length = 0;
				const fixture = yield* setup();
				yield* add(fixture.ownerAccess, 77);
				const jobs = yield* JobRuntime;
				yield* jobs.runOne();
			});
			await Effect.runPromise(Effect.provide(program, liveLayer));
			expect(sent).toEqual([
				{
					chat_id: 202,
					text: 'Owner colocou 50 g de ração para Rex.',
					disable_notification: true,
				},
			]);
		});

		it('does not send after caregiver access is revoked', async () => {
			const program = Effect.gen(function* () {
				sent.length = 0;
				const fixture = yield* setup();
				const added = yield* add(fixture.ownerAccess, 80);
				yield* fixture.sql`UPDATE carneloot.pet_caregivers SET status='rejected' WHERE pet_id=${fixture.petId}::uuid AND caregiver_user_id=${fixture.caregiverId}::uuid`;
				const jobs = yield* JobRuntime;
				yield* jobs.runOne();
				return yield* fixture.sql<{
					status: string;
					error_code: string | null;
				}>`SELECT d.status,d.safe_error_json->>'code' AS error_code FROM carneloot.notification_deliveries d JOIN carneloot.notification_events e ON e.id=d.event_id WHERE e.food_entry_id=${added.entry.id}::uuid`;
			});
			const deliveries = await Effect.runPromise(
				Effect.provide(program, liveLayer),
			);
			expect(sent).toEqual([]);
			expect(deliveries).toEqual([
				{ status: 'failed', error_code: 'caregiver-access-revoked' },
			]);
		});

		it('rejects mismatched payload without mutating frozen deliveries', async () => {
			const program = Effect.gen(function* () {
				sent.length = 0;
				const fixture = yield* setup();
				const added = yield* add(fixture.caregiverAccess, 78);
				const event = yield* fixture.sql<{
					id: string;
				}>`SELECT id FROM carneloot.notification_events WHERE food_entry_id=${added.entry.id}::uuid`;
				const persistedEventId = Schema.decodeUnknownSync(EventId)(
					event[0]?.id,
				);
				const result = yield* Effect.result(
					DispatchNotificationDelivery.executeFoodAdded({
						eventId: persistedEventId,
						botId: Schema.decodeUnknownSync(BotId)('wrong-bot'),
						petId: fixture.petId,
						foodEntryId: added.entry.id,
					}),
				);
				const deliveries = yield* fixture.sql<{
					status: string;
					attempt_count: number;
				}>`SELECT status,attempt_count FROM carneloot.notification_deliveries WHERE event_id=${persistedEventId}::uuid`;
				return { result, deliveries };
			});
			const result = await Effect.runPromise(
				Effect.provide(program, liveLayer),
			);
			expect(result.result).toMatchObject({
				_tag: 'Failure',
				failure: { _tag: 'FoodAddedNotificationPermanentError' },
			});
			expect(result.deliveries).toEqual([
				{ status: 'pending', attempt_count: 0 },
			]);
			expect(sent).toEqual([]);
		});

		it('retries missing-context cleanup while a sending lease remains active', async () => {
			const program = Effect.gen(function* () {
				const fixture = yield* setup();
				const added = yield* add(fixture.caregiverAccess, 79);
				const event = yield* fixture.sql<{
					id: string;
				}>`SELECT id FROM carneloot.notification_events WHERE food_entry_id=${added.entry.id}::uuid`;
				const persistedEventId = Schema.decodeUnknownSync(EventId)(
					event[0]?.id,
				);
				yield* fixture.sql`UPDATE carneloot.notification_deliveries SET status='sending',attempt_generation=1,attempt_count=1,sending_started_at=now(),sending_lease_expires_at=now()+interval '5 minutes' WHERE event_id=${persistedEventId}::uuid`;
				yield* fixture.sql`DELETE FROM carneloot.telegram_identities WHERE bot_id=${fixture.botId} AND user_id=${fixture.caregiverId}::uuid`;
				const result = yield* Effect.result(
					DispatchNotificationDelivery.executeFoodAdded({
						eventId: persistedEventId,
						botId: fixture.botId,
						petId: fixture.petId,
						foodEntryId: added.entry.id,
					}),
				);
				return result;
			});
			const result = await Effect.runPromise(
				Effect.provide(program, liveLayer),
			);
			expect(result).toMatchObject({
				_tag: 'Failure',
				failure: { _tag: 'FoodAddedNotificationRetryError' },
			});
		});

		it('permanently fails frozen delivery when actor context disappears', async () => {
			const program = Effect.gen(function* () {
				sent.length = 0;
				const fixture = yield* setup();
				const result = yield* add(fixture.caregiverAccess, 76);
				yield* fixture.sql`DELETE FROM carneloot.telegram_identities WHERE bot_id=${fixture.botId} AND user_id=${fixture.caregiverId}::uuid`;
				const jobs = yield* JobRuntime;
				yield* jobs.runOne();
				return yield* fixture.sql<{
					status: string;
					retryable: boolean;
					error_code: string | null;
				}>`SELECT d.status,d.retryable,d.safe_error_json->>'code' AS error_code FROM carneloot.notification_deliveries d JOIN carneloot.notification_events e ON e.id=d.event_id WHERE e.food_entry_id=${result.entry.id}::uuid`;
			});
			const deliveries = await Effect.runPromise(
				Effect.provide(program, liveLayer),
			);
			expect(sent).toEqual([]);
			expect(deliveries).toEqual([
				{
					status: 'failed',
					retryable: false,
					error_code: 'food-context-missing',
				},
			]);
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

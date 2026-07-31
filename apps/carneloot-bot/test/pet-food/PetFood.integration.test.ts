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
import { describe, expect, it } from 'vitest';

import * as AddFood from '../../src/application/AddFood.js';
import * as ConfigureDayStart from '../../src/application/ConfigureDayStart.js';
import * as ConfigureReminderDelay from '../../src/application/ConfigureReminderDelay.js';
import * as GetFoodStatus from '../../src/application/GetFoodStatus.js';
import { CurrentUser } from '../../src/bot/CurrentUser.js';
import {
	BotId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../../src/domain/Ids.js';
import { FoodAmount } from '../../src/domain/pet-food/FoodAmount.js';
import { PetName } from '../../src/domain/Pet.js';
import type { RegisteredUser } from '../../src/domain/User.js';
import { FoodNotificationScheduler } from '../../src/ports/FoodNotificationScheduler.js';
import { PetCaregiverRepository } from '../../src/ports/PetCaregiverRepository.js';
import { PetRepository } from '../../src/ports/PetRepository.js';
import {
	ReminderScheduler,
	ReminderSchedulerError,
	type ReminderSchedulerService,
} from '../../src/ports/ReminderScheduler.js';
import { UserRepository } from '../../src/ports/UserRepository.js';
import * as AppMigrator from '../../src/postgres/AppMigrator.js';
import * as PetCaregiverRepositoryLive from '../../src/postgres/PetCaregiverRepositoryLive.js';
import * as PetFoodRepositoryLive from '../../src/postgres/PetFoodRepositoryLive.js';
import * as PetRepositoryLive from '../../src/postgres/PetRepositoryLive.js';
import * as UserRepositoryLive from '../../src/postgres/UserRepositoryLive.js';
import * as DeterministicCrypto from '../internal/DeterministicCrypto.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';
import * as RecordingScheduler from './internal/RecordingReminderScheduler.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
type UserAccess = Pick<
	Parameters<typeof AddFood.execute>[0],
	'actorId' | 'botId' | 'telegramUserId'
>;
const currentUser = (access: UserAccess): RegisteredUser => ({
	user: {
		id: access.actorId,
		createdAt: DateTime.makeUnsafe(0),
		updatedAt: DateTime.makeUnsafe(0),
	},
	profile: {
		botId: access.botId,
		telegramUserId: access.telegramUserId,
		username: null,
		firstName: 'Ana',
		lastName: null,
		privateChatId: Schema.decodeUnknownSync(TelegramChatId)(
			access.telegramUserId,
		),
	},
});
const asCurrentUser = <A, E, R>(
	current: RegisteredUser,
	effect: Effect.Effect<A, E, R>,
) => Effect.provideService(effect, CurrentUser, current);
const asAccessUser = <A, E, R>(
	access: UserAccess,
	effect: Effect.Effect<A, E, R>,
) => asCurrentUser(currentUser(access), effect);
const executeAddFood = (
	access: Parameters<typeof AddFood.execute>[0],
	amount: string,
	when: string,
	source: AddFood.SourceInput,
	current = currentUser(access),
) =>
	asCurrentUser(
		current,
		AddFood.execute(
			access,
			{
				amountMg: Schema.decodeUnknownSync(FoodAmount)(amount),
				when,
				messageDate: DateTime.makeUnsafe('2024-01-02T12:00:00Z'),
			},
			source,
		),
	);
const captureLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
	const logs: Array<{
		readonly message: unknown;
		readonly annotations: Readonly<Record<string, unknown>>;
	}> = [];
	const logger = Logger.make((options) => {
		logs.push({
			message:
				Array.isArray(options.message) && options.message.length === 1
					? options.message[0]
					: options.message,
			annotations: options.fiber.getRef(References.CurrentLogAnnotations),
		});
	});
	return Effect.map(
		Effect.provideService(effect, Logger.CurrentLoggers, new Set([logger])),
		(result) => ({ result, logs }),
	);
};
const dependencies = (
	scheduler: Layer.Layer<ReminderScheduler, any, PgClient.PgClient>,
) =>
	Layer.provideMerge(
		Layer.mergeAll(
			UserRepositoryLive.layer,
			PetRepositoryLive.layer,
			PetFoodRepositoryLive.layer,
			PetCaregiverRepositoryLive.layer,
			scheduler,
			Layer.succeed(FoodNotificationScheduler, {
				scheduleAdded: () => Effect.void,
			}),
		),
		Layer.merge(PostgresTestLayer.layer, DeterministicCrypto.layer()),
	);
const setup = Effect.gen(function* () {
	yield* AppMigrator.migrate;
	const sql = yield* PgClient.PgClient;
	yield* sql`CREATE TABLE IF NOT EXISTS carneloot.test_reminder_actions (
		id bigserial PRIMARY KEY, kind text NOT NULL, pet_id uuid NOT NULL,
		food_entry_id uuid, run_at timestamptz
	)`;
	const suffix = crypto.randomUUID();
	const users = yield* UserRepository;
	const registered = yield* users.registerTelegramProfile({
		botId: Schema.decodeUnknownSync(BotId)(`bot-${suffix}`),
		telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(42),
		username: null,
		firstName: 'Ana',
		lastName: null,
		privateChatId: Schema.decodeUnknownSync(TelegramChatId)(42),
	});
	const pets = yield* PetRepository;
	const pet = yield* pets.addOwned(
		registered.user.id,
		Schema.decodeUnknownSync(PetName)(`Rex ${suffix}`),
	);
	const access = {
		actorId: registered.user.id,
		petId: pet.id,
		botId: registered.profile.botId,
		telegramUserId: registered.profile.telegramUserId,
	};
	return { sql, registered, pet, access };
});
const source = (botId: string, updateId: number) => ({ botId, updateId });
const ownerRecordingScheduler: Layer.Layer<
	ReminderScheduler,
	never,
	PgClient.PgClient
> = Layer.effect(
	ReminderScheduler,
	Effect.map(
		PgClient.PgClient,
		(sql) =>
			({
				replaceForLatest: (schedule) =>
					sql`INSERT INTO carneloot.test_reminder_actions (kind,pet_id,food_entry_id,run_at,owner_user_id) VALUES ('replace',${schedule.petId}::uuid,${schedule.foodEntryId}::uuid,${DateTime.toDateUtc(schedule.runAt)},${schedule.ownerUserId}::uuid)`.pipe(
						Effect.asVoid,
						Effect.mapError(
							(cause) =>
								new ReminderSchedulerError({
									reason: 'PersistenceFailure',
									message: 'Recording scheduler replace failed',
									cause,
								}),
						),
					),
				cancelForPet: (petId) =>
					sql`INSERT INTO carneloot.test_reminder_actions (kind,pet_id) VALUES ('cancel',${petId}::uuid)`.pipe(
						Effect.asVoid,
						Effect.mapError(
							(cause) =>
								new ReminderSchedulerError({
									reason: 'PersistenceFailure',
									message: 'Recording scheduler cancel failed',
									cause,
								}),
						),
					),
			}) satisfies ReminderSchedulerService,
	),
);

if (!enabled)
	describe.skip('pet food integration', () => {
		it('requires TEST_DATABASE_URL or RUN_TESTCONTAINERS=true', () => {});
	});
else
	describe('pet food integration', () => {
		it('handles settings, exact replay, duplicate boundary, latest scheduling, and status', async () => {
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(new Date('2024-01-02T12:00:00Z').getTime());
				const { sql, access, pet } = yield* setup;
				yield* asAccessUser(
					access,
					ConfigureDayStart.execute(access, '00:00', 'UTC'),
				);
				yield* asAccessUser(
					access,
					ConfigureReminderDelay.set(access, Duration.millis(60_000)),
				);
				const first = yield* executeAddFood(
					access,
					'50g',
					'10:00',
					source(access.botId, 1),
				);
				const replay = yield* executeAddFood(
					access,
					'1g',
					'10:00',
					source(access.botId, 1),
				);
				expect(replay.replayed).toBe(true);
				expect(replay.entry.id).toBe(first.entry.id);
				const duplicate = yield* Effect.result(
					executeAddFood(access, '1g', '10:00', source(access.botId, 2)),
				);
				expect(duplicate).toMatchObject({
					_tag: 'Failure',
					failure: { _tag: 'DuplicateFoodEntry' },
				});
				const exact = yield* executeAddFood(
					access,
					'10g',
					'10:01',
					source(access.botId, 3),
				);
				expect(exact.replayed).toBe(false);
				const backdated = yield* executeAddFood(
					access,
					'5g',
					'09:00',
					source(access.botId, 4),
				);
				expect(backdated.replayed).toBe(false);
				const actions = yield* sql<{
					kind: string;
				}>`SELECT kind FROM carneloot.test_reminder_actions WHERE pet_id=${pet.id}::uuid ORDER BY id`;
				expect(actions.map((row) => row.kind)).toEqual(['replace', 'replace']);
				const status = yield* asAccessUser(
					access,
					GetFoodStatus.execute({
						actorId: access.actorId,
						botId: access.botId,
						telegramUserId: access.telegramUserId,
					}),
				);
				expect(status[0]).toMatchObject({
					_tag: 'Configured',
					totalMg: 65_000,
				});
				return { access, pet };
			});
			const { result, logs } = await Effect.runPromise(
				captureLogs(
					Effect.provide(
						program,
						Layer.merge(
							dependencies(RecordingScheduler.layer),
							TestClock.layer(),
						),
					),
				),
			);
			const count = (message: string) =>
				logs.filter((log) => log.message === message).length;
			expect(count('carneloot.pet.day_start_configured')).toBe(1);
			expect(count('carneloot.pet.reminder_delay_configured')).toBe(1);
			expect(count('carneloot.food.recorded')).toBe(3);
			expect(count('carneloot.food.replayed')).toBe(1);
			expect(logs).toContainEqual({
				message: 'carneloot.pet.day_start_configured',
				annotations: {
					actorId: result.access.actorId,
					petId: result.pet.id,
					dayStart: '00:00',
					timeZone: 'UTC',
				},
			});
			expect(logs).toContainEqual({
				message: 'carneloot.pet.reminder_delay_configured',
				annotations: {
					actorId: result.access.actorId,
					petId: result.pet.id,
					delayMs: 60_000,
					reminderScheduled: false,
				},
			});
			expect(JSON.stringify(logs)).not.toContain(result.pet.name);
			expect(JSON.stringify(logs)).not.toContain('Ana');
		});

		it('authorizes caregiver food writes against current PostgreSQL identity and relationship state', async () => {
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(new Date('2024-01-02T12:00:00Z').getTime());
				const {
					sql,
					registered: owner,
					pet,
					access: ownerAccess,
				} = yield* setup;
				yield* sql`ALTER TABLE carneloot.test_reminder_actions ADD COLUMN IF NOT EXISTS owner_user_id uuid`;
				yield* asAccessUser(
					ownerAccess,
					ConfigureDayStart.execute(ownerAccess, '00:00', 'UTC'),
				);
				yield* asAccessUser(
					ownerAccess,
					ConfigureReminderDelay.set(ownerAccess, Duration.millis(60_000)),
				);
				const users = yield* UserRepository;
				const caregivers = yield* PetCaregiverRepository;
				const register = (telegramUserId: number, firstName: string) =>
					users.registerTelegramProfile({
						botId: owner.profile.botId,
						telegramUserId:
							Schema.decodeUnknownSync(TelegramUserId)(telegramUserId),
						username: null,
						firstName,
						lastName: null,
						privateChatId:
							Schema.decodeUnknownSync(TelegramChatId)(telegramUserId),
					});
				const accepted = yield* register(501, 'Accepted');
				const pending = yield* register(502, 'Pending');
				const rejected = yield* register(503, 'Rejected');
				const now = yield* DateTime.now;
				for (const caregiver of [accepted, pending, rejected])
					yield* caregivers.insertPending(pet.id, caregiver.user.id, now);
				yield* caregivers.setPendingResponse(
					pet.id,
					accepted.user.id,
					'accepted',
					now,
				);
				yield* caregivers.setPendingResponse(
					pet.id,
					rejected.user.id,
					'rejected',
					now,
				);
				const accessFor = (caregiver: typeof accepted) => ({
					actorId: caregiver.user.id,
					petId: pet.id,
					botId: caregiver.profile.botId,
					telegramUserId: caregiver.profile.telegramUserId,
				});

				const added = yield* executeAddFood(
					accessFor(accepted),
					'25g',
					'10:00',
					source(owner.profile.botId, 401),
				);
				const persisted = yield* sql<{
					recorded_by: string;
				}>`SELECT recorded_by FROM carneloot.pet_food_entries WHERE id=${added.entry.id}::uuid`;
				expect(persisted[0]?.recorded_by).toBe(accepted.user.id);
				const scheduled = yield* sql<{
					owner_user_id: string;
				}>`SELECT owner_user_id FROM carneloot.test_reminder_actions WHERE food_entry_id=${added.entry.id}::uuid`;
				expect(scheduled[0]?.owner_user_id).toBe(owner.user.id);

				for (const [caregiver, updateId] of [
					[pending, 402],
					[rejected, 403],
				] as const) {
					const denied = yield* Effect.result(
						executeAddFood(
							accessFor(caregiver),
							'1g',
							'11:00',
							source(owner.profile.botId, updateId),
						),
					);
					expect(denied).toMatchObject({
						_tag: 'Failure',
						failure: { _tag: 'PetAccessDenied' },
					});
				}

				const mismatch = yield* Effect.result(
					executeAddFood(
						{
							...accessFor(accepted),
							telegramUserId: pending.profile.telegramUserId,
						},
						'1g',
						'11:00',
						source(owner.profile.botId, 404),
						pending,
					),
				);
				expect(mismatch).toMatchObject({
					_tag: 'Failure',
					failure: { _tag: 'PetAccessDenied' },
				});

				const reassignedUserId = crypto.randomUUID();
				yield* sql`INSERT INTO carneloot.users (id,created_at,updated_at) VALUES (${reassignedUserId}::uuid,${new Date()},${new Date()})`;
				yield* sql`UPDATE carneloot.telegram_identities SET user_id=${reassignedUserId}::uuid WHERE bot_id=${accepted.profile.botId} AND telegram_user_id=${accepted.profile.telegramUserId}`;
				const reassigned = yield* Effect.result(
					executeAddFood(
						accessFor(accepted),
						'1g',
						'11:00',
						source(owner.profile.botId, 405),
						{
							...accepted,
							user: {
								...accepted.user,
								id: Schema.decodeUnknownSync(UserId)(reassignedUserId),
							},
						},
					),
				);
				expect(reassigned).toMatchObject({
					_tag: 'Failure',
					failure: { _tag: 'PetAccessDenied' },
				});

				// Access was selected earlier, but mutation must re-authorize current state.
				const previouslySelectedAccess = accessFor(accepted);
				yield* sql`UPDATE carneloot.telegram_identities SET user_id=${accepted.user.id}::uuid WHERE bot_id=${accepted.profile.botId} AND telegram_user_id=${accepted.profile.telegramUserId}`;
				yield* caregivers.remove(pet.id, accepted.user.id);
				const before = yield* sql<{
					count: string;
				}>`SELECT count(*)::text AS count FROM carneloot.pet_food_entries WHERE pet_id=${pet.id}::uuid`;
				const revoked = yield* Effect.result(
					executeAddFood(
						previouslySelectedAccess,
						'1g',
						'11:00',
						source(owner.profile.botId, 406),
					),
				);
				expect(revoked).toMatchObject({
					_tag: 'Failure',
					failure: { _tag: 'PetAccessDenied' },
				});
				const after = yield* sql<{
					count: string;
				}>`SELECT count(*)::text AS count FROM carneloot.pet_food_entries WHERE pet_id=${pet.id}::uuid`;
				expect(after[0]?.count).toBe(before[0]?.count);
				expect(
					yield* sql`SELECT id FROM carneloot.test_reminder_actions WHERE pet_id=${pet.id}::uuid`,
				).toHaveLength(1);
			});
			await Effect.runPromise(
				Effect.provide(
					program,
					Layer.merge(dependencies(ownerRecordingScheduler), TestClock.layer()),
				),
			);
		});

		it('rolls back scheduler actions, food, and settings when scheduler fails', async () => {
			const failure = new ReminderSchedulerError({
				reason: 'PersistenceFailure',
				message: 'scheduler failed',
			});
			const failing: Layer.Layer<ReminderScheduler, never, PgClient.PgClient> =
				Layer.effect(
					ReminderScheduler,
					Effect.map(
						PgClient.PgClient,
						(sql) =>
							({
								replaceForLatest: (schedule) =>
									sql`INSERT INTO carneloot.test_reminder_actions (kind,pet_id,food_entry_id,run_at) VALUES ('replace',${schedule.petId}::uuid,${schedule.foodEntryId}::uuid,${DateTime.toDateUtc(schedule.runAt)})`.pipe(
										Effect.mapError(
											(cause) =>
												new ReminderSchedulerError({
													reason: 'PersistenceFailure',
													message: 'scheduler write failed',
													cause,
												}),
										),
										Effect.andThen(Effect.fail(failure)),
									),
								cancelForPet: (petId) =>
									sql`INSERT INTO carneloot.test_reminder_actions (kind,pet_id) VALUES ('cancel',${petId}::uuid)`.pipe(
										Effect.mapError(
											(cause) =>
												new ReminderSchedulerError({
													reason: 'PersistenceFailure',
													message: 'scheduler write failed',
													cause,
												}),
										),
										Effect.andThen(Effect.fail(failure)),
									),
							}) satisfies ReminderSchedulerService,
					),
				);
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(new Date('2024-01-02T12:00:00Z').getTime());
				const { sql, access, pet } = yield* setup;
				yield* asAccessUser(
					access,
					ConfigureDayStart.execute(access, '23:00', 'UTC'),
				);
				yield* asAccessUser(
					access,
					ConfigureReminderDelay.set(access, Duration.millis(60_000)),
				);
				yield* sql`INSERT INTO carneloot.pet_food_entries (id,pet_id,recorded_by,amount_mg,fed_at,source_bot_id,source_update_id,created_at,updated_at) VALUES (${crypto.randomUUID()}::uuid,${pet.id}::uuid,${access.actorId}::uuid,1000,${new Date('2024-01-02T09:00:00Z')},${access.botId},9,${new Date('2024-01-02T09:00:00Z')},${new Date('2024-01-02T09:00:00Z')})`;
				const setDelay = yield* Effect.result(
					asAccessUser(
						access,
						ConfigureReminderDelay.set(access, Duration.millis(120_000)),
					),
				);
				expect(setDelay).toMatchObject({
					_tag: 'Failure',
					failure: { _tag: 'ReminderSchedulerError' },
				});
				expect(
					yield* sql`SELECT id FROM carneloot.test_reminder_actions WHERE pet_id=${pet.id}::uuid`,
				).toHaveLength(0);
				const result = yield* Effect.result(
					executeAddFood(access, '50g', '10:00', source(access.botId, 10)),
				);
				expect(result._tag).toBe('Failure');
				const rows =
					yield* sql`SELECT id FROM carneloot.pet_food_entries WHERE pet_id=${pet.id}::uuid`;
				expect(rows).toHaveLength(1);
				expect(
					yield* sql`SELECT id FROM carneloot.test_reminder_actions WHERE pet_id=${pet.id}::uuid`,
				).toHaveLength(0);
				const remove = yield* Effect.result(
					asAccessUser(access, ConfigureReminderDelay.remove(access)),
				);
				expect(remove._tag).toBe('Failure');
				const settings = yield* sql<{
					reminder_delay_ms: string | null;
				}>`SELECT reminder_delay_ms FROM carneloot.pet_food_settings WHERE pet_id=${pet.id}::uuid`;
				expect(Number(settings[0]?.reminder_delay_ms)).toBe(60_000);
				expect(
					yield* sql`SELECT id FROM carneloot.test_reminder_actions WHERE pet_id=${pet.id}::uuid`,
				).toHaveLength(0);
			});
			const { logs } = await Effect.runPromise(
				captureLogs(
					Effect.provide(
						program,
						Layer.merge(dependencies(failing), TestClock.layer()),
					),
				),
			);
			const count = (message: string) =>
				logs.filter((log) => log.message === message).length;
			expect(count('carneloot.pet.reminder_delay_configured')).toBe(1);
			expect(count('carneloot.food.recorded')).toBe(0);
			expect(count('carneloot.pet.reminder_delay_removed')).toBe(0);
		});

		it('rejects cross-owner settings and returns configured/missing status projections', async () => {
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(new Date('2024-01-02T12:00:00Z').getTime());
				const first = yield* setup;
				const second = yield* setup;
				const deniedAccess = { ...second.access, petId: first.pet.id };
				const denied = yield* Effect.result(
					asAccessUser(
						deniedAccess,
						ConfigureDayStart.execute(deniedAccess, '23:00', 'UTC'),
					),
				);
				expect(denied).toMatchObject({
					_tag: 'Failure',
					failure: { _tag: 'PetAccessDenied' },
				});
				const missing = yield* asAccessUser(
					first.access,
					GetFoodStatus.execute({
						actorId: first.access.actorId,
						botId: first.access.botId,
						telegramUserId: first.access.telegramUserId,
					}),
				);
				expect(missing).toMatchObject([{ _tag: 'MissingDayStart' }]);
				yield* asAccessUser(
					second.access,
					ConfigureDayStart.execute(second.access, '00:00', 'UTC'),
				);
				const zero = yield* asAccessUser(
					second.access,
					GetFoodStatus.execute({
						actorId: second.access.actorId,
						botId: second.access.botId,
						telegramUserId: second.access.telegramUserId,
					}),
				);
				expect(zero).toMatchObject([
					{ _tag: 'Configured', totalMg: 0, latestFedAt: null },
				]);
				yield* asAccessUser(
					first.access,
					ConfigureDayStart.execute(first.access, '23:00', 'UTC'),
				);
				const windowStart = new Date('2024-01-01T23:00:00Z').getTime();
				const windowEnd = new Date('2024-01-02T23:00:00Z').getTime();
				for (const [fedAt, amount, update] of [
					[windowStart - 1, 1_000, 101],
					[windowStart, 2_000, 102],
					[windowEnd - 1, 3_000, 103],
					[windowEnd, 4_000, 104],
				] as const)
					yield* first.sql`INSERT INTO carneloot.pet_food_entries (id,pet_id,recorded_by,amount_mg,fed_at,source_bot_id,source_update_id,created_at,updated_at) VALUES (${crypto.randomUUID()}::uuid,${first.pet.id}::uuid,${first.access.actorId}::uuid,${amount},${new Date(fedAt)},${first.access.botId},${update},${new Date(fedAt)},${new Date(fedAt)})`;
				const status = yield* asAccessUser(
					first.access,
					GetFoodStatus.execute({
						actorId: first.access.actorId,
						botId: first.access.botId,
						telegramUserId: first.access.telegramUserId,
					}),
				);
				expect(status[0]).toMatchObject({
					_tag: 'Configured',
					totalMg: 5_000,
					latestFedAt: DateTime.makeUnsafe(windowEnd - 1),
					window: {
						start: DateTime.makeUnsafe(windowStart),
						end: DateTime.makeUnsafe(windowEnd),
					},
				});
			});
			await Effect.runPromise(
				Effect.provide(
					program,
					Layer.merge(
						dependencies(RecordingScheduler.layer),
						TestClock.layer(),
					),
				),
			);
		});

		it('serializes concurrent source replay and business duplicate claims', async () => {
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(new Date('2024-01-02T12:00:00Z').getTime());
				const { sql, access, pet } = yield* setup;
				yield* asAccessUser(
					access,
					ConfigureDayStart.execute(access, '00:00', 'UTC'),
				);
				// No delay: a successful insertion emits no scheduler action.
				const noDelay = yield* executeAddFood(
					access,
					'1g',
					'08:00',
					source(access.botId, 200),
				);
				expect(noDelay.replayed).toBe(false);
				expect(
					yield* sql`SELECT id FROM carneloot.test_reminder_actions WHERE pet_id=${pet.id}::uuid`,
				).toHaveLength(0);
				yield* asAccessUser(
					access,
					ConfigureReminderDelay.set(access, Duration.millis(120_000)),
				);
				const sourceGate = yield* Deferred.make<void>();
				const sourceFiber = yield* Effect.forkChild(
					Effect.all(
						[1, 2].map(() =>
							Effect.andThen(
								Deferred.await(sourceGate),
								executeAddFood(
									access,
									'2g',
									'10:00',
									source(access.botId, 201),
								),
							),
						),
						{ concurrency: 'unbounded' },
					),
				);
				yield* Deferred.succeed(sourceGate, undefined);
				const sameSource = yield* Fiber.join(sourceFiber);
				expect(sameSource.filter((result) => result.replayed)).toHaveLength(1);
				expect(new Set(sameSource.map((result) => result.entry.id)).size).toBe(
					1,
				);
				const businessGate = yield* Deferred.make<void>();
				const businessFiber = yield* Effect.forkChild(
					Effect.all(
						[202, 203].map((updateId) =>
							Effect.andThen(
								Deferred.await(businessGate),
								Effect.result(
									executeAddFood(
										access,
										'3g',
										'11:00',
										source(access.botId, updateId),
									),
								),
							),
						),
						{ concurrency: 'unbounded' },
					),
				);
				yield* Deferred.succeed(businessGate, undefined);
				const business = yield* Fiber.join(businessFiber);
				expect(
					business.filter((result) => result._tag === 'Success'),
				).toHaveLength(1);
				expect(
					business.filter((result) => result._tag === 'Failure'),
				).toMatchObject([{ failure: { _tag: 'DuplicateFoodEntry' } }]);
				const actions = yield* sql<{
					food_entry_id: string;
					run_at: Date;
				}>`SELECT food_entry_id,run_at FROM carneloot.test_reminder_actions WHERE pet_id=${pet.id}::uuid ORDER BY id`;
				// Delay setting reschedules 08:00, then one action per winning 10:00/11:00 insertion.
				expect(actions).toHaveLength(3);
				expect(actions[1]?.food_entry_id).toBe(sameSource[0]?.entry.id);
				expect(new Date(actions[1]!.run_at).getTime()).toBe(
					new Date('2024-01-02T10:02:00Z').getTime(),
				);
			});
			await Effect.runPromise(
				Effect.provide(
					program,
					Layer.merge(
						dependencies(RecordingScheduler.layer),
						TestClock.layer(),
					),
				),
			);
		});

		it('uses a strict one-minute business duplicate boundary', async () => {
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(new Date('2024-01-02T12:00:00Z').getTime());
				const { sql, access, pet } = yield* setup;
				yield* asAccessUser(
					access,
					ConfigureDayStart.execute(access, '00:00', 'UTC'),
				);
				const seed = (fedAt: number, updateId: number) =>
					sql`INSERT INTO carneloot.pet_food_entries (id,pet_id,recorded_by,amount_mg,fed_at,source_bot_id,source_update_id,created_at,updated_at) VALUES (${crypto.randomUUID()}::uuid,${pet.id}::uuid,${access.actorId}::uuid,1000,${new Date(fedAt)},${access.botId},${updateId},${new Date(fedAt)},${new Date(fedAt)})`;
				yield* seed(new Date('2024-01-02T10:00:00.001Z').getTime(), 300);
				const below = yield* Effect.result(
					executeAddFood(access, '1g', '10:01', source(access.botId, 301)),
				);
				expect(below).toMatchObject({
					_tag: 'Failure',
					failure: { _tag: 'DuplicateFoodEntry' },
				});
				const exactFixture = yield* setup;
				yield* asAccessUser(
					exactFixture.access,
					ConfigureDayStart.execute(exactFixture.access, '00:00', 'UTC'),
				);
				yield* exactFixture.sql`INSERT INTO carneloot.pet_food_entries (id,pet_id,recorded_by,amount_mg,fed_at,source_bot_id,source_update_id,created_at,updated_at) VALUES (${crypto.randomUUID()}::uuid,${exactFixture.pet.id}::uuid,${exactFixture.access.actorId}::uuid,1000,${new Date('2024-01-02T10:00:00Z')},${exactFixture.access.botId},302,${new Date('2024-01-02T10:00:00Z')},${new Date('2024-01-02T10:00:00Z')})`;
				const exact = yield* executeAddFood(
					exactFixture.access,
					'1g',
					'10:01',
					source(exactFixture.access.botId, 303),
				);
				expect(exact.replayed).toBe(false);
			});
			await Effect.runPromise(
				Effect.provide(
					program,
					Layer.merge(
						dependencies(RecordingScheduler.layer),
						TestClock.layer(),
					),
				),
			);
		});
	});

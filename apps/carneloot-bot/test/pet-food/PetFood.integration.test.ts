import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Layer, Schema } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { describe, expect, it } from 'vitest';

import * as AddFood from '../../src/application/AddFood.js';
import * as ConfigureDayStart from '../../src/application/ConfigureDayStart.js';
import * as ConfigureReminderDelay from '../../src/application/ConfigureReminderDelay.js';
import * as GetFoodStatus from '../../src/application/GetFoodStatus.js';
import { BotId, TelegramChatId, TelegramUserId } from '../../src/domain/Ids.js';
import { PetName } from '../../src/domain/Pet.js';
import { PetRepository } from '../../src/ports/PetRepository.js';
import {
	ReminderScheduler,
	type ReminderSchedulerService,
} from '../../src/ports/ReminderScheduler.js';
import { UserRepository } from '../../src/ports/UserRepository.js';
import * as AppMigrator from '../../src/postgres/AppMigrator.js';
import * as PetFoodRepositoryLive from '../../src/postgres/PetFoodRepositoryLive.js';
import * as PetRepositoryLive from '../../src/postgres/PetRepositoryLive.js';
import * as UserRepositoryLive from '../../src/postgres/UserRepositoryLive.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';
import * as RecordingScheduler from './internal/RecordingReminderScheduler.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const dependencies = (
	scheduler: Layer.Layer<ReminderScheduler, any, PgClient.PgClient>,
) =>
	Layer.provideMerge(
		Layer.mergeAll(
			UserRepositoryLive.layer,
			PetRepositoryLive.layer,
			PetFoodRepositoryLive.layer,
			scheduler,
		),
		PostgresTestLayer.layer,
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
		ownerId: registered.user.id,
		petId: pet.id,
		botId: registered.profile.botId,
		telegramUserId: registered.profile.telegramUserId,
	};
	return { sql, registered, pet, access };
});
const source = (botId: string, updateId: number) => ({ botId, updateId });

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
				yield* ConfigureDayStart.execute(access, '00:00', 'UTC');
				yield* ConfigureReminderDelay.set(access, 60_000);
				const first = yield* AddFood.execute(
					access,
					'50g',
					'10:00',
					source(access.botId, 1),
				);
				const replay = yield* AddFood.execute(
					access,
					'0g',
					'10:00',
					source(access.botId, 1),
				);
				expect(replay.replayed).toBe(true);
				expect(replay.entry.id).toBe(first.entry.id);
				const duplicate = yield* Effect.result(
					AddFood.execute(access, '1g', '10:00', source(access.botId, 2)),
				);
				expect(duplicate).toMatchObject({
					_tag: 'Failure',
					failure: { _tag: 'DuplicateFoodEntry' },
				});
				const exact = yield* AddFood.execute(
					access,
					'10g',
					'10:01',
					source(access.botId, 3),
				);
				expect(exact.replayed).toBe(false);
				const backdated = yield* AddFood.execute(
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
				const status = yield* GetFoodStatus.execute({
					ownerId: access.ownerId,
					botId: access.botId,
					telegramUserId: access.telegramUserId,
				});
				expect(status[0]).toMatchObject({
					_tag: 'Configured',
					totalMg: 65_000,
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

		it('rolls back food and settings when scheduler fails', async () => {
			const failing = Layer.succeed(ReminderScheduler, {
				replaceForLatest: () => Effect.fail('scheduler failed'),
				cancelForPet: () => Effect.fail('scheduler failed'),
			} satisfies ReminderSchedulerService);
			const program = Effect.gen(function* () {
				yield* TestClock.setTime(new Date('2024-01-02T12:00:00Z').getTime());
				const { sql, access, pet } = yield* setup;
				yield* ConfigureDayStart.execute(access, '23:00', 'UTC');
				yield* ConfigureReminderDelay.set(access, 60_000);
				const result = yield* Effect.result(
					AddFood.execute(access, '50g', '10:00', source(access.botId, 10)),
				);
				expect(result._tag).toBe('Failure');
				const rows =
					yield* sql`SELECT id FROM carneloot.pet_food_entries WHERE pet_id=${pet.id}::uuid`;
				expect(rows).toHaveLength(0);
				const remove = yield* Effect.result(
					ConfigureReminderDelay.remove(access),
				);
				expect(remove._tag).toBe('Failure');
				const settings = yield* sql<{
					reminder_delay_ms: string | null;
				}>`SELECT reminder_delay_ms FROM carneloot.pet_food_settings WHERE pet_id=${pet.id}::uuid`;
				expect(Number(settings[0]?.reminder_delay_ms)).toBe(60_000);
			});
			await Effect.runPromise(
				Effect.provide(
					program,
					Layer.merge(dependencies(failing), TestClock.layer()),
				),
			);
		});
	});

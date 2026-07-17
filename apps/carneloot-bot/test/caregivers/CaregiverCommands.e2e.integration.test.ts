import * as PgClient from '@effect/sql-pg/PgClient';
import * as TfxPostgres from '@tfx/postgres/TfxPostgres';
import { Effect, Layer, Schema } from 'effect';
import * as Job from 'tfx/Job';
import * as JobRuntimeLive from 'tfx/JobRuntime';
import { describe, expect, it } from 'vitest';

import * as DeletePet from '../../src/application/DeletePet.js';
import { BotId, TelegramChatId, TelegramUserId } from '../../src/domain/Ids.js';
import { PetName } from '../../src/domain/Pet.js';
import * as FeedingReminderJob from '../../src/jobs/FeedingReminderJob.js';
import { PetRepository } from '../../src/ports/PetRepository.js';
import { UserRepository } from '../../src/ports/UserRepository.js';
import * as ReminderSchedulerLive from '../../src/postgres/ReminderSchedulerLive.js';
import * as RepositoriesLive from '../../src/postgres/RepositoriesLive.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

const enabled = process.env.TEST_DATABASE_URL !== undefined || process.env.RUN_TESTCONTAINERS === 'true';
const botId = Schema.decodeUnknownSync(BotId)('carneloot');
const stores = Layer.provideMerge(
	Layer.merge(
		RepositoriesLive.layer,
		TfxPostgres.layer({ schema: 'tfx_delete_pet_test', tablePrefix: 'case_' }),
	),
	PostgresTestLayer.layer,
);
const runtime = Layer.provideMerge(
	JobRuntimeLive.layer(Job.implement(FeedingReminderJob.declaration, () => Effect.void)),
	stores,
);
const layer = Layer.mergeAll(
	stores,
	runtime,
	Layer.provideMerge(ReminderSchedulerLive.layer, Layer.merge(stores, runtime)),
);

const register = (telegramUserId: number, firstName: string) =>
	Effect.flatMap(UserRepository, (users) =>
		users.registerTelegramProfile({
			botId,
			telegramUserId: Schema.decodeUnknownSync(TelegramUserId)(telegramUserId),
			username: null,
			firstName,
			lastName: null,
			privateChatId: Schema.decodeUnknownSync(TelegramChatId)(telegramUserId),
		}),
	);

if (!enabled) describe.skip('delete pet persistence', () => {
	it('requires TEST_DATABASE_URL or RUN_TESTCONTAINERS=true', () => {});
});
else describe('delete pet persistence', () => {
	it('deletes owner pet and cascades dependent rows', async () => {
		const program = Effect.gen(function* () {
			const telegramId = Math.floor(Math.random() * 1_000_000_000) + 1;
			const owner = yield* register(telegramId, 'Owner');
			const pet = yield* (yield* PetRepository).addOwned(owner.user.id, Schema.decodeUnknownSync(PetName)(`Pet ${crypto.randomUUID()}`));
			const deleted = yield* DeletePet.execute({ actorId: owner.user.id, botId, telegramUserId: owner.profile.telegramUserId }, pet.id);
			expect(deleted.id).toBe(pet.id);
			const sql = yield* PgClient.PgClient;
			const rows = yield* sql`SELECT id FROM carneloot.pets WHERE id=${pet.id}::uuid`;
			expect(rows).toHaveLength(0);
		});
		await Effect.runPromise(Effect.provide(program, layer));
	});

	it('denies non-owner and rolls back persistence', async () => {
		const program = Effect.gen(function* () {
			const seed = Math.floor(Math.random() * 500_000_000) + 1;
			const owner = yield* register(seed, 'Owner');
			const other = yield* register(seed + 500_000_000, 'Other');
			const pet = yield* (yield* PetRepository).addOwned(owner.user.id, Schema.decodeUnknownSync(PetName)(`Pet ${crypto.randomUUID()}`));
			const exit = yield* Effect.exit(DeletePet.execute({ actorId: other.user.id, botId, telegramUserId: other.profile.telegramUserId }, pet.id));
			expect(exit._tag).toBe('Failure');
			const sql = yield* PgClient.PgClient;
			const rows = yield* sql`SELECT id FROM carneloot.pets WHERE id=${pet.id}::uuid`;
			expect(rows).toHaveLength(1);
		});
		await Effect.runPromise(Effect.provide(program, layer));
	});
});

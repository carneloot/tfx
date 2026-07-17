import * as PgClient from '@effect/sql-pg/PgClient';
import { Deferred, Effect, Fiber, Layer, Schema } from 'effect';
import * as DateTime from 'effect/DateTime';
import { describe, expect, it } from 'vitest';

import {
	BotId,
	PetId,
	TelegramChatId,
	TelegramUserId,
} from '../../src/domain/Ids.js';
import { FoodAmount } from '../../src/domain/pet-food/FoodAmount.js';
import { FoodEntryId } from '../../src/domain/pet-food/PetFood.js';
import { PetName } from '../../src/domain/Pet.js';
import { PetFoodRepository } from '../../src/ports/PetFoodRepository.js';
import { PetRepository } from '../../src/ports/PetRepository.js';
import { UserRepository } from '../../src/ports/UserRepository.js';
import * as AppMigrator from '../../src/postgres/AppMigrator.js';
import * as PetFoodRepositoryLive from '../../src/postgres/PetFoodRepositoryLive.js';
import * as PetRepositoryLive from '../../src/postgres/PetRepositoryLive.js';
import * as UserRepositoryLive from '../../src/postgres/UserRepositoryLive.js';
import * as PostgresTestLayer from '../internal/PostgresTestLayer.js';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
const layer = Layer.provideMerge(
	Layer.mergeAll(
		UserRepositoryLive.layer,
		PetRepositoryLive.layer,
		PetFoodRepositoryLive.layer,
	),
	PostgresTestLayer.layer,
);
const utc = (value: string) => DateTime.makeUnsafe(value);
const amount = (value: string) => Schema.decodeUnknownSync(FoodAmount)(value);

const fixture = Effect.gen(function* () {
	yield* AppMigrator.migrate;
	const suffix = crypto.randomUUID();
	const users = yield* UserRepository;
	const registered = yield* users.registerTelegramProfile({
		botId: Schema.decodeUnknownSync(BotId)(`food-mutations-${suffix}`),
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
	return { registered, pet };
});

if (!enabled)
	describe.skip('food mutation repository integration', () => {
		it('requires TEST_DATABASE_URL or RUN_TESTCONTAINERS=true', () => {});
	});
else
	describe('food mutation repository integration', () => {
		it('lists a half-open range, locks by pet, excludes duplicates, and preserves provenance', async () => {
			const program = Effect.gen(function* () {
				const { registered, pet } = yield* fixture;
				const repository = yield* PetFoodRepository;
				const makeEntry = (id: string, fedAt: string, updateId: number) =>
					repository.insert({
						id: Schema.decodeUnknownSync(FoodEntryId)(id),
						petId: pet.id,
						recordedBy: registered.user.id,
						amountMg: amount('50g'),
						fedAt: utc(fedAt),
						source: {
							botId: registered.profile.botId,
							updateId,
							messageChatId: registered.profile.privateChatId,
							messageId: updateId,
						},
						now: utc('2024-01-02T09:00:00Z'),
					});
				const atStart = yield* makeEntry(
					crypto.randomUUID(),
					'2024-01-02T00:00:00Z',
					4,
				);
				const first = yield* makeEntry(
					crypto.randomUUID(),
					'2024-01-02T10:00:00Z',
					1,
				);
				const second = yield* makeEntry(
					crypto.randomUUID(),
					'2024-01-02T10:00:00Z',
					2,
				);
				yield* makeEntry(crypto.randomUUID(), '2024-01-03T00:00:00Z', 3);

				const listed = yield* repository.listEntries(
					pet.id,
					utc('2024-01-02T00:00:00Z'),
					utc('2024-01-03T00:00:00Z'),
				);
				expect(listed.map((entry) => entry.id)).toEqual([
					...[first.id, second.id].sort().reverse(),
					atStart.id,
				]);
				expect(
					yield* repository.lockEntry(
						Schema.decodeUnknownSync(PetId)(crypto.randomUUID()),
						first.id,
					),
				).toBeUndefined();
				expect((yield* repository.lockEntry(pet.id, first.id))?.id).toBe(
					first.id,
				);
				expect(
					yield* repository.findBusinessDuplicateExcluding(
						pet.id,
						first.fedAt,
						first.id,
					),
				).toMatchObject({ id: second.id });
				expect(
					yield* repository.findBusinessDuplicateExcluding(
						pet.id,
						utc('2024-01-02T12:00:00Z'),
						first.id,
					),
				).toBeUndefined();

				const updated = yield* repository.updateEntry(
					first.id,
					amount('75g'),
					utc('2024-01-02T11:00:00Z'),
					utc('2024-01-02T12:00:00Z'),
				);
				expect(updated).toMatchObject({
					recordedBy: first.recordedBy,
					sourceBotId: first.sourceBotId,
					sourceUpdateId: first.sourceUpdateId,
					sourceMessageChatId: first.sourceMessageChatId,
					sourceMessageId: first.sourceMessageId,
					createdAt: first.createdAt,
				});
				const deleted = yield* repository.deleteEntry(first.id);
				expect(deleted).toEqual(updated);
				expect(yield* repository.deleteEntry(first.id)).toBeUndefined();
			});
			await Effect.runPromise(Effect.provide(program, layer));
		});

		it('serializes update and delete after a row lock', async () => {
			const program = Effect.gen(function* () {
				const { registered, pet } = yield* fixture;
				const repository = yield* PetFoodRepository;
				const sql = yield* PgClient.PgClient;
				const entry = yield* repository.insert({
					id: Schema.decodeUnknownSync(FoodEntryId)(crypto.randomUUID()),
					petId: pet.id,
					recordedBy: registered.user.id,
					amountMg: amount('50g'),
					fedAt: utc('2024-01-02T10:00:00Z'),
					source: {
						botId: registered.profile.botId,
						updateId: 50,
						messageChatId: null,
						messageId: null,
					},
					now: utc('2024-01-02T10:00:00Z'),
				});
				const locked = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const holder = yield* Effect.forkChild(
					sql.withTransaction(
						Effect.gen(function* () {
							yield* repository.lockEntry(pet.id, entry.id);
							yield* Deferred.succeed(locked, undefined);
							yield* Deferred.await(release);
							yield* repository.updateEntry(
								entry.id,
								amount('80g'),
								utc('2024-01-02T11:00:00Z'),
								utc('2024-01-02T12:00:00Z'),
							);
						}),
					),
				);
				yield* Deferred.await(locked);
				const deletion = yield* Effect.forkChild(
					repository.deleteEntry(entry.id),
				);
				yield* Effect.yieldNow;
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(holder);
				const deleted = yield* Fiber.join(deletion);
				expect(deleted).toMatchObject({
					id: entry.id,
					amountMg: amount('80g'),
					fedAt: utc('2024-01-02T11:00:00Z'),
				});
			});
			await Effect.runPromise(Effect.provide(program, layer));
		});
	});
